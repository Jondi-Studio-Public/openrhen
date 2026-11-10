import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { integrationDatabaseName } from "./integration-database.js";
import {
  assertBackupCoverage,
  BACKUP_TABLES,
  checksum,
  CURRENT_BACKUP_FORMAT_VERSION,
  readAllTables,
  validateBackup
} from "./backup-format.js";
import { writeBackup } from "./backup-run.js";
import { restoreBackup } from "./restore-run.js";
import { verifySection } from "./streamed-sections.js";

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

const TABLES = ["activity_imports", "activity_events", "activity_source_state", "derived_lineage", "extractor_state"];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "activity-backup-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const seedRows = async (rows: number, importId: string | null = null) =>
  sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, ingested_at, import_id)
      SELECT ${userId}, 'weather', 'observation', 'k' || g, '2026-01-01T00:00:00Z'::timestamptz + g * interval '1 second',
             '2026-06-01T00:00:00Z'::timestamptz + g * interval '1 second', ${importId}
      FROM generate_series(1, ${rows}::int) g`;

describe("the activity store in the backup", () => {
  it("is covered by the backup lists, with imports before events and lineage after them, and at format 27", async () => {
    for (const table of TABLES) expect(BACKUP_TABLES).toContain(table);
    expect(BACKUP_TABLES.indexOf("activity_imports")).toBeLessThan(BACKUP_TABLES.indexOf("activity_events"));
    expect(BACKUP_TABLES.indexOf("activity_events")).toBeLessThan(BACKUP_TABLES.indexOf("derived_lineage"));
    expect(BACKUP_TABLES.indexOf("users")).toBeLessThan(BACKUP_TABLES.indexOf("derived_settings"));
    expect(BACKUP_TABLES.indexOf("users")).toBeLessThan(BACKUP_TABLES.indexOf("derived_model_calls"));
    expect(CURRENT_BACKUP_FORMAT_VERSION).toBe(27);
    await expect(assertBackupCoverage(sql)).resolves.toBeUndefined();
  });

  it("round-trips imports, events and settings through a written backup and a restore", async () => {
    const [imported] = await sql<{ id: string }[]>`
      INSERT INTO activity_imports (user_id, source, filename, sha256, event_count)
      VALUES (${userId}, 'chrome-takeout', 'BrowserHistory.json', ${"a".repeat(64)}, 1) RETURNING id
    `;
    await sql`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, ts_end, tz_offset_min, approximate, attrs, content, import_id, ingested_via)
      VALUES
        (${userId}, 'chrome-takeout', 'visit', 'k1', '2026-11-01T10:15:30.123Z', NULL, 660, false, '{"transition":"link"}', 'Title \u2014 \u65e5\u672c', ${imported!.id}, NULL),
        (${userId}, 'steam', 'session', 'k2', '2026-11-01T11:00:00Z', '2026-11-01T11:30:00Z', NULL, true, '{}', NULL, NULL, 'agent-a')
    `;
    await sql`INSERT INTO activity_source_state (user_id, source, content_enabled, retention_days, expected_every_minutes, cursor)
              VALUES (${userId}, 'spotify', true, 365, 1440, '{"after":"123"}')`;
    const [k1, k2] = await sql<{ id: string }[]>`SELECT id FROM activity_events ORDER BY event_key`;
    await sql`INSERT INTO derived_lineage (user_id, derived_id, source_id) VALUES (${userId}, ${k2!.id}, ${k1!.id})`;
    await sql`INSERT INTO extractor_state (user_id, extractor, version, cursor, active)
              VALUES (${userId}, 'msg_class', 't0-1', '{"at":"2026-11-01T00:00:00Z"}', true)`;
    const before = await readAllTables(sql);
    expect(before.activity_events).toHaveLength(2);

    const written = await writeBackup(sql, { databaseUrl: testUrl.toString(), directory: dir });
    expect(written.sections).toHaveLength(1);
    expect(written.sections[0]).toMatchObject({ table: "activity_events", rows: 2 });
    expect((await readdir(dir)).sort()).toEqual([written.path.split("/").at(-1), written.sections[0]!.file].sort());
    const backup = validateBackup(JSON.parse(await readFile(written.path, "utf8")));
    expect(backup.formatVersion).toBe(27);
    expect(backup.tables.activity_events).toEqual([]);
    expect(backup.tables.activity_imports).toHaveLength(1);
    expect(backup.streamed!.activity_events).toMatchObject({ rows: 2, sha256: written.sections[0]!.sha256 });
    await verifySection(written.sections[0]!.path, backup.streamed!.activity_events!);

    expect(backup.tables.derived_lineage).toHaveLength(1);
    await sql.unsafe(
      'TRUNCATE TABLE "activity_events", "activity_imports", "activity_source_state", "extractor_state" CASCADE'
    );
    const outcome = await restoreBackup(sql, backup, written.path);
    expect(outcome.streamedRows).toEqual({ activity_events: 2 });
    expect(outcome.absent).toEqual([]);

    const after = await readAllTables(sql);
    expect(after.activity_events).toEqual(before.activity_events);
    expect(after.activity_imports).toEqual(before.activity_imports);
    expect(after.activity_source_state).toEqual(before.activity_source_state);
    expect(after.derived_lineage).toEqual(before.derived_lineage);
    expect(after.extractor_state).toEqual(before.extractor_state);
  });

  it("restores a backup written before expected_every_minutes existed: the column comes back null and nothing else changes", async () => {
    await sql`INSERT INTO activity_source_state (user_id, source, content_enabled, retention_days, expected_every_minutes)
              VALUES (${userId}, 'rhen-watch', true, 365, 1440)`;
    const written = await writeBackup(sql, { databaseUrl: testUrl.toString(), directory: dir });
    const raw = JSON.parse(await readFile(written.path, "utf8")) as {
      formatVersion: number;
      sha256: string;
      tables: Record<string, Record<string, unknown>[]>;
    };
    const rows = raw.tables.activity_source_state!;
    expect(rows).toHaveLength(1);
    for (const row of rows) for (const key of Object.keys(row)) if (/expected/i.test(key)) delete row[key];
    expect(Object.keys(rows[0]!).some((key) => /expected/i.test(key))).toBe(false);
    // A file from before the column existed is a format 26 file: the current format must come back row for row.
    raw.formatVersion = 26;
    raw.sha256 = checksum(raw.tables);
    const older = validateBackup(raw);
    expect(older.formatVersion).toBe(26);
    await sql.unsafe('TRUNCATE TABLE "activity_events", "activity_imports", "activity_source_state" CASCADE');
    await restoreBackup(sql, older, written.path);
    const [restored] = await sql<
      { content_enabled: boolean; retention_days: number; expected_every_minutes: number | null }[]
    >`SELECT content_enabled, retention_days, expected_every_minutes FROM activity_source_state`;
    expect(restored).toEqual({ content_enabled: true, retention_days: 365, expected_every_minutes: null });
  });

  it("restores into a database that already holds other events: the restore replaces them", async () => {
    await seedRows(5);
    const written = await writeBackup(sql, { databaseUrl: testUrl.toString(), directory: dir });
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start) VALUES (${userId}, 'steam', 'x', 'extra', now())`;
    const outcome = await restoreBackup(
      sql,
      validateBackup(JSON.parse(await readFile(written.path, "utf8"))),
      written.path
    );
    expect(outcome.streamedRows.activity_events).toBe(5);
    expect(await sql`SELECT 1 FROM activity_events WHERE event_key = 'extra'`).toHaveLength(0);
  });

  it("rejects a section whose bytes changed (a flipped byte), which db:restore:verify checks before it touches a database", async () => {
    await seedRows(5);
    const written = await writeBackup(sql, { databaseUrl: testUrl.toString(), directory: dir });
    const backup = validateBackup(JSON.parse(await readFile(written.path, "utf8")));
    const { writeFile } = await import("node:fs/promises");
    const bytes = await readFile(written.sections[0]!.path);
    bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 1;
    await writeFile(written.sections[0]!.path, bytes);
    await expect(verifySection(written.sections[0]!.path, backup.streamed!.activity_events!)).rejects.toThrow();
    expect(await sql`SELECT 1 FROM activity_events`).toHaveLength(5);
  });

  it("writes a backup of an empty activity table with an empty section", async () => {
    const written = await writeBackup(sql, { databaseUrl: testUrl.toString(), directory: dir });
    expect(written.sections[0]).toMatchObject({ rows: 0, bytes: 0 });
    const outcome = await restoreBackup(
      sql,
      validateBackup(JSON.parse(await readFile(written.path, "utf8"))),
      written.path
    );
    expect(outcome.streamedRows.activity_events).toBe(0);
  });

  it("restores a format 22 backup that holds the events in its JSON, and one that was written with a skip marker", async () => {
    await seedRows(3);
    const tables = await readAllTables(sql);
    expect(tables.activity_events).toHaveLength(3);
    const { createHash } = await import("node:crypto");
    const make = (t: typeof tables, extra: object) => ({
      format: "priorities-postgresql-logical-backup",
      formatVersion: 22,
      createdAt: new Date().toISOString(),
      sourceDatabase: testDatabaseName,
      tables: t,
      sha256: createHash("sha256").update(JSON.stringify(t)).digest("hex"),
      ...extra
    });
    const full = validateBackup(JSON.parse(JSON.stringify(make(tables, {}))));
    const out = await restoreBackup(sql, full, join(dir, "priorities-x.json"));
    expect(out.streamedRows.activity_events).toBe(3);
    expect((await readAllTables(sql)).activity_events).toEqual(tables.activity_events);

    const emptied = { ...tables, activity_events: [] };
    const skipped = [{ table: "activity_events", rows: 600000, reason: "over the old guard" }];
    const marked = validateBackup(JSON.parse(JSON.stringify(make(emptied, { skipped }))));
    const out2 = await restoreBackup(sql, marked, join(dir, "priorities-y.json"));
    expect(out2.streamedRows.activity_events).toBe(0);
    expect(marked.skipped).toEqual(skipped);
  });
});
