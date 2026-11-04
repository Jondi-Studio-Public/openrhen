import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import type { PlanForecastRequest } from "@openrhen/contracts";
import {
  PLAN_FORECAST_JOB_TYPE,
  enqueuePlanForecastJob,
  processPlanForecastJob,
  type PlanForecastJobOutcome
} from "./plan-forecast-runtime.js";
import {
  jobStatusOf,
  minimalPlanForecastRequest,
  startStandInEngine,
  type StandInEngine
} from "./plan-forecast-engine-harness.js";
import { integrationDatabaseName } from "../operations/integration-database.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
// A database of its own for the same reason every other suite in this folder has one: these suites
// truncate, and two of them truncating the same database is an unreproducible flake.
const testDatabaseName = integrationDatabaseName(process.env.PLAN_CLAIM_TEST_DATABASE_NAME, "openrhen_plan_claim");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("PLAN_CLAIM_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

// Every completed run in this suite gets a past `validUntil` (the harness default), so nothing chains
// a `validity_boundary` follow-up job — that path needs its own coverage, not noise here.
let engine: StandInEngine;

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

  engine = await startStandInEngine();
}, 60_000);

beforeEach(async () => {
  // This suite is allowed to clear only a database whose validated name ends in _test.
  await sql.unsafe("TRUNCATE TABLE users, jobs RESTART IDENTITY CASCADE");
  const users = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Claim Fixture') RETURNING id`;
  userId = users[0]!.id;
  engine.reset();
});

afterEach(async () => {
  // planning_runs/forecast_snapshots/recommendations are keyed off users, which the next beforeEach
  // truncates via CASCADE, so nothing extra needs cleaning here.
});

afterAll(async () => {
  await sql?.end();
  await engine?.close();
});

const statusOf = (id: string) => jobStatusOf(sql, id);

/** A dummy request shape sufficient for a job that is never claimed (its `payload.request` is never
 * parsed) — this suite's queue-draining tests supersede such jobs at enqueue time before that happens. */
const dummyRequest = (inputVersion: string): PlanForecastRequest =>
  ({
    contractVersion: "1",
    requestId: crypto.randomUUID(),
    inputVersion,
    calculatedAt: new Date().toISOString(),
    horizonEnd: new Date(Date.now() + 86_400_000).toISOString(),
    state: {},
    deliverables: []
  }) as unknown as PlanForecastRequest;

describe("processPlanForecastJob — claim-time supersession", () => {
  it("calls the engine once for two sequential writes, and the newest wins", async () => {
    // The first write is superseded synchronously by `enqueuePlanForecastJob` the moment the second
    // lands — this is the queue-side half of the fix — so it never needs a schema-valid request at
    // all: it will never be claimed.
    const stale = await enqueuePlanForecastJob(sql, userId, dummyRequest("stale"), "planning_state_changed");
    const fresh = await enqueuePlanForecastJob(
      sql,
      userId,
      await minimalPlanForecastRequest(new Date()),
      "planning_state_changed"
    );
    expect(await statusOf(stale)).toBe("superseded");
    expect(await statusOf(fresh)).toBe("pending");

    const outcomes: string[] = [];
    for (;;) {
      const outcome = await processPlanForecastJob(sql, engine.config, "test-worker");
      if (outcome === "idle") break;
      outcomes.push(outcome);
    }

    expect(engine.callCount).toBe(1);
    expect(outcomes).toEqual(["completed"]);
    expect(await statusOf(fresh)).toBe("completed");
    expect(await statusOf(stale)).toBe("superseded");
    const runs = await sql<{ id: string }[]>`SELECT id FROM planning_runs WHERE user_id=${userId}`;
    expect(runs).toHaveLength(1);
  });

  // A worker's own claim-time check is the backstop `enqueuePlanForecastJob`'s synchronous
  // supersession cannot be: nothing prevents an older row from still being `pending` when a newer one
  // exists (a race between the two, or — as simulated here — a caller claiming a specific job
  // directly). This is what actually guarantees an engine call is never spent on stale work.
  it("supersedes a claimed job at claim time when a newer job already exists, without calling the engine", async () => {
    const older = await enqueuePlanForecastJob(
      sql,
      userId,
      await minimalPlanForecastRequest(new Date()),
      "planning_state_changed"
    );
    // Inserted directly, bypassing `enqueuePlanForecastJob`, so the older row above is not touched by
    // its synchronous supersession — reproducing the race this claim-time check exists to catch.
    // Its own `request` is never parsed (it is never claimed in this test), so it need not be valid.
    const newerId = crypto.randomUUID();
    await sql`
      INSERT INTO jobs (id,type,payload,idempotency_key,status,available_at,created_at)
      VALUES (
        ${newerId},${PLAN_FORECAST_JOB_TYPE},
        ${sql.json({ userId, cause: "planning_state_changed", request: { inputVersion: "newer-dummy" } } as never)},
        ${"claim-race-newer-key"},'pending',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '1 millisecond'
      )
    `;
    expect(await statusOf(older)).toBe("pending");
    expect(await statusOf(newerId)).toBe("pending");

    const outcomes: PlanForecastJobOutcome[] = [];
    const outcome = await processPlanForecastJob(sql, engine.config, "test-worker", older, (record) =>
      outcomes.push(record)
    );

    expect(outcome).toBe("superseded");
    expect(engine.callCount).toBe(0);
    expect(await statusOf(older)).toBe("superseded");
    // The newest job is never touched by either supersession path.
    expect(await statusOf(newerId)).toBe("pending");
    // The outcome record is the reason a superseded row carries: which job, which cause, and that it
    // ended `superseded` rather than `completed` — recorded even though the row itself has no
    // free-text reason column.
    expect(outcomes).toEqual([
      expect.objectContaining({ jobId: older, outcome: "superseded", cause: "planning_state_changed" })
    ]);
  });

  it("never supersedes the newest job for a user, even when older jobs are still pending", async () => {
    const older = await enqueuePlanForecastJob(
      sql,
      userId,
      await minimalPlanForecastRequest(new Date()),
      "planning_state_changed"
    );
    const newestId = crypto.randomUUID();
    await sql`
      INSERT INTO jobs (id,type,payload,idempotency_key,status,available_at,created_at)
      VALUES (
        ${newestId},${PLAN_FORECAST_JOB_TYPE},
        ${sql.json({ userId, cause: "planning_state_changed", request: { inputVersion: "newest-dummy" } } as never)},
        ${"claim-race-newest-key"},'pending',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '1 millisecond'
      )
    `;

    await processPlanForecastJob(sql, engine.config, "test-worker", older);

    expect(await statusOf(older)).toBe("superseded");
    // The newest row is left exactly as it was — nothing in the claim-time or enqueue-time logic ever
    // compares a job against itself or against nothing.
    expect(await statusOf(newestId)).toBe("pending");
  });
});

describe("processPlanForecastJob — validity_boundary jobs are unaffected", () => {
  it("still supersedes a boundary job without calling the engine when state changed since its snapshot", async () => {
    const stateCapturedAt = new Date(Date.now() - 60_000).toISOString();
    // Available immediately (unlike the "waiting boundary job" fixtures in the queue suite) — this
    // suite claims the job, and a future `available_at` would leave it unclaimable regardless of
    // `specificJobId`. `undefined` defaults to the epoch rather than `new Date()`, since the test
    // machine's clock running even slightly ahead of the database server's would otherwise make the
    // row briefly unavailable at exactly the moment this test claims it.
    const boundary = await enqueuePlanForecastJob(
      sql,
      userId,
      await minimalPlanForecastRequest(new Date()),
      "validity_boundary",
      undefined,
      stateCapturedAt
    );
    // A write recorded after the snapshot the boundary job was chained from.
    await sql`WITH w AS (INSERT INTO writes (id,user_id,command_type) VALUES (gen_random_uuid(),${userId},'action') RETURNING id) INSERT INTO write_rows (write_id,user_id,entity_type,operation) SELECT id,${userId},'action','update' FROM w`;

    const outcome = await processPlanForecastJob(sql, engine.config, "test-worker", boundary);

    expect(outcome).toBe("superseded");
    expect(engine.callCount).toBe(0);
    expect(await statusOf(boundary)).toBe("superseded");
  });

  it("still runs a boundary job normally, calling the engine, when nothing changed since its snapshot", async () => {
    const stateCapturedAt = new Date(Date.now() - 60_000).toISOString();
    // Available immediately (unlike the "waiting boundary job" fixtures in the queue suite) — this
    // suite claims the job, and a future `available_at` would leave it unclaimable regardless of
    // `specificJobId`. `undefined` defaults to the epoch rather than `new Date()`, since the test
    // machine's clock running even slightly ahead of the database server's would otherwise make the
    // row briefly unavailable at exactly the moment this test claims it.
    const boundary = await enqueuePlanForecastJob(
      sql,
      userId,
      await minimalPlanForecastRequest(new Date()),
      "validity_boundary",
      undefined,
      stateCapturedAt
    );

    const outcome = await processPlanForecastJob(sql, engine.config, "test-worker", boundary);

    expect(outcome).toBe("completed");
    expect(engine.callCount).toBe(1);
    expect(await statusOf(boundary)).toBe("completed");
  });
});
