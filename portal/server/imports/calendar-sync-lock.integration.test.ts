import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";

/**
 * The per (user, provider) advisory lock around `runCalendarSync`, against a real Postgres: while another
 * session holds it, a sync reports `already_running`, does nothing and records no run; once it is free the
 * sync runs and leaves the lock free again.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_calendar_sync_lock");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let runCalendarSync: typeof import("./calendar-sync").runCalendarSync;

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
  sql = postgres(testUrl.toString(), { max: 3, connect_timeout: 10, fetch_types: false });
  vi.stubEnv("DATABASE_URL", testUrl.toString());
  // No proxy: the Google proof answers not_configured without any network call.
  vi.stubEnv("OUTBOUND_PROXY_URL", "");
  vi.stubEnv("OUTBOUND_PROXY_TOKEN", "");
  vi.stubEnv("CALENDAR_SYNC_PROVIDERS", "");
  ({ runCalendarSync } = await import("./calendar-sync"));
}, 30_000);

beforeEach(async () => {
  // This suite is allowed to clear only a database whose validated name ends in _test.
  await sql.unsafe("TRUNCATE TABLE users, portal_state, jobs RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await sql?.end();
});

const runs = () => sql`SELECT provider, status FROM integration_sync_runs`;

describe("calendar sync advisory lock", () => {
  it("reports already_running, and records nothing, while another session holds the provider's lock", async () => {
    const userId = await ensureUser(sql);
    const holder = postgres(testUrl.toString(), { max: 1, connect_timeout: 10, fetch_types: false });
    try {
      const key = `calendar_sync:google_calendar:${userId}`;
      const [held] = await holder`SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS locked`;
      expect(held!.locked).toBe(true);

      const result = await runCalendarSync({ provider: "google_calendar", trigger: "manual" });
      expect(result).toMatchObject({ status: "already_running", provider: "google_calendar" });
      expect(await runs()).toHaveLength(0);
    } finally {
      await holder.end();
    }
  });

  it("runs when the lock is free, and leaves it free afterwards", async () => {
    const userId = await ensureUser(sql);
    const result = await runCalendarSync({ provider: "google_calendar", trigger: "manual" });
    expect(result.status).toBe("not_configured");
    expect(await runs()).toHaveLength(1);
    const key = `calendar_sync:google_calendar:${userId}`;
    const checker = postgres(testUrl.toString(), { max: 1, connect_timeout: 10, fetch_types: false });
    try {
      const [free] = await checker`SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS locked`;
      expect(free!.locked).toBe(true);
    } finally {
      await checker.end();
    }
  });

  it("does not let one provider's lock block another's", async () => {
    const userId = await ensureUser(sql);
    const holder = postgres(testUrl.toString(), { max: 1, connect_timeout: 10, fetch_types: false });
    try {
      await holder`SELECT pg_try_advisory_lock(hashtextextended(${`calendar_sync:example_shared:${userId}`}, 0))`;
      expect((await runCalendarSync({ provider: "google_calendar", trigger: "manual" })).status).toBe("not_configured");
    } finally {
      await holder.end();
    }
  });
});
