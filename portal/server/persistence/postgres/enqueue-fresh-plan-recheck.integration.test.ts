import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { PLAN_FORECAST_JOB_TYPE, integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { enqueueFreshPlanRecheck } from "./planning-evidence";

/**
 * The plan recheck watchdog restarts a dead plan chain through this: one job built from state read now, cause
 * `planning_state_changed`, no `write_rows` row, and a second call leaves one waiting job, not two.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_plan_recheck_enqueue");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists
    `;
    if (!existing[0]?.exists) await admin.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
  } finally {
    await admin.end();
  }
  const migrationSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "../platform/database/drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users, jobs, writes RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await sql?.end();
});

const waitingJobs = (userId: string) =>
  sql<{ cause: string; status: string }[]>`
    SELECT payload->>'cause' AS cause, status FROM jobs
    WHERE type=${PLAN_FORECAST_JOB_TYPE} AND payload->>'userId'=${userId} AND status IN ('pending','retrying')
  `;

describe("enqueueFreshPlanRecheck", () => {
  it("queues exactly one pending planning_state_changed job and writes no change-log row", async () => {
    const userId = await ensureUser(sql);
    await enqueueFreshPlanRecheck(sql, userId);
    expect(await waitingJobs(userId)).toEqual([{ cause: "planning_state_changed", status: "pending" }]);
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM write_rows`;
    expect(rows[0]!.n).toBe(0);
  });

  it("leaves one waiting job when called twice", async () => {
    const userId = await ensureUser(sql);
    await enqueueFreshPlanRecheck(sql, userId);
    await enqueueFreshPlanRecheck(sql, userId);
    expect(await waitingJobs(userId)).toHaveLength(1);
  });
});
