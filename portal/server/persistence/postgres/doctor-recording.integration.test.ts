import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { readRecordingSlice } from "./doctor-recording";

/**
 * The doctor's recording reader (backup run rows and the phone ping time).
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_doctor_rec");

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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql`DELETE FROM integration_sync_runs`;
  await sql`UPDATE user_preferences SET device_location_state = '{}'::jsonb WHERE user_id = ${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

async function backupRun(status: string, startedAt: string, summary: Record<string, unknown> = {}) {
  await sql`INSERT INTO integration_sync_runs (user_id, provider, trigger, started_at, finished_at, status, summary)
    VALUES (${userId}, 'backup', 'scheduled', ${startedAt}, ${startedAt}, ${status}, ${JSON.stringify(summary)}::jsonb)`;
}

describe("readRecordingSlice", () => {
  it("reads no backup and no ping from an empty database", async () => {
    const slice = await readRecordingSlice(sql as never, userId);
    expect(slice.backup).toBeNull();
    expect(slice.phonePing.lastPingAt).toBeNull();
  });

  it("carries the local-only and restore-skipped flags from the latest run's summary", async () => {
    await backupRun("synced", "2026-10-17T03:00:00Z", { localOnly: true, restoreSkipped: true });
    const slice = await readRecordingSlice(sql, userId);
    expect(slice.backup).toMatchObject({ localOnly: true, restoreSkipped: true });
  });

  it("reports the latest backup run and the last success separately", async () => {
    await backupRun("synced", "2026-10-16T03:00:00Z");
    await backupRun("failed", "2026-10-17T03:00:00Z");
    const slice = await readRecordingSlice(sql as never, userId);
    expect(slice.backup).toEqual({
      status: "failed",
      lastRunAt: "2026-10-17T03:00:00.000Z",
      lastSuccessAt: "2026-10-16T03:00:00.000Z"
    });
  });

  it("counts a completed-with-warning run as a success and ignores other providers", async () => {
    await backupRun("needs_review", "2026-10-17T03:00:00Z");
    await sql`INSERT INTO integration_sync_runs (user_id, provider, trigger, started_at, finished_at, status, summary)
      VALUES (${userId}, 'example_shared', 'scheduled', '2026-10-18T03:00:00Z', '2026-10-18T03:00:00Z', 'synced', '{}'::jsonb)`;
    const slice = await readRecordingSlice(sql as never, userId);
    expect(slice.backup?.status).toBe("needs_review");
    expect(slice.backup?.lastSuccessAt).toBe("2026-10-17T03:00:00.000Z");
  });

  it("reads the stamped phone ping time", async () => {
    await sql`INSERT INTO user_preferences (user_id, device_location_state) VALUES (${userId}, ${sql.json({ lastPhonePingAt: "2026-10-18T09:00:00.000Z" } as never)})
      ON CONFLICT (user_id) DO UPDATE SET device_location_state = EXCLUDED.device_location_state`;
    const slice = await readRecordingSlice(sql as never, userId);
    expect(slice.phonePing.lastPingAt).toBe("2026-10-18T09:00:00.000Z");
  });
});
