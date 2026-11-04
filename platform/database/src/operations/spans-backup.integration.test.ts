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
  readAllTables,
  restorableColumns,
  tablesWithDifferentContent,
  validateBackup
} from "./backup-format.js";

/**
 * the design notes: spans are authored, so a backup carries them and a restore brings them
 * back unchanged, window and project link included. The restore step is the one `restore.ts` runs
 * (`json_populate_recordset` over the columns the backup names).
 */
config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.SPANS_BACKUP_TEST_DATABASE_NAME, "openrhen_spans_backup");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("SPANS_BACKUP_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
let projectId: string;

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
  const users = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Spans Fixture') RETURNING id`;
  userId = users[0]!.id;
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'Travel','active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Trip','Done','active') RETURNING id`;
  const project = await sql<
    { id: string }[]
  >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Trip 1','active') RETURNING id`;
  projectId = project[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

describe("spans in the backup", () => {
  it("is covered by the backup list, so assertBackupCoverage passes", async () => {
    expect(BACKUP_TABLES).toContain("spans");
    await expect(assertBackupCoverage(sql)).resolves.toBeUndefined();
  });

  it("round-trips spans, with and without a window and project, through a backup and restore", async () => {
    await sql`
      INSERT INTO spans (user_id,title,start_date,end_date,"window",project_id)
      VALUES
        (${userId},'Trip 1','2026-09-27','2026-09-29',NULL,${projectId}),
        (${userId},'Conference','2026-11-03','2026-11-03',${sql.json({ localStartTime: "09:00", localEndTime: "17:00" })},NULL)
    `;
    const tables = await readAllTables(sql);
    expect(tables.spans).toHaveLength(2);
    const backup = validateBackup(
      JSON.parse(
        JSON.stringify({
          format: "priorities-postgresql-logical-backup",
          formatVersion: 19,
          createdAt: new Date().toISOString(),
          sourceDatabase: testDatabaseName,
          tables,
          sha256: checksum(tables)
        })
      )
    );

    await sql.unsafe('DELETE FROM "spans"');
    const rows = backup.tables.spans;
    const { insert } = restorableColumns(rows, Object.keys(rows[0]!));
    const list = insert.map((column) => `"${column}"`).join(", ");
    await sql.unsafe(
      `INSERT INTO "spans" (${list}) SELECT ${list} FROM json_populate_recordset(NULL::"spans", $1::text::json)`,
      [JSON.stringify(rows)]
    );

    const restored = await readAllTables(sql);
    expect(tablesWithDifferentContent({ spans: rows }, { spans: restored.spans })).toEqual([]);
    expect(restored.spans).toEqual(tables.spans);
  });
});
