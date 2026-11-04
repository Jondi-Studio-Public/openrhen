import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { readClosedSlice } from "./doctor-closed";

/**
 * The doctor's closed-stamp reader: records holding closed_at while not closed, and closed ones with none. The
 * trigger from migration 0140 keeps both at zero, so each finding is made with the trigger disabled for that insert.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_doctor_closed");

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
  await sql`DELETE FROM routine_presets WHERE user_id = ${userId}`;
  await sql`DELETE FROM commitments WHERE user_id = ${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

/** Runs `work` with the stamp trigger off on `table`, so a row the trigger would never allow can be written. */
async function withoutTrigger(table: string, work: () => Promise<unknown>) {
  await sql.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER stamp_closed_columns`);
  try {
    await work();
  } finally {
    await sql.unsafe(`ALTER TABLE ${table} ENABLE TRIGGER stamp_closed_columns`);
  }
}

describe("readClosedSlice", () => {
  it("reads nothing from clean data, closed or open", async () => {
    await sql`INSERT INTO routine_presets (user_id, name, activity_name, status) VALUES (${userId}, 'open', 'a', 'active')`;
    await sql`INSERT INTO routine_presets (user_id, name, activity_name, status) VALUES (${userId}, 'closed', 'a', 'archived')`;
    expect(await readClosedSlice(sql as never, userId)).toEqual({ tables: [] });
  });

  it("flags an open record that carries closed_at", async () => {
    await withoutTrigger(
      "routine_presets",
      () =>
        sql`INSERT INTO routine_presets (user_id, name, activity_name, status, closed_at) VALUES (${userId}, 'stray', 'a', 'active', now())`
    );
    expect(await readClosedSlice(sql as never, userId)).toEqual({
      tables: [{ table: "routine_presets", strayStamp: 1, missingStamp: 0 }]
    });
  });

  it("flags a closed record with no closed_at, using that table's own closed statuses", async () => {
    await withoutTrigger("commitments", async () => {
      await sql`INSERT INTO commitments (user_id, title, starts_at, ends_at, status) VALUES (${userId}, 'gone', now(), now() + interval '1 hour', 'cancelled')`;
    });
    await sql`INSERT INTO commitments (user_id, title, starts_at, ends_at, status) VALUES (${userId}, 'tentative', now(), now() + interval '1 hour', 'tentative')`;
    expect(await readClosedSlice(sql as never, userId)).toEqual({
      tables: [{ table: "commitments", strayStamp: 0, missingStamp: 1 }]
    });
  });
});
