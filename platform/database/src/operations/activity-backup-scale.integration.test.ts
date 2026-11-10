import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { integrationDatabaseName } from "./integration-database.js";
import { validateBackup } from "./backup-format.js";
import { writeBackup } from "./backup-run.js";
import { restoreBackup } from "./restore-run.js";
import { verifySection } from "./streamed-sections.js";

/**
 * The streamed activity section at scale. The old single-JSON backup measured about 2.4 GB of process memory for one
 * million synthetic rows and failed outright at two million (V8's string limit); this writes, verifies and restores the
 * same sizes with memory that does not grow with the row count, and the restored table is identical to the source.
 *
 * One size is enough: the bound below is 300 MB, and the old backup's measured ~2.4 KB of process memory per row puts
 * 300,000 rows at about 720 MB, so a regression to buffering the whole table fails here long before it would reach the
 * 2,000,000 rows that once hit V8's string limit. That second run (about four minutes alone) added no detection power
 * and made this file most of the integration job's wall time.
 */
config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.ACTIVITY_BACKUP_SCALE_TEST_DATABASE_NAME,
  "openrhen_activity_backup_scale"
);
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ACTIVITY_BACKUP_SCALE_TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

/** How far peak resident memory may rise above its starting level while a stage runs. Flat means independent of rows. */
const RSS_GROWTH_BOUND = 300 * 1024 * 1024;

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
  sql = postgres(testUrl.toString(), { max: 3, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  const users = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Scale Fixture') RETURNING id`;
  userId = users[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

/** Runs `work` while sampling resident memory; returns the peak rise over the level at the start. */
async function peakRssGrowth(work: () => Promise<void>): Promise<number> {
  const start = process.memoryUsage().rss;
  let peak = start;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 25);
  try {
    await work();
  } finally {
    clearInterval(timer);
    peak = Math.max(peak, process.memoryUsage().rss);
  }
  return peak - start;
}

/** An order-independent fingerprint of the whole table, computed inside Postgres so the test holds no rows. */
const fingerprint = async () =>
  (
    await sql<{ n: string; h: string }[]>`
      SELECT count(*)::text AS n, coalesce(sum(hashtextextended(t::text, 0)::numeric), 0)::text AS h FROM activity_events t`
  )[0]!;

async function roundTrip(rows: number) {
  const [imported] = await sql<{ id: string }[]>`
    INSERT INTO activity_imports (user_id, source, filename, sha256, event_count)
    VALUES (${userId}, 'weather', 'big.json', ${"b".repeat(64)}, ${rows}) RETURNING id`;
  // Whole-second timestamps: the restore carries milliseconds, which is all a JS Date (and so the backup) holds.
  await sql`
    INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, ts_end, tz_offset_min, attrs, content, import_id, ingested_at)
    SELECT ${userId}, 'weather', 'observation', 'key-' || g, '2026-01-01T00:00:00Z'::timestamptz + g * interval '1 second',
           CASE WHEN g % 3 = 0 THEN '2026-01-01T00:00:00Z'::timestamptz + g * interval '1 second' + interval '90 seconds' END,
           CASE WHEN g % 2 = 0 THEN 660 END,
           jsonb_build_object('n', g, 'label', 'row ' || g, 'tags', jsonb_build_array('a', 'b', g % 7)),
           CASE WHEN g % 5 = 0 THEN 'text ' || g || ' — 日本' END,
           ${imported!.id},
           '2026-06-01T00:00:00Z'::timestamptz + g * interval '1 second'
    FROM generate_series(1, ${rows}::int) g`;
  const source = await fingerprint();
  expect(Number(source.n)).toBe(rows);

  const dir = await mkdtemp(join(tmpdir(), "activity-scale-"));
  try {
    let written!: Awaited<ReturnType<typeof writeBackup>>;
    const writeGrowth = await peakRssGrowth(async () => {
      written = await writeBackup(sql, { databaseUrl: testUrl.toString(), directory: dir });
    });
    const section = written.sections[0]!;
    expect(section.rows).toBe(rows);
    // The JSON is only the manifest and the small tables, however large the events are.
    expect((await stat(written.path)).size).toBeLessThan(2_000_000);
    expect((await stat(section.path)).size).toBe(section.bytes);

    const backup = validateBackup(JSON.parse(await readFile(written.path, "utf8")));
    const verifyGrowth = await peakRssGrowth(() => verifySection(section.path, backup.streamed!.activity_events!));

    let restoreGrowth = 0;
    await sql.unsafe(
      'TRUNCATE TABLE "activity_events", "activity_imports", "activity_source_state", "derived_lineage"'
    );
    restoreGrowth = await peakRssGrowth(async () => {
      const outcome = await restoreBackup(sql, backup, written.path);
      expect(outcome.streamedRows.activity_events).toBe(rows);
    });
    // Exact: every column of every row is what it was.
    expect(await fingerprint()).toEqual(source);
    return { rows, bytes: section.bytes, writeGrowth, verifyGrowth, restoreGrowth };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("the streamed activity backup at scale", () => {
  it("writes, verifies and restores 300,000 rows exactly, with flat memory", async () => {
    const result = await roundTrip(300_000);
    process.stderr.write(`${JSON.stringify({ scale: result })}\n`);
    expect(result.writeGrowth).toBeLessThan(RSS_GROWTH_BOUND);
    expect(result.verifyGrowth).toBeLessThan(RSS_GROWTH_BOUND);
    expect(result.restoreGrowth).toBeLessThan(RSS_GROWTH_BOUND);
  }, 600_000);
});
