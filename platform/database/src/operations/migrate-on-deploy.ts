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
 * 2. Plan every migration set (`migration-sets.ts`): the core journal, and the add-on journal when
 *    `ADDON_MIGRATIONS_FOLDER` (default ./addon-drizzle) holds one, with its own ledger table. All checks for both
 *    sets run before any write, and each message names its set. Classify the ledger against `meta/baseline.json`
 *    (`baseline-equivalence.ts`): a database holding only part of the history the baseline replaced is refused;
 *    one holding all of it but not the baseline's own row is adopted (step 4b). An add-on baseline may classify
 *    against the core ledger (`legacyLedger: "core"`). Rows of that history never count as "ahead". A set whose
 *    newest applied migration is newer than its journal is refused (a rollback by tag past a migration;
 *    `schemaAheadProblem`); only MIGRATE_ON_DEPLOY=skip, step 0, lets that deploy through. Then fail, touching
 *    nothing, if any migration was skipped: not applied, yet older than one that was, so drizzle would never run it
 *    (`skipped-migrations.ts`; CI's scripts/ci/migration-journal.mjs stops new ones). An add-on ledger with rows but
 *    no add-on folder is refused unless ADDON_MIGRATIONS_OPTOUT=1.
 * 3. Nothing pending and nothing to adopt in either set: exit 0.
 * 4. Otherwise check the backup folder has room, delete abandoned `.partial` dumps over six hours old, take one
 *    `pg_dump --format=custom` of the whole database into /backups, keep the newest five (a failed prune only
 *    warns), and exit non-zero without migrating if the dump fails.
 * 4b. Then, one step at a time and each committed by itself (drizzle cannot nest in an outer transaction): adopt
 *    core's baseline (its ledger row, guarded by the row being absent), migrate core, adopt the add-on baseline,
 *    migrate the add-on. A rerun after a failure finishes what is left.
 *
 * One JSON line per step on stdout/stderr. The database URL and password are never logged or put in pg_dump's
 * arguments (it gets PG* environment variables). A failure exits non-zero and its log line names the failed set
 * and the dump (`restoreFrom`). If no step had committed the database is unchanged (drizzle applies one set's
 * pending migrations in one transaction); otherwise the line says what stays applied. Compose has already
 * stopped and recreated the dependent services, and will not start them until a fixed or previous-tag deploy.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
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
import { preMigrateDumpName, preMigrateDumpsToPrune, stalePartialDumps } from "./pre-migrate-dump.js";
import {
  ADDON_TABLE,
  addonFolder,
  coreLegacyRows,
  ledgerTableDdl,
  loadMigrationSets,
  migratorOptions,
  planSet,
  type MigrationSet,
  type SetPlan
} from "./migration-sets.js";
import { readLedgerRows, skippedMigrationsMessage } from "./skipped-migrations.js";
import { dbWaitMs, waitForDatabase } from "./wait-for-database.js";

const run = promisify(execFile);
const databaseUrl = process.env.DATABASE_URL;
const backupDir = process.env.MIGRATE_BACKUP_DIR ?? "/backups";
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
    const rows = await withRetry(
      async () => {
        await sql`SELECT pg_advisory_lock(${MIGRATE_LOCK_KEY}::bigint)`;
        return { core: await readLedgerRows(sql), addon: await readLedgerRows(sql, ADDON_TABLE) };
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

    // Every check, for both sets, before any write. Core is first throughout.
    const { core, addon, all } = loadMigrationSets();
    if (!addon && rows.addon.length > 0) {
      const message = `The add-on ledger (drizzle.${ADDON_TABLE}) holds ${rows.addon.length} rows but no add-on migrations were found at ${addonFolder()}. Starting without them would leave the add-on tables unmanaged: restore the add-on folder, or set ADDON_MIGRATIONS_OPTOUT=1 to run core only.`;
      if (process.env.ADDON_MIGRATIONS_OPTOUT !== "1") throw new Error(message);
      log("warn", "ADDON_MIGRATIONS_OPTOUT=1: running core migrations only; the add-on ledger is left as it is");
    }
    const ledgerRows = (set: MigrationSet) => (set.name === "core" ? rows.core : rows.addon);
    const plans = all.map((set) => planSet(set, ledgerRows(set), coreLegacyRows(core, rows.core)));
    for (const plan of plans) {
      if (!plan.decision) continue;
      log("info", "Classified the database against the baseline's replaced history", {
        set: plan.set.name,
        decision: plan.decision.action,
        state: plan.decision.classification.state,
        matched: plan.decision.classification.matched,
        total: plan.decision.classification.total
      });
    }
    for (const plan of plans) if (plan.problem) throw new Error(plan.problem);
    for (const plan of plans) {
      // A first run on an empty database lists the whole journal; the newest few say enough.
      const newest = plan.pending.slice(-10);
      log("info", "Checked for pending migrations", {
        set: plan.set.name,
        imageTag,
        pending: plan.pending.length,
        newest
      });
    }
    for (const plan of plans) if (plan.skipped.length > 0) throw new Error(setSkippedMessage(plan));
    const work = plans.filter((plan) => plan.pending.length > 0 || plan.adopt);
    if (work.length === 0) {
      log("info", "Nothing to migrate");
      return;
    }

    const dump = join(backupDir, await takeDump(databaseUrl));
    progress.dump = dump;
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

    // Sequential steps, each committed by itself (drizzle's migrator cannot nest in an outer transaction):
    // adopt core, migrate core, adopt add-on, migrate add-on. The dump is the all-or-nothing restore point;
    // a rerun is safe because adoption is guarded by the hash row being absent and drizzle skips what it ran.
    for (const plan of work) {
      const name = plan.set.name;
      progress.set = name;
      if (plan.adopt) {
        // Drizzle's own ledger shape (0.45): id serial, hash text, created_at bigint. Guarded by the hash being
        // absent, so a rerun, or a second migrator that got past the lock, inserts nothing.
        await sql.unsafe(ledgerTableDdl(plan.set.table));
        const adopted = plan.adopt;
        const inserted = await sql.begin((tx) =>
          tx.unsafe(
            `INSERT INTO drizzle."${plan.set.table}" (hash, created_at)
             SELECT $1::text, $2::bigint
             WHERE NOT EXISTS (SELECT 1 FROM drizzle."${plan.set.table}" WHERE hash = $1::text)
             RETURNING id`,
            [adopted.hash, adopted.createdAt]
          )
        );
        progress.committed.push(`${name} adoption`);
        log("info", "Adopted the baseline: the database already holds the history it replaces; no SQL run", {
          set: name,
          tag: adopted.baselineTag,
          inserted: inserted.length,
          restoreFrom: dump
        });
      }
      await migrate(drizzle(sql), migratorOptions(plan.set));
      progress.committed.push(`${name} migrations`);
      log("info", "Applied migrations", {
        set: name,
        applied: plan.pending.length,
        adopted: Boolean(plan.adopt),
        newest: plan.pending.slice(-10),
        restoreFrom: dump
      });
    }
  } finally {
    // Ending the session releases the lock too; the explicit unlock only matters if end() were to be slow.
    await sql`SELECT pg_advisory_unlock(${MIGRATE_LOCK_KEY}::bigint)`.catch(() => undefined);
    await sql.end();
  }
}

/** What the run has done, for the failure line: which set was in progress, what already committed, the dump. */
const progress: { set?: string; dump?: string; committed: string[] } = { committed: [] };

main().catch((error) => {
  const unchanged = progress.committed.length === 0;
  log(
    "error",
    unchanged
      ? "Migration failed; the database is unchanged, and the dependent services were stopped by the recreate and will not start until a fixed or previous-tag deploy"
      : `Migration failed in the ${progress.set ?? "unknown"} set after ${progress.committed.join(", ")} had committed, so the database is partly migrated (a rerun after a fix finishes the rest; restoreFrom undoes everything). The dependent services were stopped by the recreate and will not start until a fixed or previous-tag deploy`,
    {
      ...(progress.set ? { set: progress.set } : {}),
      ...(progress.dump ? { restoreFrom: progress.dump } : {}),
      error: describeError(error, secrets())
    }
  );
  process.exitCode = 1;
});

function setSkippedMessage(plan: SetPlan): string {
  return skippedMigrationsMessage(plan.skipped, plan.set.table);
}

function isLockTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "55P03";
}
