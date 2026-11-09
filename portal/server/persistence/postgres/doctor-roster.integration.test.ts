import "@/test/example-calendar-sources";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { readDoctorReport } from "./doctor";
import { PostgresImportStore } from "./import-store";
import { registerDiffProfile } from "./imports/calendar-diff";
import { calendarProfile } from "./imports/calendar-profiles/calendar";

// The example sources declare profiles this suite does not exercise; the store refuses to build without them.
registerDiffProfile("roster", () => calendarProfile);
registerDiffProfile("shared_calendar", () => calendarProfile);

/** Doctor and the daily roster source: held changes surface, and a run that awaits review is not a failing sync. */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "rhen_doctor_roster");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const NOW = new Date("2026-10-18T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

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
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, catch_up_runs, integration_sync_runs, planning_runs, commitments, action_occurrences, action_recurrence_windows, action_recurrence_rules, actions, deliverables, projects, outcomes, areas, captures, plan_findings, import_batches, pulse_segments, push_outbox RESTART IDENTITY CASCADE"
  );
  await sql`DELETE FROM users WHERE id <> ${userId}`;
  // A plan with nothing wrong has a recent backup on record; tests for the recording checks clear it.
  await sql`INSERT INTO integration_sync_runs (user_id,provider,trigger,started_at,finished_at,status,summary)
    VALUES (${userId},'backup','scheduled',${NOW.toISOString()},${NOW.toISOString()},'synced','{}'::jsonb)`;
  await sql`UPDATE user_preferences SET last_woke_at = NULL,
    current_situation = (current_situation - 'locationId' - 'locationSetAt') || ${sql.json({ energySetAt: NOW.toISOString() } as never)} WHERE user_id=${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

describe("doctor and the daily roster source", () => {
  it("does not call a daily source failing while its runs only await review", async () => {
    const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
    await sql`INSERT INTO integration_sync_runs (user_id,provider,trigger,started_at,finished_at,status)
      VALUES (${userId},'example_daily','scheduled',${hoursAgo(120)},${hoursAgo(120)},'synced'),
             (${userId},'example_daily','scheduled',${hoursAgo(70)},${hoursAgo(70)},'needs_review'),
             (${userId},'example_daily','scheduled',${hoursAgo(46)},${hoursAgo(46)},'needs_review'),
             (${userId},'example_daily','scheduled',${hoursAgo(22)},${hoursAgo(22)},'needs_review')`;
    const ids = (await readDoctorReport(sql as never, { now: NOW })).items.map((entry) => entry.id);
    expect(ids).not.toContain("sync_failing:example_daily");
  });

  it("raises event_held for a daily source's open held batch", async () => {
    const batch = await sql<{ id: string }[]>`
      INSERT INTO import_batches (user_id,source_type,input_kind,timezone,status,created_at)
      VALUES (${userId},'example_daily','calendar','UTC','ready',${daysAgo(5)}) RETURNING id`;
    await sql`INSERT INTO import_records (batch_id,import_key,entity_type,operation,created_at)
      VALUES (${batch[0]!.id},'k1','fixed_commitment','delete',${daysAgo(5)})`;
    const report = await readDoctorReport(sql as never, { now: NOW });
    expect(report.items.map((entry) => entry.id)).toContain(`event_held:${batch[0]!.id}`);
  });

  it("keeps a held record's age when the sync replaces the open batch with one holding the same record", async () => {
    const insertBatch = async (createdAt: Date, keys: string[]) => {
      const batch = await sql<{ id: string }[]>`
        INSERT INTO import_batches (user_id,source_type,input_kind,timezone,status,created_at)
        VALUES (${userId},'example_daily','calendar','UTC','ready',${createdAt}) RETURNING id`;
      for (const key of keys)
        await sql`INSERT INTO import_records (batch_id,import_key,entity_type,operation,created_at)
          VALUES (${batch[0]!.id},${key},'fixed_commitment','delete',${createdAt})`;
      return batch[0]!.id;
    };
    await insertBatch(daysAgo(5), ["k1"]);
    const replacement = await insertBatch(daysAgo(0), ["k1", "k2"]);
    await new PostgresImportStore(sql as never).supersedeOpenBatches("example_daily" as never, replacement);
    const report = await readDoctorReport(sql as never, { now: NOW });
    const held = report.items.find((entry) => entry.id === `event_held:${replacement}`);
    expect(held?.since).toBe(daysAgo(5).toISOString());
  });
});
