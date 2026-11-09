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
 * The comparison log and the groups issued are authored history, so format 25 carries them and a restore brings them
 * back unchanged, with the refined columns on projects and actions (which a restore then refits); a format 24 backup has
 * neither table and still restores, leaving them empty. The insert step is the one `restore.ts` runs.
 */
config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.CONSEQUENCE_BACKUP_TEST_DATABASE_NAME,
  "openrhen_consequence_backup"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("CONSEQUENCE_BACKUP_TEST_DATABASE_NAME must be an identifier ending in _test");
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
  >`INSERT INTO users (display_name) VALUES ('Consequence Backup Fixture') RETURNING id`;
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

const WHEN = new Date("2026-11-09T02:00:00Z");

async function seed() {
  const area = (
    await sql<
      { id: string }[]
    >`INSERT INTO areas (user_id, name, sort_order) VALUES (${userId}, 'Life', 0) RETURNING id`
  )[0]!.id;
  const outcome = (
    await sql<
      { id: string }[]
    >`INSERT INTO outcomes (area_id, title, definition_of_done) VALUES (${area}, 'O', 'Done') RETURNING id`
  )[0]!.id;
  const ids: string[] = [];
  for (const title of ["A", "B", "C", "D"])
    ids.push(
      (
        await sql<{ id: string }[]>`INSERT INTO projects (outcome_id, title) VALUES (${outcome}, ${title}) RETURNING id`
      )[0]!.id
    );
  const group = (
    await sql<{ id: string }[]>`
    INSERT INTO consequence_groups_issued (user_id, pool, item_ids, wording, issued_at)
    VALUES (${userId}, 'project', ${`{${[...ids].sort().join(",")}}`}::text[], 'only_finish_one', ${WHEN}) RETURNING id`
  )[0]!.id;
  const sorted = [...ids].sort();
  const comparison = (
    await sql<{ id: string }[]>`
    INSERT INTO consequence_comparisons (user_id, pool, item_ids, item_stars, item_hashes, ranking, tie, answered_by, basis, evidence, question_wording, asked_at, answered_at, idempotency_key, group_id)
    VALUES (${userId}, 'project', ${`{${sorted.join(",")}}`}::text[], '{3,3,3,3}', '{h1,h2,h3,h4}', ${`{${[sorted[2], sorted[0], sorted[3], sorted[1]].join(",")}}`}::text[], false, 'agent', 'stated', 'They said "A first"', 'only_finish_one', ${WHEN}, ${WHEN}, 'key-1', ${group}) RETURNING id`
  )[0]!.id;
  await sql`UPDATE consequence_groups_issued SET answered_at = ${WHEN}, answered_comparison_id = ${comparison} WHERE id = ${group}`;
  await sql`UPDATE projects SET consequence_refined = 3.27, consequence_refined_for_stars = 3, consequence_refined_as_of = '2026-11-09' WHERE id = ${ids[0]!}`;
  return { ids, group, comparison };
}

const backupOf = (formatVersion: number, tables: Record<string, Record<string, unknown>[]>, streamed = true) =>
  validateBackup(
    JSON.parse(
      JSON.stringify({
        format: "priorities-postgresql-logical-backup",
        formatVersion,
        createdAt: new Date().toISOString(),
        sourceDatabase: testDatabaseName,
        tables,
        sha256: checksum(tables),
        ...(streamed ? { streamed: NO_ACTIVITY_ROWS } : {})
      })
    )
  );

describe("the comparison log in the backup", () => {
  it("is authored history: in BACKUP_TABLES after users, the groups before the answers, not regenerable, and covered", async () => {
    for (const table of ["consequence_groups_issued", "consequence_comparisons"]) {
      expect(BACKUP_TABLES).toContain(table);
      expect(BACKUP_TABLES.indexOf("users")).toBeLessThan(BACKUP_TABLES.indexOf(table as never));
      expect(REGENERABLE_TABLES).not.toContain(table);
    }
    expect(BACKUP_TABLES.indexOf("consequence_groups_issued")).toBeLessThan(
      BACKUP_TABLES.indexOf("consequence_comparisons")
    );
    expect(CURRENT_BACKUP_FORMAT_VERSION).toBeGreaterThanOrEqual(25);
    await expect(assertBackupCoverage(sql)).resolves.toBeUndefined();
  });

  it("round-trips through a format 25 backup and restore, unchanged, with the refined columns", async () => {
    const { ids } = await seed();
    const tables = await readAllTables(sql);
    expect(tables.consequence_comparisons).toHaveLength(1);
    expect(tables.consequence_groups_issued).toHaveLength(1);
    const backup = backupOf(CURRENT_BACKUP_FORMAT_VERSION, tables);
    expect(tablesAbsentFrom(backup)).toEqual([]);
    await restoreInto(backup.tables, BACKUP_TABLES);
    const restored = await readAllTables(sql);
    expect(
      tablesWithDifferentContent(
        {
          consequence_comparisons: backup.tables.consequence_comparisons!,
          consequence_groups_issued: backup.tables.consequence_groups_issued!,
          projects: backup.tables.projects!
        },
        {
          consequence_comparisons: restored.consequence_comparisons!,
          consequence_groups_issued: restored.consequence_groups_issued!,
          projects: restored.projects!
        }
      )
    ).toEqual([]);
    expect(restored.consequence_comparisons).toEqual(tables.consequence_comparisons);
    const back = (
      await sql<
        { v: number; s: number; d: string }[]
      >`SELECT consequence_refined AS v, consequence_refined_for_stars AS s, to_char(consequence_refined_as_of, 'YYYY-MM-DD') AS d FROM projects WHERE id = ${ids[0]!}`
    )[0]!;
    expect(back).toEqual({ v: 3.27, s: 3, d: "2026-11-09" });
  });

  it("restores a format 24 backup, which has neither table, with both empty", async () => {
    await seed();
    const full = await readAllTables(sql);
    const { consequence_comparisons: _a, consequence_groups_issued: _b, ...format24Tables } = full;
    const backup = backupOf(24, format24Tables);
    const absent = tablesAbsentFrom(backup);
    expect(absent).toEqual(["consequence_groups_issued", "consequence_comparisons"]);
    await restoreInto(
      backup.tables,
      BACKUP_TABLES.filter((table) => !absent.includes(table))
    );
    const restored = await readAllTables(sql);
    expect(restored.consequence_comparisons).toEqual([]);
    expect(restored.consequence_groups_issued).toEqual([]);
    expect(restored.users).toEqual(full.users);
  });

  it("keeps the log when a project it names is deleted", async () => {
    const { ids } = await seed();
    await sql`DELETE FROM projects WHERE id = ${ids[1]!}`;
    expect(Number((await sql`SELECT count(*)::int AS n FROM consequence_comparisons`)[0]!.n)).toBe(1);
  });
});
