// Records each scheduled backup run in integration_sync_runs so the portal can show it. Best effort only: scheduled.mjs
// wraps this so a recording failure can never fail, delay or hide the backup. The summary holds booleans and a size,
// never paths, hostnames or error text. the design notes
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_WARNINGS } from "./schedule.mjs";

/** 'synced' for a clean run, 'needs_review' when the backup completed with a warning, 'failed' otherwise. */
export function statusForRun(code, summary) {
  if (code === 0 && !summary?.warnings?.length) return "synced";
  if (code === 0 || code === EXIT_WARNINGS) return "needs_review";
  return "failed";
}

/** The non-sensitive facts of a run. copyVerified and restoreVerified are true only when the summary says so. */
export function summaryForRun(summary) {
  return {
    backupBytes: Number.isFinite(summary?.backupBytes) ? summary.backupBytes : null,
    copyVerified: Boolean(summary?.copiedTo) && !summary?.warnings?.length,
    restoreVerified: summary?.verified === true
  };
}

/**
 * Inserts one 'backup' row for the single owner (the oldest user, as ensureUser reads it). Returns false when there is
 * no user yet. `run` is { code, summary, startedAt, finishedAt }; `sql` is a postgres.js tagged template.
 */
export async function recordRun(sql, run) {
  const [owner] = await sql`SELECT id FROM users ORDER BY created_at LIMIT 1`;
  if (!owner) return false;
  const status = statusForRun(run.code, run.summary);
  const summary = JSON.stringify(summaryForRun(run.summary));
  await sql`
    INSERT INTO integration_sync_runs (user_id, provider, trigger, started_at, finished_at, status, summary)
    VALUES (${owner.id}, 'backup', 'scheduled', ${run.startedAt}, ${run.finishedAt}, ${status}, ${summary}::jsonb)`;
  return true;
}

/** Opens a short-lived connection with the postgres driver that ships in the image's @openrhen/database package. */
export async function recordRunToDatabase(url, run) {
  const require = createRequire(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../platform/database/package.json")
  );
  const { default: postgres } = await import(require.resolve("postgres"));
  const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    return await recordRun(sql, run);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
