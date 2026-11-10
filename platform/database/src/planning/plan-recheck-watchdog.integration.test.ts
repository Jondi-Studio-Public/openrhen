import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import type { PlanForecastRequest } from "@openrhen/contracts";
import { PLAN_FORECAST_JOB_TYPE, enqueuePlanForecastJob } from "./plan-forecast-runtime.js";
import { healStalePlanChain, type HealStalePlanChainOptions } from "./plan-recheck-watchdog.js";
import { integrationDatabaseName } from "../operations/integration-database.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
// A database of its own for the same reason every other suite in this folder has one: these suites truncate.
const testDatabaseName = integrationDatabaseName(process.env.PLAN_RECHECK_TEST_DATABASE_NAME, "openrhen_plan_recheck");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("PLAN_RECHECK_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const now = new Date();
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

/** A stand-in request: only the input version and times matter to the queue, as in the queue suite. */
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

async function insertUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Watchdog Fixture') RETURNING id`;
  return rows[0]!.id;
}

async function insertRun(owner: string, calculatedAt: Date, superseded = false) {
  const requestId = crypto.randomUUID();
  await sql`
    INSERT INTO planning_runs (user_id, request_id, input_version, contract_version, engine_version, calculated_at, valid_until, result, superseded_at)
    VALUES (${owner}, ${requestId}, ${crypto.randomUUID()}, '1', '1', ${calculatedAt}, ${new Date(calculatedAt.getTime() + 3_600_000)}, ${sql.json({ requestId } as never)}, ${superseded ? calculatedAt : null})
  `;
}

/** Inserts a job straight into a status, in enqueue order, so a test can set up a dead chain. */
async function insertJob(owner: string, status: string, cause: string, errorCode?: string, failedAt: Date = now) {
  await sql`
    INSERT INTO jobs (type,payload,idempotency_key,status,available_at,last_error_code,failed_at)
    VALUES (
      ${PLAN_FORECAST_JOB_TYPE},
      ${sql.json({ userId: owner, cause, request: { inputVersion: crypto.randomUUID() } } as never)},
      ${`watchdog-fixture-${crypto.randomUUID()}`},${status},${now},${errorCode ?? null},${status === "failed" ? failedAt : null}
    )
  `;
}

const activeJobs = async (owner: string) =>
  (
    await sql<{ id: string }[]>`
      SELECT id FROM jobs
      WHERE type=${PLAN_FORECAST_JOB_TYPE} AND payload->>'userId'=${owner} AND status IN ('pending','retrying','running')
    `
  ).map((row) => row.id);

let lastHealAt: Map<string, Date>;
const enqueued: string[] = [];
/** Enqueues through the real enqueue, as the portal's write path does, recording whom it was asked for. */
const options = (): HealStalePlanChainOptions => ({
  lastHealAt,
  enqueue: async (owner) => {
    enqueued.push(owner);
    await enqueuePlanForecastJob(sql, owner, request(`heal-${crypto.randomUUID()}`), "planning_state_changed");
  }
});

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
  userId = await insertUser();
  lastHealAt = new Map();
  enqueued.length = 0;
});

afterAll(async () => {
  await sql?.end();
});

describe("healStalePlanChain", () => {
  it("enqueues exactly one job for a dead chain: an old run, no active job, a failed boundary job", async () => {
    await insertRun(userId, minutesAgo(120));
    await insertJob(userId, "failed", "validity_boundary", "plan_forecast_rejected");

    const healed = await healStalePlanChain(sql, now, options());

    expect(healed).toEqual([userId]);
    expect(enqueued).toEqual([userId]);
    expect(await activeJobs(userId)).toHaveLength(1);
  });

  it("does nothing while a pending job exists", async () => {
    await insertRun(userId, minutesAgo(120));
    await insertJob(userId, "pending", "validity_boundary");
    expect(await healStalePlanChain(sql, now, options())).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("does nothing while a retrying job exists", async () => {
    await insertRun(userId, minutesAgo(120));
    await insertJob(userId, "retrying", "planning_state_changed");
    expect(await healStalePlanChain(sql, now, options())).toEqual([]);
  });

  it("does nothing while a job is running", async () => {
    await insertRun(userId, minutesAgo(120));
    await insertJob(userId, "running", "planning_state_changed");
    expect(await healStalePlanChain(sql, now, options())).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("does nothing when the newest run is under 70 minutes old", async () => {
    await insertRun(userId, minutesAgo(120), true);
    await insertRun(userId, minutesAgo(65));
    await insertJob(userId, "failed", "validity_boundary", "plan_forecast_rejected");
    expect(await healStalePlanChain(sql, now, options())).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("does nothing when the last job failed because the engine is unavailable", async () => {
    await insertRun(userId, minutesAgo(120));
    await insertJob(userId, "failed", "validity_boundary", "plan_forecast_unavailable");
    expect(await healStalePlanChain(sql, now, options())).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("heals when the engine-unavailable failure is older than 70 minutes", async () => {
    await insertRun(userId, minutesAgo(300));
    await insertJob(userId, "failed", "validity_boundary", "plan_forecast_unavailable", minutesAgo(200));
    expect(await healStalePlanChain(sql, now, options())).toEqual([userId]);
  });

  it("still heals when an earlier job was unavailable but the latest failed otherwise", async () => {
    await insertRun(userId, minutesAgo(120));
    await insertJob(userId, "failed", "validity_boundary", "plan_forecast_unavailable");
    await insertJob(userId, "failed", "validity_boundary", "plan_forecast_rejected");
    expect(await healStalePlanChain(sql, now, options())).toEqual([userId]);
  });

  it("skips a user who has never had a run", async () => {
    await insertJob(userId, "failed", "validity_boundary", "plan_forecast_rejected");
    expect(await healStalePlanChain(sql, now, options())).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("does not heal twice in a row, even when the first heal left no job behind", async () => {
    await insertRun(userId, minutesAgo(120));
    const quiet: HealStalePlanChainOptions = { lastHealAt, enqueue: async (owner) => void enqueued.push(owner) };
    expect(await healStalePlanChain(sql, now, quiet)).toEqual([userId]);
    expect(await healStalePlanChain(sql, new Date(now.getTime() + 60_000), quiet)).toEqual([]);
    expect(enqueued).toEqual([userId]);
    // Past 70 minutes, a chain that is still dead is healed again.
    expect(await healStalePlanChain(sql, new Date(now.getTime() + 71 * 60_000), quiet)).toEqual([userId]);
  });

  it("treats two users independently", async () => {
    const other = await insertUser();
    await insertRun(userId, minutesAgo(120));
    await insertRun(other, minutesAgo(120));
    await insertJob(other, "running", "planning_state_changed");

    expect(await healStalePlanChain(sql, now, options())).toEqual([userId]);
    expect(enqueued).toEqual([userId]);
    expect(await activeJobs(userId)).toHaveLength(1);
    expect(await activeJobs(other)).toHaveLength(1);
  });

  it("does not record a heal whose enqueue failed, so the next tick tries again", async () => {
    await insertRun(userId, minutesAgo(120));
    const failing: HealStalePlanChainOptions = {
      lastHealAt,
      enqueue: async () => {
        throw new Error("portal down");
      }
    };
    await expect(healStalePlanChain(sql, now, failing)).rejects.toThrow("portal down");
    expect(lastHealAt.size).toBe(0);
    expect(await healStalePlanChain(sql, now, options())).toEqual([userId]);
  });
});
