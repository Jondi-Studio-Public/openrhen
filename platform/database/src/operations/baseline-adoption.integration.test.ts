import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import journal from "../../drizzle/meta/_journal.json" with { type: "json" };
import { migrationHashes, checkDatabaseMigrations } from "./skipped-migrations.js";
import { integrationDatabaseName } from "./integration-database.js";

/**
 * Baseline equivalence end to end: the real migrate-on-deploy entry point against databases shaped like the
 * pre-baseline history. The history is synthetic (140 tiny migrations plus two later ones, built here), so the
 * suite holds no private migration; the same flow runs against the real history when LEGACY_MIGRATIONS_FOLDER
 * names it (the last test).
 */
config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const run = promisify(execFile);
const adminUrl = process.env.POSTGRES_ADMIN_URL;
const databaseName = integrationDatabaseName(process.env.BASELINE_ADOPTION_TEST_DATABASE_NAME, "openrhen_adopt");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(databaseName)) {
  throw new Error("BASELINE_ADOPTION_TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${databaseName}`;
const databaseUrl = testUrl.toString();

const entry = resolve(process.cwd(), "src/operations/migrate-on-deploy.ts");
const realFolder = resolve(process.cwd(), "drizzle");
const DEPLOY_TAG = "0123456789ab";
const BASELINE_IDX = 139;
const baselineWhen = journal.entries.find((e) => e.idx === BASELINE_IDX)!.when;
const exported = journal.entries.filter((e) => e.idx > BASELINE_IDX);
/** A private-only legacy migration the image does not carry, newer than everything the image has. */
const PRIVATE_ONLY_WHEN = Math.max(...journal.entries.map((e) => e.when)) + 60_000;

let backupDir: string;
let toolDir: string;
let failingDump: string;
let fakeDump: string;
let legacyFolder: string;
let imageFolder: string;

type LegacyEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };

async function writeFolder(folder: string, entries: LegacyEntry[], sql: (e: LegacyEntry) => string) {
  await mkdir(join(folder, "meta"), { recursive: true });
  for (const e of entries) await writeFile(join(folder, `${e.tag}.sql`), sql(e));
  await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }));
}

/** Legacy migrations 0 to 141 plus one private-only 142; 139 shares the baseline's `when`, 140 and 141 the image's. */
function legacyEntries(): LegacyEntry[] {
  const entries: LegacyEntry[] = [];
  for (let idx = 0; idx <= 142; idx++) {
    const when =
      idx <= BASELINE_IDX
        ? baselineWhen - (BASELINE_IDX - idx) * 1000
        : idx === 142
          ? PRIVATE_ONLY_WHEN
          : exported[idx - BASELINE_IDX - 1]!.when;
    entries.push({ idx, version: "7", when, tag: `${String(idx).padStart(4, "0")}_legacy_${idx}`, breakpoints: true });
  }
  return entries;
}

const legacySql = (e: LegacyEntry) => `CREATE TABLE legacy_t${e.idx} (id integer);\n`;

/** The image's folder with a baseline.json built from the synthetic history. */
async function writeSyntheticBaseline(imageDir: string, entries: LegacyEntry[]) {
  const describe = (e: LegacyEntry) => ({ idx: e.idx, when: e.when, hashes: migrationHashes(legacySql(e)) });
  await writeFile(
    join(imageDir, "meta/baseline.json"),
    JSON.stringify({
      version: 1,
      baselineIdx: BASELINE_IDX,
      legacy: entries.filter((e) => e.idx <= BASELINE_IDX).map(describe),
      laterLegacy: entries.filter((e) => e.idx > BASELINE_IDX).map((e) => ({ ...describe(e), exported: e.idx < 142 }))
    })
  );
}

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** Applies a legacy folder with drizzle's own migrator, so the ledger rows are the real kind. */
async function applyLegacy(folder: string) {
  await withDb((sql) => migrate(drizzle(sql), { migrationsFolder: folder }));
}

const ledgerCount = () =>
  withDb(async (sql) => {
    try {
      return Number(
        (await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`)[0]!.count
      );
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "42P01") return null;
      throw error;
    }
  });

const tableExists = (name: string) =>
  withDb(async (sql) => (await sql`SELECT to_regclass(${`public.${name}`})::text AS t`)[0]!.t !== null);

async function runMigrator(pgDump: string, folder: string, extra: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", entry], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        DATABASE_URL: databaseUrl,
        IMAGE_TAG: DEPLOY_TAG,
        MIGRATE_BACKUP_DIR: backupDir,
        MIGRATIONS_FOLDER: folder,
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
  toolDir = await mkdtemp(join(tmpdir(), "adopt-tools-"));
  failingDump = join(toolDir, "pg_dump_fails");
  await writeFile(failingDump, '#!/bin/sh\necho "pg_dump must not run" >&2\nexit 1\n');
  fakeDump = join(toolDir, "pg_dump_ok");
  await writeFile(
    fakeDump,
    '#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) echo dump > "${a#--file=}";; esac; done\nexit 0\n'
  );
  await chmod(failingDump, 0o755);
  await chmod(fakeDump, 0o755);

  const entries = legacyEntries();
  legacyFolder = join(toolDir, "legacy");
  await writeFolder(legacyFolder, entries, legacySql);
  imageFolder = join(toolDir, "image");
  await cp(realFolder, imageFolder, { recursive: true });
  await writeSyntheticBaseline(imageFolder, entries);
}, 60_000);

beforeEach(async () => {
  await withDb((sql) =>
    sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public")
  );
  if (backupDir) await rm(backupDir, { recursive: true, force: true });
  backupDir = await mkdtemp(join(tmpdir(), "adopt-backups-"));
}, 60_000);

afterAll(async () => {
  await rm(toolDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
});

/** A legacy folder cut to the first `count` migrations (a database that stopped there). */
async function legacyUpTo(count: number): Promise<string> {
  const folder = join(toolDir, `legacy-${count}`);
  await rm(folder, { recursive: true, force: true });
  const entries = legacyEntries().slice(0, count);
  await writeFolder(folder, entries, legacySql);
  return folder;
}

describe("baseline equivalence in migrate-on-deploy", () => {
  it("runs the baseline on a fresh database and does not adopt", async () => {
    const result = await runMigrator(fakeDump, imageFolder);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"decision":"fresh"');
    expect(result.stdout).not.toContain("Adopted the baseline");
    expect(await ledgerCount()).toBe(journal.entries.length);
    expect(await tableExists("action_occurrences")).toBe(true);
    expect(await readdir(backupDir)).toHaveLength(1);
    // And once more: the baseline's own row is there, so the legacy classification is not consulted.
    const again = await runMigrator(failingDump, imageFolder, { IMAGE_TAG: "ba9876543210" });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Nothing to migrate");
  });

  it("adopts a database holding the whole legacy history: one dump, no baseline SQL, then a no-op", async () => {
    await applyLegacy(legacyFolder);
    const before = await ledgerCount();
    expect(before).toBe(143);

    const result = await runMigrator(fakeDump, imageFolder);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"decision":"adopt"');
    expect(result.stdout).toContain("Adopted the baseline");
    const dumps = await readdir(backupDir);
    expect(dumps).toHaveLength(1);
    expect(await ledgerCount()).toBe(before! + 1);
    // The baseline's SQL never ran over the existing schema; the legacy tables are untouched.
    expect(await tableExists("action_occurrences")).toBe(false);
    expect(await tableExists("legacy_t0")).toBe(true);

    const again = await runMigrator(failingDump, imageFolder, { IMAGE_TAG: "ba9876543210" });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Nothing to migrate");
    expect(await readdir(backupDir)).toEqual(dumps);
    expect(await ledgerCount()).toBe(before! + 1);
  });

  it("does not refuse a ledger at the last exported legacy migration, or one with a private-only legacy row, as ahead", async () => {
    // 143 rows: 0140 and 0141 are the image's own entries, 0142 is newer than the whole image.
    await applyLegacy(legacyFolder);
    const result = await runMigrator(fakeDump, imageFolder);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("ahead");
  });

  it("still refuses a ledger row that is not part of the legacy history and is newer than the image", async () => {
    await applyLegacy(legacyFolder);
    await withDb(
      (sql) =>
        sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('native', ${PRIVATE_ONLY_WHEN + 1})`
    );
    const before = await ledgerCount();

    const result = await runMigrator(failingDump, imageFolder);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ahead of this image");
    expect(await readdir(backupDir)).toEqual([]);
    expect(await ledgerCount()).toBe(before);
  });

  it("refuses a database stuck at legacy 0138, writing nothing and taking no dump", async () => {
    await applyLegacy(await legacyUpTo(BASELINE_IDX));
    expect(await ledgerCount()).toBe(139);

    const result = await runMigrator(failingDump, imageFolder);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("139 of 140");
    expect(result.stderr).toContain("MIGRATE_ON_DEPLOY=skip");
    expect(result.stderr).not.toContain("legacy_");
    expect(await readdir(backupDir)).toEqual([]);
    expect(await ledgerCount()).toBe(139);
    expect(await tableExists("action_occurrences")).toBe(false);
  });

  it("reports the baseline as applied to read-only callers without writing", async () => {
    await applyLegacy(legacyFolder);
    const before = await ledgerCount();

    const check = await withDb((sql) => checkDatabaseMigrations(sql, imageFolder));

    expect(check).toEqual({ pending: [], skipped: [] });
    expect(await ledgerCount()).toBe(before);
  });

  const realLegacy = process.env.LEGACY_MIGRATIONS_FOLDER;
  it.runIf(realLegacy && existsSync(join(realLegacy, "meta/_journal.json")))(
    "adopts a database built by the real legacy history 0000 to 0141 with the committed baseline.json",
    async () => {
      await applyLegacy(realLegacy!);
      const before = await ledgerCount();
      expect(before).toBe(142);

      const result = await runMigrator(fakeDump, realFolder);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Adopted the baseline");
      expect(await readdir(backupDir)).toHaveLength(1);
      expect(await ledgerCount()).toBe(before! + 1);

      const again = await runMigrator(failingDump, realFolder, { IMAGE_TAG: "ba9876543210" });
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("Nothing to migrate");
      expect(await readdir(backupDir)).toHaveLength(1);
    },
    120_000
  );
});
