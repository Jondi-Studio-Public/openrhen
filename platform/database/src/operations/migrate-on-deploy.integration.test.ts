import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import postgres from "postgres";
import { execFile } from "node:child_process";
import { chmod, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import journal from "../../drizzle/meta/_journal.json" with { type: "json" };
import { integrationDatabaseName } from "./integration-database.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const run = promisify(execFile);
const adminUrl = process.env.POSTGRES_ADMIN_URL;
const databaseName = integrationDatabaseName(process.env.MIGRATE_ON_DEPLOY_TEST_DATABASE_NAME, "openrhen_migrate");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(databaseName)) {
  throw new Error("MIGRATE_ON_DEPLOY_TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${databaseName}`;
const databaseUrl = testUrl.toString();

const entry = resolve(process.cwd(), "src/operations/migrate-on-deploy.ts");
// A 12-character commit sha, the form the deploy gives images; anything else is a local run that migrates nothing.
const DEPLOY_TAG = "0123456789ab";

let backupDir: string;
let toolDir: string;
let failingDump: string;
let fakeDump: string;

/** The real entry point, as a deploy runs it, with pg_dump swapped for a stand-in. */
async function runMigrator(pgDump: string, extra: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", entry], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        DATABASE_URL: databaseUrl,
        IMAGE_TAG: DEPLOY_TAG,
        MIGRATE_BACKUP_DIR: backupDir,
        MIGRATIONS_FOLDER: resolve(process.cwd(), "drizzle"),
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

async function appliedMigrations(): Promise<number | null> {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => undefined });
  try {
    const rows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`;
    return Number(rows[0]?.count);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "42P01") return null;
    throw error;
  } finally {
    await sql.end();
  }
}

async function recreateDatabase() {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10, onnotice: () => undefined });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

/**
 * Empties the database between tests without recreating it: CREATE DATABASE copies a template and
 * checkpoints, which on a busy runner outlasts a hook, and a timed-out create left running then
 * collides with the next. The migrations create nothing outside `public` and `drizzle`.
 */
async function emptyDatabase() {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => undefined });
  try {
    await sql.unsafe(
      "DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public"
    );
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await recreateDatabase();
  toolDir = await mkdtemp(join(tmpdir(), "migrate-tools-"));
  // Writes half a file where --file points, then dies, as a pg_dump killed by a full disk would.
  failingDump = join(toolDir, "pg_dump_fails");
  await writeFile(
    failingDump,
    '#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) echo partial > "${a#--file=}";; esac; done\necho "pg_dump: error: boom" >&2\nexit 1\n'
  );
  // Writes a small valid-looking file and records that it was given no password in its arguments.
  fakeDump = join(toolDir, "pg_dump_ok");
  await writeFile(
    fakeDump,
    `#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) echo dump > "\${a#--file=}";; esac; done\necho "$PGDATABASE" > "${toolDir}/seen-database"\necho "$*" > "${toolDir}/seen-args"\nexit 0\n`
  );
  await chmod(failingDump, 0o755);
  await chmod(fakeDump, 0o755);
}, 60_000);

beforeEach(async () => {
  await emptyDatabase();
  if (backupDir) await rm(backupDir, { recursive: true, force: true });
  backupDir = await mkdtemp(join(tmpdir(), "migrate-backups-"));
}, 60_000);

afterAll(async () => {
  await rm(toolDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
});

describe("migrate-on-deploy main flow", () => {
  it("migrates nothing and leaves no partial dump when pg_dump fails", async () => {
    const result = await runMigrator(failingDump);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pg_dump failed");
    expect(result.stderr).toContain("boom");
    expect(await readdir(backupDir)).toEqual([]);
    expect(await appliedMigrations()).toBeNull();
  });

  it("dumps first, then applies every pending migration, and passes the database by environment", async () => {
    const result = await runMigrator(fakeDump);

    expect(result.code).toBe(0);
    const files = await readdir(backupDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^pre-migrate-\\d{8}T\\d{6}Z-${DEPLOY_TAG}\\.dump$`));
    // One row per journal entry, whatever the history length (the full tree has many; the OpenRhen baseline has one).
    expect(await appliedMigrations()).toBe(journal.entries.length);
    expect((await readFile(join(toolDir, "seen-database"), "utf8")).trim()).toBe(databaseName);
    expect(await readFile(join(toolDir, "seen-args"), "utf8")).not.toContain("postgres");

    // A second deploy finds nothing pending and takes no dump.
    const again = await runMigrator(failingDump, { IMAGE_TAG: "ba9876543210" });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Nothing to migrate");
    expect(await readdir(backupDir)).toEqual(files);
  });

  it("touches nothing for a tag that is not a deploy", async () => {
    const result = await runMigrator(fakeDump, { IMAGE_TAG: "dev" });

    expect(result.code).toBe(0);
    expect(await readdir(backupDir)).toEqual([]);
    expect(await appliedMigrations()).toBeNull();
  });

  it("waits while the database does not exist yet, then migrates once it is created", async () => {
    const lateName = `${databaseName.replace(/_test$/, "")}_late_test`;
    const lateUrl = new URL(databaseUrl);
    lateUrl.pathname = `/${lateName}`;
    const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10, onnotice: () => undefined });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${lateName}" WITH (FORCE)`);
      const waiting = runMigrator(fakeDump, { DATABASE_URL: lateUrl.toString(), MIGRATE_DB_WAIT_SECONDS: "60" });
      await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
      // Still waiting: nothing dumped while the database is missing.
      expect(await readdir(backupDir)).toEqual([]);
      await admin.unsafe(`CREATE DATABASE "${lateName}"`);
      const result = await waiting;
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Applied migrations");
      expect(result.stdout + result.stderr).not.toContain(lateUrl.toString());
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${lateName}" WITH (FORCE)`);
      await admin.end();
    }
  }, 90_000);

  it("gives up with a safe message when the database never comes up", async () => {
    const refused = new URL(databaseUrl);
    // Port 1 on loopback refuses at once.
    refused.hostname = "127.0.0.1";
    refused.port = "1";
    const result = await runMigrator(fakeDump, { DATABASE_URL: refused.toString(), MIGRATE_DB_WAIT_SECONDS: "3" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("did not accept connections within 3 s");
    expect(result.stderr).not.toContain(refused.toString());
    expect(await readdir(backupDir)).toEqual([]);
  }, 30_000);

  it("waits while another migrator holds the lock", async () => {
    const holder = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
    try {
      await holder`SELECT pg_advisory_lock(7203457001::bigint)`;
      const waiting = runMigrator(fakeDump);
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      // While the lock is held nothing has been dumped or applied.
      expect(await readdir(backupDir)).toEqual([]);
      expect(await appliedMigrations()).toBeNull();
      await holder`SELECT pg_advisory_unlock(7203457001::bigint)`;
      expect((await waiting).code).toBe(0);
    } finally {
      await holder.end();
    }
    expect(await readdir(backupDir)).toHaveLength(1);
  });

  it("lets two overlapping deploys dump and migrate once between them", async () => {
    const [first, second] = await Promise.all([
      runMigrator(fakeDump),
      runMigrator(fakeDump, { IMAGE_TAG: "ba9876543210" })
    ]);

    expect([first.code, second.code]).toEqual([0, 0]);
    expect(await readdir(backupDir)).toHaveLength(1);
    expect(first.stdout + second.stdout).toContain("Nothing to migrate");
  });

  it("fails, dumping and applying nothing, when a migration older than an applied one was skipped", async () => {
    expect((await runMigrator(fakeDump)).code).toBe(0);
    const dumps = await readdir(backupDir);
    // What drizzle leaves behind when a journal entry is stamped older than one already deployed: the folder this
    // deploy carries has an entry that is older than everything applied and was never applied itself.
    const skippedFolder = join(toolDir, "drizzle-with-skipped");
    await rm(skippedFolder, { recursive: true, force: true });
    await cp(resolve(process.cwd(), "drizzle"), skippedFolder, { recursive: true });
    const oldest = Math.min(...journal.entries.map((entry) => entry.when));
    await writeFile(join(skippedFolder, "0000_stamped_too_old.sql"), "SELECT 1;\n");
    await writeFile(
      join(skippedFolder, "meta/_journal.json"),
      JSON.stringify({
        ...journal,
        entries: [
          { idx: -1, version: "7", when: oldest - 1000, tag: "0000_stamped_too_old", breakpoints: true },
          ...journal.entries
        ]
      })
    );
    const applied = await appliedMigrations();

    const result = await runMigrator(fakeDump, { IMAGE_TAG: "ba9876543210", MIGRATIONS_FOLDER: skippedFolder });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("1 migration was skipped");
    expect(await readdir(backupDir)).toEqual(dumps);
    expect(await appliedMigrations()).toBe(applied);
  });
});
