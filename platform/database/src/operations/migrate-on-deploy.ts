/**
 * The deploy's migration step: the `migrate` service in compose.yaml runs this once per deploy, and the
 * portal, worker and the add-on services wait for it to exit 0 (`service_completed_successfully`).
 *
 * 0. When it is about to migrate (including a dev tag against the bundled `postgres` host), it first waits for the
 *    database to accept connections, up to `MIGRATE_DB_WAIT_SECONDS` (default 90).
 *    `MIGRATE_ON_DEPLOY=skip` (rollback to a pre-feature tag), or a local `dev` image that is not a deploy
 *    (see `migrateOnDeployMode`): log that and exit 0, touching nothing.
 * 1. Connect (with lock_timeout 30s, statement_timeout 15min, idle_in_transaction_session_timeout 5min; retried for about 30 s) and take a session advisory lock, so a second migrator waits and then
 *    finds nothing pending. The lock is held on the one connection through steps 2 to 5.
 * 2. Ask the database which journal migrations are pending (the same check the portal's health route uses).
 *    A database whose newest applied migration is newer than this image's journal is refused (a rollback by
 *    tag past a migration; `schemaAheadProblem`); only MIGRATE_ON_DEPLOY=skip, step 0, lets that deploy through.
 *    Then fail, touching nothing, if any migration was skipped: not applied, yet older than one that was, so
 *    drizzle would never run it (`skipped-migrations.ts`; CI's scripts/ci/migration-journal.mjs stops new ones).
 * 3. Nothing pending: exit 0.
 * 4. Otherwise check the backup folder has room, delete abandoned `.partial` dumps over six hours old, take a
 *    `pg_dump --format=custom` into /backups, keep the newest five (a failed prune only warns), and exit
 *    non-zero without migrating if the dump fails.
 * 5. Run drizzle's migrator exactly as `migrate.ts` does.
 *
 * One JSON line per step on stdout/stderr. The database URL and password are never logged or put in pg_dump's
 * arguments (it gets PG* environment variables). A failure exits non-zero and
 * the database is unchanged (drizzle applies the pending migrations in one transaction); compose has already
 * stopped and recreated the dependent services, and will not start them until a fixed or previous-tag deploy.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  CONNECT_RETRY_DELAYS_MS,
  MIGRATOR_CONNECTION_OPTIONS,
  describeError,
  freeSpaceProblem,
  pgEnvFromUrl,
  withRetry
} from "./migrate-helpers.js";
import { BUNDLED_DATABASE_HOST, migrateOnDeployMode } from "./migrate-skip.js";
import {
  appliedMigrationTimestamp,
  imageNewestMigration,
  pendingTagsAfter,
  schemaAheadProblem
} from "./pending-migrations.js";
import { preMigrateDumpName, preMigrateDumpsToPrune, stalePartialDumps } from "./pre-migrate-dump.js";
import { checkDatabaseMigrations, skippedMigrationsMessage } from "./skipped-migrations.js";
import { dbWaitMs, waitForDatabase } from "./wait-for-database.js";

const run = promisify(execFile);
const databaseUrl = process.env.DATABASE_URL;
const backupDir = process.env.MIGRATE_BACKUP_DIR ?? "/backups";
const migrationsFolder = process.env.MIGRATIONS_FOLDER ?? resolve(process.cwd(), "drizzle");
const imageTag = process.env.IMAGE_TAG || "dev";
/** The pg_dump to run; overridable so the integration test can stand in a failing or a fake one. */
const pgDumpPath = process.env.PG_DUMP_PATH || "pg_dump";

/**
 * The key of the session advisory lock that serialises migrators (an arbitrary constant, unique to this
 * job within the database; other code that takes advisory locks must pick a different one). Two deploys
 * overlapping would otherwise both see the same pending list and both dump and migrate.
 */
const MIGRATE_LOCK_KEY = "7203457001";

function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, message, service: "migrate", ...fields });
  (level === "info" ? process.stdout : process.stderr).write(`${line}\n`);
}

/** What must never reach a log line: the database URL and the password inside it. */
function secrets(): string[] {
  if (!databaseUrl) return [];
  const password = pgEnvFromUrlSafe().PGPASSWORD;
  return password ? [databaseUrl, password] : [databaseUrl];
}

function pgEnvFromUrlSafe(): Record<string, string> {
  try {
    return databaseUrl ? pgEnvFromUrl(databaseUrl) : {};
  } catch {
    return {};
  }
}

function safeMessage(error: unknown): string {
  return describeError(error, secrets()).message;
}

/** Delete `.partial` files an earlier killed run left behind; the pruning of finished dumps never sees them. */
async function removeAbandonedPartials(): Promise<string[]> {
  const files: { name: string; mtimeMs: number }[] = [];
  for (const name of await readdir(backupDir)) {
    if (!name.endsWith(".partial")) continue;
    // A run that finishes between the listing and the stat has renamed its file away; that is not an error.
    const info = await stat(join(backupDir, name)).catch(() => null);
    if (info) files.push({ name, mtimeMs: info.mtimeMs });
  }
  const stale = stalePartialDumps(files, Date.now());
  for (const name of stale) await rm(join(backupDir, name), { force: true });
  return stale;
}

async function takeDump(url: string): Promise<string> {
  await mkdir(backupDir, { recursive: true });
  const space = await statfs(backupDir);
  const problem = freeSpaceProblem(space.bavail * space.bsize);
  if (problem) throw new Error(`No pre-migration dump taken: ${problem}`);
  const abandoned = await removeAbandonedPartials();
  if (abandoned.length > 0) log("info", "Removed abandoned partial dumps", { removed: abandoned });
  const name = preMigrateDumpName(new Date(), imageTag);
  const finalPath = join(backupDir, name);
  const partialPath = `${finalPath}.partial`;
  try {
    // Connection parameters travel as PG* variables, never in argv, where the password would show in `ps`.
    await run(pgDumpPath, ["--format=custom", `--file=${partialPath}`], {
      maxBuffer: 1024 * 1024,
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...pgEnvFromUrl(url) }
    });
    await rename(partialPath, finalPath);
  } catch (error) {
    await rm(partialPath, { force: true });
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
    throw new Error(`pg_dump failed: ${safeMessage(stderr || error)}`);
  }
  return name;
}

async function pruneDumps(): Promise<string[]> {
  const stale = preMigrateDumpsToPrune(await readdir(backupDir));
  for (const name of stale) await rm(join(backupDir, name), { force: true });
  return stale;
}

/** The host of `DATABASE_URL`, or undefined when it is missing or unparseable (the later connect reports that). */
function databaseHost(): string | undefined {
  try {
    return databaseUrl ? new URL(databaseUrl).hostname : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const host = databaseHost();
  const mode = migrateOnDeployMode(process.env.MIGRATE_ON_DEPLOY, process.env.IMAGE_TAG, host);
  if (mode === "skip") {
    log(
      "info",
      "MIGRATE_ON_DEPLOY=skip: no dump and no migration (a rollback after a restore, or a manual deploy from an unmerged tree); if it is set in .env, remove it after this deploy",
      {
        imageTag
      }
    );
    return;
  }
  if (mode === "local") {
    log(
      "info",
      "Not a deploy (IMAGE_TAG is not a 12-character commit sha): no dump and no migration (MIGRATE_ON_DEPLOY=apply overrides)",
      {
        imageTag
      }
    );
    return;
  }
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  process.umask(0o077);
  await waitForDatabase(databaseUrl, {
    timeoutMs: dbWaitMs(process.env.MIGRATE_DB_WAIT_SECONDS),
    intervalMs: 2_000,
    secrets: secrets(),
    onWaiting: (waitedMs) =>
      log("info", "Waiting for the database to accept connections", {
        waitedSeconds: Math.round(waitedMs / 1000),
        bundled: host === BUNDLED_DATABASE_HOST
      })
  });

  // One connection for the whole run, because the advisory lock belongs to its session. Postgres NOTICEs
  // (identifier truncation in old migrations) are dropped so the log stays one JSON line per step.
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 15,
    connection: { ...MIGRATOR_CONNECTION_OPTIONS },
    onnotice: () => undefined
  });
  try {
    // A database that is restarting or briefly unreachable should not fail the deploy on the first try.
    // Taking the lock first means a second migrator waits here, then finds nothing pending.
    const applied = await withRetry(
      async () => {
        await sql`SELECT pg_advisory_lock(${MIGRATE_LOCK_KEY}::bigint)`;
        return appliedMigrationTimestamp(sql);
      },
      {
        delaysMs: CONNECT_RETRY_DELAYS_MS,
        onRetry: (error, attempt, delayMs) =>
          // 55P03 is lock_not_available: lock_timeout expired waiting for another migrator, not a connection fault.
          log(
            "warn",
            isLockTimeout(error)
              ? "Another migrator holds the lock; retrying"
              : "Could not reach the database; retrying",
            {
              attempt,
              retryInMs: delayMs,
              error: describeError(error, secrets())
            }
          )
      }
    );
    const aheadProblem = schemaAheadProblem(applied, imageNewestMigration());
    if (aheadProblem) throw new Error(aheadProblem);
    const pending = pendingTagsAfter(applied);
    // A first run on an empty database lists the whole journal; the newest few say enough.
    const newest = pending.slice(-10);
    log("info", "Checked for pending migrations", { imageTag, pending: pending.length, newest });
    const { skipped } = await checkDatabaseMigrations(sql, migrationsFolder);
    if (skipped.length > 0) throw new Error(skippedMigrationsMessage(skipped));
    if (pending.length === 0) {
      log("info", "Nothing to migrate");
      return;
    }

    const dump = join(backupDir, await takeDump(databaseUrl));
    // The dump is safe on disk; failing to tidy old ones must not stop the migration it exists to protect.
    let pruned: string[] = [];
    try {
      pruned = await pruneDumps();
    } catch (error) {
      log("warn", "Could not prune old pre-migration dumps; continuing", {
        error: describeError(error, secrets())
      });
    }
    log("info", "Took pre-migration dump", { file: dump, pruned });

    await migrate(drizzle(sql), { migrationsFolder });
    log("info", "Applied migrations", { applied: pending.length, newest, restoreFrom: dump });
  } finally {
    // Ending the session releases the lock too; the explicit unlock only matters if end() were to be slow.
    await sql`SELECT pg_advisory_unlock(${MIGRATE_LOCK_KEY}::bigint)`.catch(() => undefined);
    await sql.end();
  }
}

main().catch((error) => {
  log(
    "error",
    "Migration failed; the database is unchanged, and the dependent services were stopped by the recreate and will not start until a fixed or previous-tag deploy",
    { error: describeError(error, secrets()) }
  );
  process.exitCode = 1;
});

function isLockTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "55P03";
}
