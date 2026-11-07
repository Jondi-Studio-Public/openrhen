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
  REGENERABLE_TABLES,
  restorableColumns,
  tablesAbsentFrom,
  tablesWithDifferentContent,
  validateBackup
} from "./backup-format.js";

/** These suites hold no activity events, so the streamed section a current-format backup names is an empty one. */
const NO_ACTIVITY_ROWS = {
  activity_events: { file: "none.activity-events.ndjson", rows: 0, bytes: 0, sha256: "0".repeat(64) }
};

/**
 * The Now offer log is authored history, so format 21 carries it and a restore brings it back unchanged; a format 20
 * backup has no such table and still restores, leaving it empty. The insert step is the one `restore.ts` runs.
 */
config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.OFFER_BACKUP_TEST_DATABASE_NAME, "openrhen_offer_backup");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("OFFER_BACKUP_TEST_DATABASE_NAME must be an identifier ending in _test");
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
  >`INSERT INTO users (display_name) VALUES ('Offer Backup Fixture') RETURNING id`;
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

const seedLog = () =>
  sql`
    INSERT INTO offer_log (user_id, event, target_type, target_id, label, rank, rank_basis, candidates, actor, command_id, detail)
    VALUES (${userId}, 'started', 'action', ${crypto.randomUUID()}, 'Write report', 2, 'offered_row', ${sql.json([{ rank: 2 }] as never)}, 'person', ${crypto.randomUUID()}, ${sql.json({ off_plan: false } as never)})`;

describe("the offer log in the backup", () => {
  it("is authored history: in BACKUP_TABLES after users, not regenerable, and covered", async () => {
    expect(BACKUP_TABLES).toContain("offer_log");
    expect(BACKUP_TABLES.indexOf("users")).toBeLessThan(BACKUP_TABLES.indexOf("offer_log"));
    expect(REGENERABLE_TABLES).not.toContain("offer_log");
    expect(CURRENT_BACKUP_FORMAT_VERSION).toBeGreaterThanOrEqual(21);
    await expect(assertBackupCoverage(sql)).resolves.toBeUndefined();
  });

  it("round-trips through a format 21 backup and restore, unchanged", async () => {
    await seedLog();
    const tables = await readAllTables(sql);
    expect(tables.offer_log).toHaveLength(1);
    const backup = validateBackup(
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
    expect(tablesAbsentFrom(backup)).toEqual([]);
    await restoreInto(backup.tables, BACKUP_TABLES);
    const restored = await readAllTables(sql);
    expect(
      tablesWithDifferentContent({ offer_log: backup.tables.offer_log! }, { offer_log: restored.offer_log! })
    ).toEqual([]);
    expect(restored.offer_log).toEqual(tables.offer_log);
  });

  it("restores a format 20 backup, which has no offer log, with the table empty", async () => {
    await seedLog();
    const full = await readAllTables(sql);
    const { offer_log: _omitted, ...format20Tables } = full;
    const backup = validateBackup(
      JSON.parse(
        JSON.stringify({
          format: "priorities-postgresql-logical-backup",
          formatVersion: 20,
          createdAt: new Date().toISOString(),
          sourceDatabase: testDatabaseName,
          tables: format20Tables,
          sha256: checksum(format20Tables)
        })
      )
    );
    const absent = tablesAbsentFrom(backup);
    expect(absent).toEqual(["offer_log"]);
    await restoreInto(
      backup.tables,
      BACKUP_TABLES.filter((table) => !absent.includes(table))
    );
    const restored = await readAllTables(sql);
    expect(restored.offer_log).toEqual([]);
    expect(restored.users).toEqual(full.users);
  });
});
