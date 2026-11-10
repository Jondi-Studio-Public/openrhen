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
  tablesWithDifferentContent,
  validateBackup
} from "./backup-format.js";

/** These suites hold no activity events, so the streamed section a current-format backup names is an empty one. */
const NO_ACTIVITY_ROWS = {
  activity_events: { file: "none.activity-events.ndjson", rows: 0, bytes: 0, sha256: "0".repeat(64) }
};

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.CHECK_IN_BACKUP_TEST_DATABASE_NAME,
  "openrhen_check_in_backup"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("CHECK_IN_BACKUP_TEST_DATABASE_NAME must be an identifier ending in _test");
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
  >`INSERT INTO users (display_name) VALUES ('Check-in Backup Fixture') RETURNING id`;
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

const seed = () =>
  sql`
    INSERT INTO check_in (user_id, slot_at, directive_kind, directive_title, status, answered_at, deviation_note, answer_source, tags)
    VALUES (${userId}, now(), 'action', 'Write report', 'on_track', now(), 'yes, but slower than planned', 'widget',
      ${sql.json([{ tag: "slow", mark: "inferred" }] as never)})`;

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

describe("check-in words and tags in the backup", () => {
  it("is still covered, and round-trips the words, the source and the tags unchanged", async () => {
    await expect(assertBackupCoverage(sql)).resolves.toBeUndefined();
    await seed();
    const tables = await readAllTables(sql);
    expect(tables.check_in![0]).toMatchObject({
      deviation_note: "yes, but slower than planned",
      answer_source: "widget",
      tags: [{ tag: "slow", mark: "inferred" }]
    });
    const backup = backupOf(tables);
    await restoreInto(backup.tables, BACKUP_TABLES);
    const restored = await readAllTables(sql);
    expect(tablesWithDifferentContent({ check_in: backup.tables.check_in! }, { check_in: restored.check_in! })).toEqual(
      []
    );
    expect(restored.check_in).toEqual(tables.check_in);
  });

  it("restores a backup written before tags existed, with an empty list", async () => {
    await seed();
    const tables = await readAllTables(sql);
    const older = {
      ...tables,
      check_in: tables.check_in!.map(({ tags: _tags, ...row }) => row)
    };
    await restoreInto(backupOf(older).tables, BACKUP_TABLES);
    const restored = await readAllTables(sql);
    expect(restored.check_in![0]).toMatchObject({ deviation_note: "yes, but slower than planned", tags: [] });
  });
});
