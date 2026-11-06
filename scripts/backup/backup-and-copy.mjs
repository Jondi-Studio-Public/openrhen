#!/usr/bin/env node
// One scheduled backup run: create, verify, copy off this machine, prune both sides, report.
//
// The database lives on the LAN host and the only backups that existed were whatever someone
// remembered to run by hand into var/backups, on this machine, beside nothing that would survive
// its disk. This script is the unattended version of that routine, and it is deliberately built
// out of the two commands the operations guide already documents rather than a second backup path:
// `db:backup` writes the file, `db:restore:verify` proves it restores. A backup nobody has restored
// is a guess.
//
// The copy is NOT encrypted - that is a decision, not an omission. BACKUP_COPY_DIR should therefore
// point somewhere whose access you are willing to treat as access to the planner database.
//
//   node scripts/backup/backup-and-copy.mjs
//
//   BACKUP_COPY_DIR      where the verified backup is copied (a mapped NAS/share). Unset: the backup stays on this machine,
//                        the run is ok with localOnly: true (the Data check says so), exit 0.
//   BACKUP_COPY          "off": local-only backups chosen on purpose; copy, photo sync and guard skipped with one
//                        info line, exit 0 (BACKUP_COPY_DIR is then ignored).
//                        Needs .openrhen-backup-target at its root and max(5 GB, 3 x backup) free, else the run fails.
//   BACKUP_KEEP_LOCAL    how many files stay in var/backups (default 14)
//   BACKUP_KEEP_COPIES   how many files stay in BACKUP_COPY_DIR (default 60)
//   PHOTO_STORE_HOST_DIR where the photo blobs live on this machine (default var/photos); copied add-only to
//                        BACKUP_COPY_DIR/photos and never pruned, because photos are kept indefinitely
import { spawn } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBlobs } from "./photo-sync.mjs";
import { copyVerified } from "./copy-verified.mjs";
import { copyDisabled, EXIT_WARNINGS } from "./schedule.mjs";
import { assertBackupTarget } from "./target-guard.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const copyOptedOut = copyDisabled(process.env);
const copyDirectory = copyOptedOut ? undefined : process.env.BACKUP_COPY_DIR?.trim();
const keepLocal = positiveInteger(process.env.BACKUP_KEEP_LOCAL, 14);
const keepCopies = positiveInteger(process.env.BACKUP_KEEP_COPIES, 60);
const startedAt = Date.now();
const warnings = [];

// The names `db:backup` writes, and the only names pruning will ever delete.
const BACKUP_FILENAME = /^(?:priorities|openrhen)-.*\.json$/;
// Node refuses to spawn a .cmd without a shell on Windows, and pnpm is a .cmd there.
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

try {
  const created = await createBackup();
  // Photos are copied before the restore check, which fails when a photo the backup names is missing from the
  // copy folder: after a new photo it would otherwise fail every run before the copy that would fix it. The
  // copy is add-only, so doing it first can never lose anything.
  // Nothing is written to the copy folder until it is proven to be the mounted share with room to spare.
  const written = await stat(created.backup);
  if (copyDirectory) await assertBackupTarget(copyDirectory, { backupBytes: written.size });
  const photos = await copyPhotos();
  const restoreChecked = await verifyBackup(created.backup);
  const copiedTo = await copyBackup(created.backup);
  const prunedLocal = await prune(dirname(created.backup), keepLocal);
  const prunedCopies = copyDirectory ? await prune(copyDirectory, keepCopies) : 0;
  summarise("ok", {
    backup: created.backup,
    backupBytes: written.size,
    records: created.records,
    verified: restoreChecked,
    ...(restoreChecked ? {} : { restoreSkipped: true }),
    ...(copiedTo ? { copiedTo } : {}),
    ...(!copiedTo && !copyOptedOut ? { localOnly: true } : {}),
    ...(photos ? { photos } : {}),
    prunedLocal,
    prunedCopies,
    ...(warnings.length ? { warnings } : {})
  });
  // Distinct from failure (1) so the scheduler can tell "backup exists but look at it" and ping /fail.
  if (warnings.length) process.exit(EXIT_WARNINGS);
} catch (error) {
  summarise("failed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}

/**
 * Runs the workspace backup command and reads back which file it wrote. `db:backup` already prints
 * a JSON line naming the path, the record count, and the checksum, so parsing that is how this stays
 * a caller of the documented command rather than a second implementation of it.
 */
async function createBackup() {
  const output = await run(PNPM, ["db:backup"]);
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.trim().startsWith("{"));
  if (!line) throw new Error("db:backup produced no JSON summary; the backup file is unknown.");
  const parsed = JSON.parse(line);
  if (typeof parsed.backup !== "string") throw new Error("db:backup summary did not name a backup file.");
  await stat(parsed.backup);
  return { backup: resolve(parsed.backup), records: parsed.records ?? null };
}

/**
 * Restores this exact file into the isolated `_restore_test` database and compares every row count.
 * BACKUP_FILE is set explicitly rather than relying on "newest wins", so a backup written by another
 * process mid-run cannot be verified in place of the one this run just made.
 */
async function verifyBackup(backupPath) {
  // The restore check needs the admin connection to make the scratch database. Without it the backup still ran, so
  // skip the check but say so loudly (a warning, which pings /fail and shows in the Data check); never skip silently.
  if (!process.env.POSTGRES_ADMIN_URL?.trim()) {
    warnings.push(
      "POSTGRES_ADMIN_URL is not set, so this backup was not restore-tested. Set it in .env (setup writes one) to turn the check on."
    );
    return false;
  }
  await run(PNPM, ["db:restore:verify"], { BACKUP_FILE: backupPath });
  return true;
}

/** Copies new photo blobs beside the backup, add-only. A size mismatch is a failure: it would look like protection. */
async function copyPhotos() {
  if (!copyDirectory) return null;
  const source = resolve(process.env.PHOTO_STORE_HOST_DIR?.trim() || resolve(root, "var/photos"));
  const result = await syncBlobs(source, resolve(copyDirectory, "photos"));
  if (result.mismatched.length > 0)
    throw new Error(
      `${result.mismatched.length} photo copies differ in size from the originals; the destination is unreliable.`
    );
  return result;
}

async function copyBackup(backupPath) {
  if (copyOptedOut) {
    process.stdout.write(
      `${JSON.stringify({ level: "info", message: "BACKUP_COPY=off: no off-machine copy; this backup exists only on this machine." })}\n`
    );
    return null;
  }
  if (!copyDirectory) {
    // The default install has no second place to copy to. That is reported (localOnly), not a failure.
    process.stdout.write(
      `${JSON.stringify({ level: "info", message: "No BACKUP_COPY_DIR: this backup exists only on this machine." })}\n`
    );
    return null;
  }
  // A copy that silently truncated is worse than no copy, because it looks like protection, so it
  // is written to a .partial name, checked by sha256 and only then renamed (S8-10).
  return copyVerified(backupPath, copyDirectory);
}

/**
 * Keeps the newest `keep` backups in a directory and deletes the rest.
 *
 * Ordering is by filename, not mtime: the name carries the ISO timestamp the backup was taken at,
 * while a copied file's mtime is when the copy happened. Only files matching the backup naming
 * pattern are ever considered, so nothing else sharing the directory can be deleted by this.
 */
async function prune(directory, keep) {
  const files = (await readdir(directory)).filter((name) => BACKUP_FILENAME.test(name)).sort();
  const doomed = files.slice(0, Math.max(0, files.length - keep));
  for (const name of doomed) await rm(resolve(directory, name));
  return doomed.length;
}

// Windows needs a shell to run pnpm at all, and passing an args array through one is deprecated, so
// the command goes as a single string. Every argument here is a literal defined above - nothing from
// the environment or the command line is ever concatenated into it.
function run(command, args, extraEnv = {}) {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    const child = spawn([command, ...args].join(" "), {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      shell: true
    });
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise(output)
        : reject(new Error(`${command} ${args.join(" ")} exited with code ${code}: ${lastLine(output)}`))
    );
  });
}

function lastLine(output) {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? "no output"
  );
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** One line, the same JSON shape the services log, so a scheduled run is greppable next to them. */
function summarise(status, fields) {
  const line = JSON.stringify({
    level: status === "ok" ? "info" : "error",
    message: "Scheduled backup",
    status,
    durationMs: Date.now() - startedAt,
    ...fields
  });
  if (status === "ok") process.stdout.write(`${line}\n`);
  else process.stderr.write(`${line}\n`);
}
