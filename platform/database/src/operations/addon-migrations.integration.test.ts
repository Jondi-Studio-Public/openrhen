import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import journal from "../../drizzle/meta/_journal.json" with { type: "json" };
import { checkDatabaseMigrations, migrationHashes, readLedgerRows } from "./skipped-migrations.js";
import { integrationDatabaseName } from "./integration-database.js";

/**
 * The add-on migration set end to end: the real migrate-on-deploy entry point against a synthetic core history
 * (as in baseline-adoption.integration.test.ts) and a synthetic add-on folder built here (a baseline with a
 * foreign key into a core table, plus later migrations). No private SQL is committed.
 */
config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const run = promisify(execFile);
const adminUrl = process.env.POSTGRES_ADMIN_URL;
const databaseName = integrationDatabaseName(process.env.ADDON_MIGRATIONS_TEST_DATABASE_NAME, "openrhen_addon");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(databaseName)) {
  throw new Error("ADDON_MIGRATIONS_TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${databaseName}`;
const databaseUrl = testUrl.toString();

const entry = resolve(process.cwd(), "src/operations/migrate-on-deploy.ts");
const realFolder = resolve(process.cwd(), "drizzle");
const BASELINE_IDX = 139;
const baselineWhen = journal.entries.find((e) => e.idx === BASELINE_IDX)!.when;
const exported = journal.entries.filter((e) => e.idx > BASELINE_IDX);

let backupDir: string;
let toolDir: string;
let failingDump: string;
let fakeDump: string;
let legacyFolder: string;
let imageFolder: string;
let absentFolder: string;
let tagCounter = 0;
/** A distinct 12-character commit sha per call, so every dump file name differs. */
const nextTag = () => `00000000${String(++tagCounter).padStart(4, "0")}`;

type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };

async function writeFolder(folder: string, entries: Entry[], sql: (e: Entry) => string) {
  await rm(folder, { recursive: true, force: true });
  await mkdir(join(folder, "meta"), { recursive: true });
  for (const e of entries) await writeFile(join(folder, `${e.tag}.sql`), sql(e));
  await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }));
}

/** Core legacy history 0 to 141. Migration 5 also builds the add-on's two tables, as the real history did. */
function legacyEntries(count = 142): Entry[] {
  return Array.from({ length: count }, (_, idx) => ({
    idx,
    version: "7",
    when: idx <= BASELINE_IDX ? baselineWhen - (BASELINE_IDX - idx) * 1000 : exported[idx - BASELINE_IDX - 1]!.when,
    tag: `${String(idx).padStart(4, "0")}_legacy_${idx}`,
    breakpoints: true
  }));
}
const legacySql = (e: Entry) =>
  e.idx === 5
    ? "CREATE TABLE addon_things (id serial PRIMARY KEY, occurrence_id text, note text);\n--> statement-breakpoint\nCREATE TABLE addon_events (id serial PRIMARY KEY, thing_id integer NOT NULL);\n"
    : `CREATE TABLE legacy_t${e.idx} (id integer);\n` +
      // Legacy 0140 makes the tables that OpenRhen-native 0142, 0143 and 0150 alter, so a native migration has something to run on.
      (e.idx === 140
        ? "CREATE TABLE agent_wakes (event text, CONSTRAINT agent_wakes_event_check CHECK (event IN ('check_in_unanswered','pulse_lapsed')));\nCREATE TABLE commitments (id integer);\nCREATE TABLE users (id uuid PRIMARY KEY);\nCREATE TABLE projects (id integer);\nCREATE TABLE actions (id integer);\n"
        : "");

/** Migrations after the legacy history ends (0141): OpenRhen-native, applied once on top of an adopted baseline. */
const NATIVE_COUNT = journal.entries.filter((e) => e.idx > 141).length;

const describeLegacy = (e: Entry, sqlOf = legacySql) => ({
  idx: e.idx,
  when: e.when,
  hashes: migrationHashes(sqlOf(e))
});

const ADDON_BASELINE_SQL =
  "CREATE TABLE addon_things (id serial PRIMARY KEY, occurrence_id text REFERENCES action_occurrences(id), note text);\n" +
  "--> statement-breakpoint\n" +
  "CREATE TABLE addon_events (id serial PRIMARY KEY, thing_id integer NOT NULL REFERENCES addon_things(id));\n";
const GOOD_SECOND = "ALTER TABLE addon_events ADD COLUMN kind text;\n";
const THIRD = "ALTER TABLE addon_events ADD COLUMN extra text;\n";
const BAD_SECOND = "ALTER TABLE no_such_table ADD COLUMN kind text;\n";

const addonEntry = (idx: number, name: string, when: number): Entry => ({
  idx,
  version: "7",
  when,
  tag: `${String(idx).padStart(4, "0")}_${name}`,
  breakpoints: true
});
const A0 = addonEntry(0, "addon_baseline", baselineWhen);
const A1 = addonEntry(1, "addon_second", baselineWhen + 5000);
const A2 = addonEntry(2, "addon_third", baselineWhen + 9000);
const A1_MID = addonEntry(1, "addon_mid", baselineWhen + 2000);

/** An add-on folder with the given entries; `sqlFor` picks each file's text. */
async function addonFolderOf(name: string, entries: Entry[], sqlFor: Record<string, string> = {}) {
  const folder = join(toolDir, `addon-${name}`);
  const sqlOf = (e: Entry) => sqlFor[e.tag] ?? (e.idx === 0 ? ADDON_BASELINE_SQL : GOOD_SECOND);
  await writeFolder(folder, entries, sqlOf);
  const legacy = legacyEntries().filter((e) => e.idx <= BASELINE_IDX);
  await writeFile(
    join(folder, "meta/baseline.json"),
    JSON.stringify({ version: 1, baselineIdx: 0, legacyLedger: "core", legacy: legacy.map((e) => describeLegacy(e)) })
  );
  return folder;
}

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

const applyLegacy = () => withDb((sql) => migrate(drizzle(sql), { migrationsFolder: legacyFolder }));

const ledgerCount = (table: string) =>
  withDb(async (sql) => {
    if ((await sql`SELECT to_regclass(${`drizzle.${table}`})::text AS t`)[0]!.t === null) return null;
    return Number((await sql.unsafe(`SELECT count(*)::text AS count FROM drizzle."${table}"`))[0]!.count);
  });
const coreCount = () => ledgerCount("__drizzle_migrations");
const addonCount = () => ledgerCount("__drizzle_migrations_addon");

const tableExists = (name: string) =>
  withDb(async (sql) => (await sql`SELECT to_regclass(${`public.${name}`})::text AS t`)[0]!.t !== null);

const hasForeignKey = (table: string) =>
  withDb(
    async (sql) =>
      (
        await sql`SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND conrelid = ${`public.${table}`}::regclass`
      )[0]!.n > 0
  );

async function runMigrator(pgDump: string, addonDir: string, extra: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", entry], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        DATABASE_URL: databaseUrl,
        IMAGE_TAG: nextTag(),
        MIGRATE_BACKUP_DIR: backupDir,
        MIGRATIONS_FOLDER: imageFolder,
        ADDON_MIGRATIONS_FOLDER: addonDir,
        PG_DUMP_PATH: pgDump,
        ...extra
      }
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10, onnotice: () => undefined });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  toolDir = await mkdtemp(join(tmpdir(), "addon-tools-"));
  absentFolder = join(toolDir, "no-such-addon-folder");
  failingDump = join(toolDir, "pg_dump_fails");
  await writeFile(failingDump, '#!/bin/sh\necho "pg_dump must not run" >&2\nexit 1\n');
  fakeDump = join(toolDir, "pg_dump_ok");
  await writeFile(
    fakeDump,
    '#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) echo dump > "${a#--file=}";; esac; done\nexit 0\n'
  );
  await chmod(failingDump, 0o755);
  await chmod(fakeDump, 0o755);

  legacyFolder = join(toolDir, "legacy");
  await writeFolder(legacyFolder, legacyEntries(), legacySql);
  imageFolder = join(toolDir, "image");
  await cp(realFolder, imageFolder, { recursive: true });
  await writeFile(
    join(imageFolder, "meta/baseline.json"),
    JSON.stringify({
      version: 1,
      baselineIdx: BASELINE_IDX,
      legacy: legacyEntries()
        .filter((e) => e.idx <= BASELINE_IDX)
        .map((e) => describeLegacy(e)),
      laterLegacy: legacyEntries()
        .filter((e) => e.idx > BASELINE_IDX)
        .map((e) => ({ ...describeLegacy(e), exported: true }))
    })
  );
}, 60_000);

beforeEach(async () => {
  await withDb((sql) =>
    sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public")
  );
  if (backupDir) await rm(backupDir, { recursive: true, force: true });
  backupDir = await mkdtemp(join(tmpdir(), "addon-backups-"));
}, 60_000);

afterAll(async () => {
  await rm(toolDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
});

describe("the add-on migration set in migrate-on-deploy", () => {
  it("runs both sets on a fresh database and fills both ledgers", async () => {
    const addon = await addonFolderOf("two", [A0, A1]);

    const result = await runMigrator(fakeDump, addon);

    expect(result.code).toBe(0);
    expect(await coreCount()).toBe(journal.entries.length);
    expect(await addonCount()).toBe(2);
    expect(await hasForeignKey("addon_things")).toBe(true);
    expect(await readdir(backupDir)).toHaveLength(1);
    expect(result.stdout).toContain('"set":"core"');
    expect(result.stdout).toContain('"set":"addon"');
    const again = await runMigrator(failingDump, addon);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Nothing to migrate");
  });

  it("adopts core and the add-on on a legacy-shaped database: one dump, no baseline SQL, then a no-op", async () => {
    await applyLegacy();
    const coreBefore = await coreCount();
    expect(coreBefore).toBe(142);
    const addon = await addonFolderOf("two", [A0, A1]);

    const result = await runMigrator(fakeDump, addon);

    expect(result.code).toBe(0);
    expect(result.stdout.match(/"decision":"adopt"/g)).toHaveLength(2);
    expect(result.stdout).toContain('"set":"addon","tag":"0000_addon_baseline"');
    expect(await readdir(backupDir)).toHaveLength(1);
    expect(await coreCount()).toBe(coreBefore! + 1 + NATIVE_COUNT);
    // Adoption row plus the one later add-on migration; the baseline's SQL (with its foreign key) never ran.
    expect(await addonCount()).toBe(2);
    expect(await hasForeignKey("addon_things")).toBe(false);
    expect(await tableExists("action_occurrences")).toBe(false);

    const again = await runMigrator(failingDump, addon);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Nothing to migrate");
    expect(await readdir(backupDir)).toHaveLength(1);
    expect(await addonCount()).toBe(2);
  });

  it("reports the add-on baseline as applied to read-only callers without writing", async () => {
    await applyLegacy();
    const addon = await addonFolderOf("one", [A0]);
    const coreRows = await withDb((sql) => readLedgerRows(sql));

    const check = await withDb((sql) => checkDatabaseMigrations(sql, addon, "__drizzle_migrations_addon", coreRows));

    expect(check).toEqual({ pending: [], skipped: [] });
    expect(await addonCount()).toBeNull();
  });

  it("refuses a partial core legacy history before writing anything, naming no dump", async () => {
    await withDb((sql) =>
      migrate(drizzle(sql), { migrationsFolder: legacyFolder }).then(
        () => sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at > ${legacyEntries()[100]!.when}`
      )
    );
    const before = await coreCount();
    const addon = await addonFolderOf("two", [A0, A1]);

    const result = await runMigrator(failingDump, addon);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("101 of 140");
    expect(await readdir(backupDir)).toEqual([]);
    expect(await coreCount()).toBe(before);
    expect(await addonCount()).toBeNull();
  });

  it("refuses a skipped add-on migration, naming the add-on set, and takes no further dump", async () => {
    await runMigrator(fakeDump, await addonFolderOf("skip-a", [A0, A2], { [A2.tag]: THIRD }));
    expect(await addonCount()).toBe(2);
    const dumps = await readdir(backupDir);

    const result = await runMigrator(failingDump, await addonFolderOf("skip-b", [A0, A1_MID, A2], { [A2.tag]: THIRD }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Add-on migration set");
    expect(result.stderr).toContain("0001_addon_mid");
    expect(result.stderr).toContain("drizzle.__drizzle_migrations_addon");
    expect(await readdir(backupDir)).toEqual(dumps);
    expect(await addonCount()).toBe(2);
  });

  it("runs only the one newer add-on migration, after a dump, leaving core alone", async () => {
    await runMigrator(fakeDump, await addonFolderOf("grow-a", [A0]));
    const core = await coreCount();
    expect(await addonCount()).toBe(1);

    const result = await runMigrator(fakeDump, await addonFolderOf("grow-b", [A0, A1]));

    expect(result.code).toBe(0);
    expect(await readdir(backupDir)).toHaveLength(2);
    expect(await addonCount()).toBe(2);
    expect(await coreCount()).toBe(core);
    expect(result.stdout).toMatch(/"message":"Applied migrations","service":"migrate","set":"addon","applied":1/);
    expect(result.stdout).not.toMatch(/"message":"Applied migrations"[^\n]*"set":"core"/);
  });

  it("refuses an add-on database that is ahead of the image's add-on journal", async () => {
    await runMigrator(fakeDump, await addonFolderOf("ahead-a", [A0, A1]));
    const dumps = await readdir(backupDir);

    const result = await runMigrator(failingDump, await addonFolderOf("ahead-b", [A0]));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Add-on migration set: The database is ahead of this image");
    expect(await readdir(backupDir)).toEqual(dumps);
  });

  it("refuses a core database that is ahead of the image", async () => {
    await runMigrator(fakeDump, absentFolder);
    await withDb(
      (sql) =>
        sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('native', ${baselineWhen + 10 ** 12})`
    );

    const result = await runMigrator(failingDump, absentFolder);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ahead of this image");
    expect(result.stderr).not.toContain("Add-on migration set");
  });

  it("fails a broken add-on migration with core still applied, names the set and the dump, and finishes on rerun", async () => {
    const broken = await addonFolderOf("broken", [A0, A1], { [A1.tag]: BAD_SECOND });

    const result = await runMigrator(fakeDump, broken);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"set":"addon"');
    expect(result.stderr).toContain("restoreFrom");
    expect(result.stderr).toContain(backupDir);
    expect(result.stderr).toContain("partly migrated");
    expect(result.stderr).not.toContain("the database is unchanged");
    expect(await coreCount()).toBe(journal.entries.length);
    // Drizzle runs a set in one transaction, so the add-on baseline rolled back with the broken migration.
    expect(await addonCount()).toBe(0);
    const dumps = await readdir(backupDir);
    expect(dumps).toHaveLength(1);

    const fixed = await runMigrator(fakeDump, await addonFolderOf("fixed", [A0, A1]));
    expect(fixed.code).toBe(0);
    expect(await coreCount()).toBe(journal.entries.length);
    expect(await addonCount()).toBe(2);
    expect(await readdir(backupDir)).toHaveLength(2);
  });

  it("refuses an add-on ledger with rows when the add-on folder is missing, unless opted out", async () => {
    await runMigrator(fakeDump, await addonFolderOf("two", [A0, A1]));
    const dumps = await readdir(backupDir);

    const refused = await runMigrator(failingDump, absentFolder);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("ADDON_MIGRATIONS_OPTOUT=1");

    const optedOut = await runMigrator(failingDump, absentFolder, { ADDON_MIGRATIONS_OPTOUT: "1" });
    expect(optedOut.code).toBe(0);
    expect(optedOut.stdout).toContain("Nothing to migrate");
    expect(optedOut.stderr).toContain("ADDON_MIGRATIONS_OPTOUT=1");
    expect(await readdir(backupDir)).toEqual(dumps);
    expect(await addonCount()).toBe(2);
  });

  it("adds an add-on to a database OpenRhen itself built: the core baseline row is not legacy history", async () => {
    await runMigrator(fakeDump, absentFolder);

    const result = await runMigrator(fakeDump, await addonFolderOf("late", [A0, A1]));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"set":"addon","decision":"fresh"');
    expect(await hasForeignKey("addon_things")).toBe(true);
    expect(await addonCount()).toBe(2);
  });

  it("with no add-on folder behaves as core alone: no add-on ledger, no add-on log lines", async () => {
    const result = await runMigrator(fakeDump, absentFolder);

    expect(result.code).toBe(0);
    expect(await coreCount()).toBe(journal.entries.length);
    expect(await addonCount()).toBeNull();
    expect(result.stdout).not.toContain('"set":"addon"');
    expect(await readdir(backupDir)).toHaveLength(1);
    const again = await runMigrator(failingDump, absentFolder);
    expect(again.stdout).toContain("Nothing to migrate");
  });
});
