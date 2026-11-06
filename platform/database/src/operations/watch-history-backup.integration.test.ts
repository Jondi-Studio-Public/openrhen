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
  tablesWithDifferentContent,
  validateBackup
} from "./backup-format.js";

/**
 * Watch history is authored, so a backup carries imports and events and a restore brings them
 * back unchanged; the public video-length cache is regenerable and stays out. The restore step is the one `restore.ts` runs
 * (`json_populate_recordset` over the columns the backup names).
 */
config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.WATCH_BACKUP_TEST_DATABASE_NAME, "openrhen_watch_backup");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("WATCH_BACKUP_TEST_DATABASE_NAME must be an identifier ending in _test");
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
  await sql.unsafe("TRUNCATE TABLE users, video_info RESTART IDENTITY CASCADE");
  const users = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Watch Fixture') RETURNING id`;
  userId = users[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

describe("watch history in the backup", () => {
  it("is covered by the backup lists, so assertBackupCoverage passes, with imports before events", async () => {
    expect(BACKUP_TABLES).toContain("watch_events");
    expect(BACKUP_TABLES.indexOf("watch_imports")).toBeLessThan(BACKUP_TABLES.indexOf("watch_events"));
    expect(BACKUP_TABLES).not.toContain("video_info");
    expect(REGENERABLE_TABLES).toContain("video_info");
    await expect(assertBackupCoverage(sql)).resolves.toBeUndefined();
  });

  it("round-trips imports and events through a backup and restore, in dependency order", async () => {
    const [imported] = await sql<{ id: string }[]>`
      INSERT INTO watch_imports (user_id, filename, event_count) VALUES (${userId}, 'watch-history.json', 2) RETURNING id
    `;
    await sql`
      INSERT INTO watch_events (user_id, import_id, source, kind, video_id, watched_at, dup_index, title, channel)
      VALUES
        (${userId}, ${imported!.id}, 'youtube_takeout', 'watch', 'abcDEF12345', '2026-11-01T10:15:30Z', 0, 'Cats', 'Cat Channel'),
        (${userId}, ${imported!.id}, 'youtube_music_takeout', 'watch', 'x:0123456789abcdef01234567', '2026-11-01T10:15:30Z', 1, NULL, NULL)
    `;
    await sql`INSERT INTO video_info (video_id, duration_s) VALUES ('abcDEF12345', 212)`;
    const tables = await readAllTables(sql);
    expect(tables.watch_events).toHaveLength(2);
    expect(tables).not.toHaveProperty("video_info");
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

    // The cascade from the import removes its events; restore then brings both back, imports first.
    await sql.unsafe('DELETE FROM "watch_imports"');
    expect((await readAllTables(sql)).watch_events).toHaveLength(0);
    for (const table of ["watch_imports", "watch_events"]) {
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
        { watch_imports: backup.tables.watch_imports!, watch_events: backup.tables.watch_events! },
        { watch_imports: restored.watch_imports!, watch_events: restored.watch_events! }
      )
    ).toEqual([]);
    expect(restored.watch_events).toEqual(tables.watch_events);
  });
});
