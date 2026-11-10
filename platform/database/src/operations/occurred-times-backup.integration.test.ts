import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "./integration-database.js";
import {
  assertBackupCoverage,
  BACKUP_TABLES,
  checksum,
  CURRENT_BACKUP_FORMAT_VERSION,
  readAllTables,
  restorableColumns,
  validateBackup
} from "./backup-format.js";

/** These suites hold no activity events, so the streamed section a current-format backup names is an empty one. */
const NO_ACTIVITY_ROWS = {
  activity_events: { file: "none.activity-events.ndjson", rows: 0, bytes: 0, sha256: "0".repeat(64) }
};

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.OCCURRED_TIMES_BACKUP_TEST_DATABASE_NAME,
  "openrhen_occurred_times_backup"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("OCCURRED_TIMES_BACKUP_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

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
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  const users = await sql<
    { id: string }[]
  >`INSERT INTO users (display_name) VALUES ('Occurred Times Backup Fixture') RETURNING id`;
  userId = users[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

/** What `restore.ts` does for the tables a backup carries: truncate every backed-up table, insert the present ones in order. */
async function restoreInto(tables: Record<string, Record<string, unknown>[]>, present: readonly string[]) {
  await sql.unsafe(`TRUNCATE TABLE ${BACKUP_TABLES.map((table) => `"${table}"`).join(", ")} RESTART IDENTITY CASCADE`);
  const columnRows = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY ordinal_position`;
  for (const table of BACKUP_TABLES.filter((name) => present.includes(name))) {
    const rows = tables[table] ?? [];
    if (!rows.length) continue;
    const { insert } = restorableColumns(
      rows,
      columnRows.filter((row) => row.table_name === table).map((row) => row.column_name)
    );
    const list = insert.map((column) => `"${column}"`).join(", ");
    await sql.unsafe(
      `INSERT INTO "${table}" (${list}) SELECT ${list} FROM json_populate_recordset(NULL::"${table}", $1::text::json)`,
      [JSON.stringify(rows)]
    );
  }
}

const seed = async () => {
  await sql`
    INSERT INTO check_in (user_id, slot_at, directive_kind, directive_title, status, answered_at, answer_source, occurred_at, occurred_note)
    VALUES (${userId}, now() - interval '2 hours', 'action', 'Write report', 'on_track', now() - interval '90 minutes', 'app',
      now() - interval '100 minutes', 'the time you gave is before the check-in was asked')`;
  const session = (
    await sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, target_type, target_id, target_title, status, planned_started_at, planned_end_at, started_at, planned_minutes, remaining_before_minutes)
      VALUES (${userId}, 'fixed_commitment', ${crypto.randomUUID()}, 'Work', 'running', now() - interval '3 hours', now() + interval '1 hour', now() - interval '3 hours', 240, 0)
      RETURNING id`
  )[0]!.id;
  await sql`
    INSERT INTO session_segments (session_id, started_at, ended_at, start_occurred_at, start_occurred_note, end_occurred_at, end_occurred_note)
    VALUES (${session}, now() - interval '3 hours', now() - interval '2 hours', now() - interval '181 minutes', NULL, now() - interval '119 minutes', 'a reason')`;
};

const backupOf = (tables: Record<string, Record<string, unknown>[]>) =>
  validateBackup(
    JSON.parse(
      JSON.stringify({
        format: "priorities-postgresql-logical-backup",
        formatVersion: CURRENT_BACKUP_FORMAT_VERSION,
        createdAt: new Date().toISOString(),
        sourceDatabase: testDatabaseName,
        tables,
        sha256: checksum(tables),
        streamed: NO_ACTIVITY_ROWS
      })
    )
  );

describe("claimed times in the backup", () => {
  it("is still covered, and round-trips the claims, their reasons and the receipt-side times unchanged", async () => {
    await expect(assertBackupCoverage(sql)).resolves.toBeUndefined();
    await seed();
    const tables = await readAllTables(sql);
    expect(tables.check_in![0]).toMatchObject({ occurred_note: "the time you gave is before the check-in was asked" });
    expect(tables.check_in![0]!.occurred_at).toBeTruthy();
    expect(tables.session_segments![0]).toMatchObject({ start_occurred_note: null, end_occurred_note: "a reason" });
    const backup = backupOf(tables);
    await restoreInto(backup.tables, BACKUP_TABLES);
    const restored = await readAllTables(sql);
    expect(restored.check_in).toEqual(tables.check_in);
    expect(restored.session_segments).toEqual(tables.session_segments);
  });

  it("restores a backup written before the columns existed, with the claims empty", async () => {
    await seed();
    const tables = await readAllTables(sql);
    const strip = (rows: Record<string, unknown>[], names: string[]) =>
      rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !names.includes(key))));
    const older = {
      ...tables,
      check_in: strip(tables.check_in!, ["occurred_at", "occurred_note"]),
      session_segments: strip(tables.session_segments!, [
        "start_occurred_at",
        "start_occurred_note",
        "end_occurred_at",
        "end_occurred_note"
      ])
    };
    await restoreInto(backupOf(older).tables, BACKUP_TABLES);
    const restored = await readAllTables(sql);
    expect(restored.check_in![0]).toMatchObject({ occurred_at: null, occurred_note: null, answer_source: "app" });
    expect(restored.session_segments![0]).toMatchObject({ start_occurred_at: null, end_occurred_at: null });
  });
});
