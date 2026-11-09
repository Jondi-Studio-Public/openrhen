import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { RUN_RETENTION_DAYS, recordRun, recordRunThrottled, resetRunThrottle } from "./run-log";

/**
 * The run log against the real `integration_sync_runs` constraints: every provider namespace the silent paths write
 * (`import:`, `ingest:`, `job:`, `device:`) with the two triggers and the statuses the table allows.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_run_log");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
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
  userId = await ensureUser(sql);
}, 60_000);

beforeEach(async () => {
  await sql`DELETE FROM integration_sync_runs`;
  resetRunThrottle();
});

afterAll(async () => {
  await sql?.end();
});

const at = new Date("2026-11-09T01:00:00Z");
const rows = () =>
  sql<{ provider: string; trigger: string; status: string; summary: unknown }[]>`
    SELECT provider, trigger, status, summary FROM integration_sync_runs ORDER BY started_at, provider`;

describe("recordRun", () => {
  it.each([
    ["import:timeline", "manual", "synced"],
    ["import:spotify", "manual", "needs_review"],
    ["import:youtube-watch-history", "manual", "failed"],
    ["ingest:unknown", "scheduled", "needs_review"],
    ["job:travel-lookup", "scheduled", "synced"],
    ["job:plan-map-sweep", "manual", "failed"],
    ["device:handheld", "scheduled", "synced"],
    ["device:handheld", "scheduled", "failed"]
  ] as const)("accepts %s with trigger %s and status %s", async (provider, trigger, status) => {
    await recordRun({ provider, trigger, status, startedAt: at, finishedAt: at, summary: { n: 1 } }, sql);
    expect(await rows()).toEqual([{ provider, trigger, status, summary: { n: 1 } }]);
  });

  it("never throws when the table refuses a value, and writes no row", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      recordRun(
        { provider: "job:x", trigger: "tick" as never, status: "synced", startedAt: at, finishedAt: at, summary: {} },
        sql
      )
    ).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
    expect(await rows()).toEqual([]);
  });

  it("prunes that provider's rows past the retention window and no other provider's", async () => {
    const old = new Date(Date.now() - (RUN_RETENTION_DAYS + 5) * 86_400_000);
    for (const provider of ["job:travel-lookup", "job:plan-map-sweep"])
      await sql`INSERT INTO integration_sync_runs (user_id, provider, trigger, started_at, finished_at, status, summary)
        VALUES (${userId}, ${provider}, 'scheduled', ${old}, ${old}, 'synced', '{}'::jsonb)`;
    await recordRun(
      {
        provider: "job:travel-lookup",
        trigger: "scheduled",
        status: "synced",
        startedAt: new Date(),
        finishedAt: new Date(),
        summary: {}
      },
      sql
    );
    expect((await rows()).map((row) => row.provider).sort()).toEqual(["job:plan-map-sweep", "job:travel-lookup"]);
    expect(
      await sql`SELECT 1 FROM integration_sync_runs WHERE provider = 'job:travel-lookup' AND started_at < ${old}`
    ).toHaveLength(0);
  });
});

describe("recordRunThrottled", () => {
  const run = {
    provider: "device:handheld",
    trigger: "scheduled",
    status: "failed",
    startedAt: at,
    finishedAt: at,
    summary: {}
  } as const;

  it("writes one row an hour per provider and status, from memory and from the table after a restart", async () => {
    await recordRunThrottled(run, { sql, now: at });
    await recordRunThrottled(run, { sql, now: new Date(at.getTime() + 600_000) });
    expect(await rows()).toHaveLength(1);
    resetRunThrottle();
    await recordRunThrottled(run, { sql, now: new Date(at.getTime() + 1_200_000) });
    expect(await rows()).toHaveLength(1);
    await recordRunThrottled({ ...run, status: "synced" }, { sql, now: new Date(at.getTime() + 1_200_000) });
    expect(await rows()).toHaveLength(2);
    await recordRunThrottled(run, { sql, now: new Date(at.getTime() + 4_900_000) });
    expect(await rows()).toHaveLength(3);
  });
});
