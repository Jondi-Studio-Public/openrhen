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

/**
 * The activity store is authored and irreplaceable, so a backup carries imports, events and per-source settings and a
 * restore brings them back unchanged, in dependency order (the append-only trigger refuses UPDATE only, so inserting
 * and truncating are unaffected). The restore step is the one `restore.ts` runs (`json_populate_recordset`).
 */
config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.ACTIVITY_BACKUP_TEST_DATABASE_NAME,
  "openrhen_activity_backup"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ACTIVITY_BACKUP_TEST_DATABASE_NAME must be an identifier ending in _test");
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
  const users = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Activity Fixture') RETURNING id`;
  userId = users[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

const TABLES = ["activity_imports", "activity_events", "activity_source_state"];

describe("the activity store in the backup", () => {
  it("is covered by the backup lists, with imports before events, and at format 22", async () => {
    for (const table of TABLES) expect(BACKUP_TABLES).toContain(table);
    expect(BACKUP_TABLES.indexOf("activity_imports")).toBeLessThan(BACKUP_TABLES.indexOf("activity_events"));
    expect(CURRENT_BACKUP_FORMAT_VERSION).toBe(22);
    await expect(assertBackupCoverage(sql)).resolves.toBeUndefined();
  });

  it("round-trips imports, events and settings through a backup and restore", async () => {
    const [imported] = await sql<{ id: string }[]>`
      INSERT INTO activity_imports (user_id, source, filename, sha256, event_count)
      VALUES (${userId}, 'chrome-takeout', 'BrowserHistory.json', ${"a".repeat(64)}, 1) RETURNING id
    `;
    await sql`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, ts_end, tz_offset_min, approximate, attrs, content, import_id, ingested_via)
      VALUES
        (${userId}, 'chrome-takeout', 'visit', 'k1', '2026-11-01T10:15:30.123Z', NULL, 660, false, '{"transition":"link"}', 'Title', ${imported!.id}, NULL),
        (${userId}, 'steam', 'session', 'k2', '2026-11-01T11:00:00Z', '2026-11-01T11:30:00Z', NULL, true, '{}', NULL, NULL, 'agent-a')
    `;
    await sql`INSERT INTO activity_source_state (user_id, source, content_enabled, retention_days, cursor)
              VALUES (${userId}, 'spotify', true, 365, '{"after":"123"}')`;
    const tables = await readAllTables(sql);
    expect(tables.activity_events).toHaveLength(2);
    const backup = validateBackup(
      JSON.parse(
        JSON.stringify({
          format: "priorities-postgresql-logical-backup",
          formatVersion: CURRENT_BACKUP_FORMAT_VERSION,
          createdAt: new Date().toISOString(),
          sourceDatabase: testDatabaseName,
          tables,
          sha256: checksum(tables)
        })
      )
    );

    await sql.unsafe('TRUNCATE TABLE "activity_events", "activity_imports", "activity_source_state"');
    for (const table of TABLES) {
      const rows = backup.tables[table]!;
      const { insert } = restorableColumns(rows, Object.keys(rows[0]!));
      const list = insert.map((column) => `"${column}"`).join(", ");
      await sql.unsafe(
        `INSERT INTO "${table}" (${list}) SELECT ${list} FROM json_populate_recordset(NULL::"${table}", $1::text::json)`,
        [JSON.stringify(rows)]
      );
    }

    const restored = await readAllTables(sql);
    expect(
      tablesWithDifferentContent(
        Object.fromEntries(TABLES.map((table) => [table, backup.tables[table]!])),
        Object.fromEntries(TABLES.map((table) => [table, restored[table]!]))
      )
    ).toEqual([]);
    expect(restored.activity_events).toEqual(tables.activity_events);
  });
});
