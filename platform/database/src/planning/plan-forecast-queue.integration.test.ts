import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import type { PlanForecastRequest } from "@openrhen/contracts";
import {
  PLAN_FORECAST_JOB_TYPE,
  claimPlanForecastJob,
  enqueuePlanForecastJob,
  reclaimExpiredPlanForecastJobs,
  recoverAbandonedPlanForecastJobs
} from "./plan-forecast-runtime.js";
import { integrationDatabaseName } from "../operations/integration-database.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
// A database of its own for the same reason the retention suite has one: these suites truncate.
const testDatabaseName = integrationDatabaseName(process.env.PLAN_QUEUE_TEST_DATABASE_NAME, "openrhen_plan_queue");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("PLAN_QUEUE_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

/**
 * A stand-in for the engine request. `enqueuePlanForecastJob` reads only the input version, which is
 * what its idempotency key is built from, and the calculation time it defaults the snapshot stamp
 * to; the queue bookkeeping under test never looks inside the state. Building a schema-valid portal
 * state here would test the request builder instead.
 */
const request = (inputVersion: string): PlanForecastRequest =>
  ({
    contractVersion: "1",
    requestId: crypto.randomUUID(),
    inputVersion,
    calculatedAt: new Date().toISOString(),
    horizonEnd: new Date(Date.now() + 86_400_000).toISOString(),
    state: {},
    deliverables: []
  }) as unknown as PlanForecastRequest;

const statusOf = async (id: string) =>
  (await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id=${id}`)[0]?.status ?? null;

const waitingBoundaryJobs = async (owner = userId) =>
  (
    await sql<{ id: string }[]>`
      SELECT id FROM jobs
      WHERE type=${PLAN_FORECAST_JOB_TYPE} AND payload->>'userId'=${owner}
        AND payload->>'cause'='validity_boundary' AND status IN ('pending','retrying')
    `
  ).map((row) => row.id);

beforeAll(async () => {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<
      { exists: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
    if (!existing[0]?.exists) await admin.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
  } finally {
    await admin.end();
  }
  const migrationSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  // This suite is allowed to clear only a database whose validated name ends in _test.
  await sql.unsafe("TRUNCATE TABLE users, jobs RESTART IDENTITY CASCADE");
  const users = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Queue Fixture') RETURNING id`;
  userId = users[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

describe("plan-and-forecast queue", () => {
  it("leaves at most one waiting validity-boundary job per user", async () => {
    const first = await enqueuePlanForecastJob(
      sql,
      userId,
      request("v1"),
      "validity_boundary",
      new Date(Date.now() + 3_600_000)
    );
    const second = await enqueuePlanForecastJob(
      sql,
      userId,
      request("v2"),
      "validity_boundary",
      new Date(Date.now() + 3_600_000)
    );
    const third = await enqueuePlanForecastJob(
      sql,
      userId,
      request("v3"),
      "validity_boundary",
      new Date(Date.now() + 3_600_000)
    );

    // Each completed run chains a boundary job for the same instant under a different input version,
    // so without this the queue accumulated one per run and fired all of them at that minute.
    expect(await waitingBoundaryJobs()).toEqual([third]);
    expect(await statusOf(first)).toBe("superseded");
    expect(await statusOf(second)).toBe("superseded");
  });

  it("supersedes a waiting boundary job when a state change is queued", async () => {
    const boundary = await enqueuePlanForecastJob(
      sql,
      userId,
      request("v1"),
      "validity_boundary",
      new Date(Date.now() + 3_600_000)
    );
    const change = await enqueuePlanForecastJob(sql, userId, request("v2"), "planning_state_changed");

    // The write has already invalidated the snapshot the boundary job was chained from; running it
    // would only reach the "reject obsolete snapshot" check after paying for a full engine call.
    expect(await statusOf(boundary)).toBe("superseded");
    expect(await statusOf(change)).toBe("pending");
    expect(await waitingBoundaryJobs()).toEqual([]);
  });

  it("does not cancel a boundary job a worker is already running", async () => {
    const running = await enqueuePlanForecastJob(
      sql,
      userId,
      request("v1"),
      "validity_boundary",
      new Date(Date.now() + 3_600_000)
    );
    await sql`UPDATE jobs SET status='running',locked_at=CURRENT_TIMESTAMP,locked_by='worker' WHERE id=${running}`;
    await enqueuePlanForecastJob(sql, userId, request("v2"), "planning_state_changed");

    // A claimed job owns its own outcome. Superseding it from outside would race the worker to the
    // row and could discard a result that was already persisted.
    expect(await statusOf(running)).toBe("running");
  });

  it("never cancels the job just enqueued, even when its key already existed", async () => {
    const first = await enqueuePlanForecastJob(
      sql,
      userId,
      request("v1"),
      "validity_boundary",
      new Date(Date.now() + 3_600_000)
    );
    const again = await enqueuePlanForecastJob(
      sql,
      userId,
      request("v1"),
      "validity_boundary",
      new Date(Date.now() + 1_800_000)
    );

    expect(again).toBe(first);
    expect(await statusOf(first)).toBe("pending");
  });

  it("leaves another user's waiting boundary job alone", async () => {
    const others = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`;
    const otherUserId = others[0]!.id;
    const theirs = await enqueuePlanForecastJob(
      sql,
      otherUserId,
      request("v1"),
      "validity_boundary",
      new Date(Date.now() + 3_600_000)
    );
    await enqueuePlanForecastJob(sql, userId, request("v2"), "validity_boundary", new Date(Date.now() + 3_600_000));

    expect(await statusOf(theirs)).toBe("pending");
    expect(await waitingBoundaryJobs(otherUserId)).toEqual([theirs]);
  });

  // Finding: N sequential writes (the CLI, an import, a bulk edit) each enqueued their own
  // 'planning_state_changed' job, and nothing ever superseded the older ones — only the
  // 'validity_boundary' cause got that courtesy. That left N-1 stale jobs pending, each costing a
  // full engine call the moment a worker reached it, before being discarded as obsolete. Superseding
  // here is a courtesy that keeps the queue from accumulating dead rows between writes; the worker's
  // own claim-time check (`processPlanForecastJob`) is what actually guarantees no engine call is
  // wasted, for the race this synchronous step cannot close on its own.
  it("supersedes an older pending job of any cause when a new one is enqueued, and the newest always survives", async () => {
    const first = await enqueuePlanForecastJob(sql, userId, request("v1"), "planning_state_changed");
    const second = await enqueuePlanForecastJob(sql, userId, request("v2"), "planning_state_changed");
    const third = await enqueuePlanForecastJob(sql, userId, request("v3"), "planning_state_changed");

    expect(await statusOf(first)).toBe("superseded");
    expect(await statusOf(second)).toBe("superseded");
    expect(await statusOf(third)).toBe("pending");
  });

  it("supersedes a waiting boundary job when a differently-caused job follows it, and vice versa", async () => {
    const boundary = await enqueuePlanForecastJob(
      sql,
      userId,
      request("v1"),
      "validity_boundary",
      new Date(Date.now() + 3_600_000)
    );
    const change = await enqueuePlanForecastJob(sql, userId, request("v2"), "planning_state_changed");
    const anotherBoundary = await enqueuePlanForecastJob(
      sql,
      userId,
      request("v3"),
      "validity_boundary",
      new Date(Date.now() + 3_600_000)
    );

    expect(await statusOf(boundary)).toBe("superseded");
    expect(await statusOf(change)).toBe("superseded");
    expect(await statusOf(anotherBoundary)).toBe("pending");
  });

  it("does not cancel a planning_state_changed job a worker is already running", async () => {
    const running = await enqueuePlanForecastJob(sql, userId, request("v1"), "planning_state_changed");
    await sql`UPDATE jobs SET status='running',locked_at=CURRENT_TIMESTAMP,locked_by='worker' WHERE id=${running}`;
    await enqueuePlanForecastJob(sql, userId, request("v2"), "planning_state_changed");

    // A claimed job owns its own outcome. Superseding it from outside would race the worker to the
    // row and could discard a result that was already persisted.
    expect(await statusOf(running)).toBe("running");
  });
});

describe("plan-and-forecast job lease", () => {
  // The stand-in request is not schema-valid, so claims are taken the way `claimPlanForecastJob` takes
  // them rather than through it; the null-claim checks never reach its payload parse.
  const claim = async (id: string, worker: string, secondsAgo: number) =>
    sql`UPDATE jobs SET status='running',locked_at=CURRENT_TIMESTAMP-(${secondsAgo}*INTERVAL '1 second'),locked_by=${worker},attempts=attempts+1 WHERE id=${id}`;
  const claimable = async (id: string) =>
    (
      await sql<{ ok: boolean }[]>`
        SELECT status IN ('pending','retrying') AND available_at<=CURRENT_TIMESTAMP AND locked_by IS NULL AS ok
        FROM jobs WHERE id=${id}
      `
    )[0]?.ok;

  it("reclaims a claim its worker abandoned inside the lease once the lease runs out", async () => {
    const id = await enqueuePlanForecastJob(sql, userId, request("v1"), "planning_state_changed");
    await claim(id, "crashed-worker", 10);
    // The worker died and restarted seconds later. Boot recovery sees a claim still inside its lease
    // and rightly leaves it, which on its own left the row `running` for good: no claim picks up a
    // running row and nothing looked at it again until the next restart.
    await recoverAbandonedPlanForecastJobs(sql);
    expect(await statusOf(id)).toBe("running");
    expect(await claimPlanForecastJob(sql, "restarted-worker")).toBeNull();

    await sql`UPDATE jobs SET locked_at=CURRENT_TIMESTAMP-INTERVAL '121 seconds' WHERE id=${id}`;
    expect(await reclaimExpiredPlanForecastJobs(sql)).toEqual({ requeued: 1, failed: 0 });
    const [row] = await sql<{ status: string; last_error_code: string | null }[]>`
      SELECT status,last_error_code FROM jobs WHERE id=${id}
    `;
    expect(row).toEqual({ status: "retrying", last_error_code: "abandoned_lock" });
    expect(await claimable(id)).toBe(true);
  });

  it("leaves a claim inside its lease to the worker that holds it", async () => {
    const id = await enqueuePlanForecastJob(sql, userId, request("v1"), "planning_state_changed");
    await claim(id, "live-worker", 170);
    // A longer engine timeout buys a longer lease, so a slow live attempt is never taken from it.
    expect(await reclaimExpiredPlanForecastJobs(sql, 180)).toEqual({ requeued: 0, failed: 0 });
    expect(await statusOf(id)).toBe("running");
  });

  it("fails a job that keeps dying mid-attempt instead of reclaiming it forever", async () => {
    const id = await enqueuePlanForecastJob(sql, userId, request("v1"), "planning_state_changed");
    await sql`UPDATE jobs SET attempts=5 WHERE id=${id}`;
    await claim(id, "crashed-worker", 121);
    expect(await reclaimExpiredPlanForecastJobs(sql)).toEqual({ requeued: 0, failed: 1 });
    const [row] = await sql<{ status: string; failed: boolean }[]>`
      SELECT status,failed_at IS NOT NULL AS failed FROM jobs WHERE id=${id}
    `;
    expect(row).toEqual({ status: "failed", failed: true });
  });

  it("revives only a transiently failed job at boot, never a rejected, invalid or exhausted one", async () => {
    const failWith = async (code: string) => {
      const id = await enqueuePlanForecastJob(sql, userId, request(`v-${code}`), "planning_state_changed");
      await sql`UPDATE jobs SET status='failed',failed_at=CURRENT_TIMESTAMP,attempts=6,last_error_code=${code} WHERE id=${id}`;
      return id;
    };
    for (const code of ["plan_forecast_rejected", "invalid_payload", "abandoned_lock"]) {
      const id = await failWith(code);
      await recoverAbandonedPlanForecastJobs(sql);
      expect(await statusOf(id)).toBe("failed");
    }
    const transient = await failWith("plan_forecast_persist_failed");
    await recoverAbandonedPlanForecastJobs(sql);
    expect(await statusOf(transient)).toBe("retrying");
  });

  it("requeues an outage-exhausted job whose worker died instead of failing it", async () => {
    const id = await enqueuePlanForecastJob(sql, userId, request("v1"), "planning_state_changed");
    await sql`UPDATE jobs SET attempts=8,last_error_code='plan_forecast_unavailable' WHERE id=${id}`;
    await claim(id, "crashed-worker", 121);
    expect(await reclaimExpiredPlanForecastJobs(sql)).toEqual({ requeued: 1, failed: 0 });
    expect(await statusOf(id)).toBe("retrying");
  });

  it("fails a claimed job whose payload is invalid instead of leaving it running", async () => {
    const id = await enqueuePlanForecastJob(sql, userId, request("v1"), "planning_state_changed");
    await expect(claimPlanForecastJob(sql, "worker")).rejects.toThrow();
    const [row] = await sql<{ status: string; locked_by: string | null; last_error_code: string | null }[]>`
      SELECT status,locked_by,last_error_code FROM jobs WHERE id=${id}
    `;
    expect(row).toEqual({ status: "failed", locked_by: null, last_error_code: "invalid_payload" });
  });
});
