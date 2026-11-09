import { databaseUrl } from "@/server/runtime-env";
import { ensureUser } from "./ensure-user";
import { sqlPool, type PoolSql } from "./sql-pool";

/** How long a provider's run rows are kept. */
export const RUN_RETENTION_DAYS = 90;

/**
 * The values `integration_sync_runs` accepts. Its CHECK constraints allow only these triggers and statuses, so a
 * namespaced writer (`import:*`, `ingest:*`, `job:*`, `device:*`) uses `manual` or `scheduled`, never a new word.
 */
export interface RunRecord {
  provider: string;
  trigger: "manual" | "scheduled";
  status: "synced" | "needs_review" | "failed" | "not_configured";
  startedAt: Date;
  finishedAt: Date;
  summary: unknown;
}

/**
 * Records one run, best-effort, and prunes rows older than `RUN_RETENTION_DAYS` for that provider. It never
 * throws: a failed write is logged and the work it describes carries on. It answers whether the row landed. A caller that already holds a pool passes it;
 * the rest write through the portal's own database.
 */
export async function recordRun(run: RunRecord, handle?: PoolSql): Promise<boolean> {
  const url = handle ? undefined : databaseUrl();
  if (!handle && !url) return false;
  let landed = false;
  try {
    const sql = handle ?? sqlPool(url!);
    const userId = await ensureUser(sql);
    await sql`
      INSERT INTO integration_sync_runs (user_id, provider, trigger, started_at, finished_at, status, summary)
      VALUES (${userId}, ${run.provider}, ${run.trigger}, ${run.startedAt.toISOString()}, ${run.finishedAt.toISOString()}, ${run.status}, ${sql.json(run.summary as never)})
    `;
    landed = true;
    await sql`
      DELETE FROM integration_sync_runs
      WHERE user_id=${userId} AND provider=${run.provider} AND started_at < now() - (${RUN_RETENTION_DAYS} * INTERVAL '1 day')
    `;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Run log write failed",
        provider: run.provider,
        errorMessage: error instanceof Error ? error.message : String(error)
      })
    );
  }
  return landed;
}

const lastWritten = new Map<string, number>();
const HOUR_MS = 3_600_000;

/** Forgets what `recordRunThrottled` has written this process: for tests. */
export function resetRunThrottle(): void {
  lastWritten.clear();
}

/**
 * `recordRun`, at most once an hour for one provider and status. A busy path (every refused poll, every bad
 * batch) would otherwise write a row per call. An in-memory map answers the common case; a check of the last
 * row answers it after a restart. A check that fails writes the row anyway.
 */
export async function recordRunThrottled(run: RunRecord, options: { now?: Date; sql?: PoolSql } = {}): Promise<void> {
  const now = options.now ?? new Date();
  const url = options.sql ? undefined : databaseUrl();
  if (!options.sql && !url) return;
  const key = `${run.provider}|${run.status}`;
  const last = lastWritten.get(key);
  if (last !== undefined && now.getTime() - last < HOUR_MS) return;
  // Claim the hour before any await, so two calls arriving together write one row.
  lastWritten.set(key, now.getTime());
  if (lastWritten.size > 200) lastWritten.clear();
  try {
    const sql = options.sql ?? sqlPool(url!);
    const userId = await ensureUser(sql);
    const since = new Date(now.getTime() - HOUR_MS).toISOString();
    const recent = await sql`
      SELECT 1 AS one FROM integration_sync_runs
      WHERE user_id=${userId} AND provider=${run.provider} AND status=${run.status} AND started_at >= ${since}
      LIMIT 1
    `;
    if (recent.length > 0) return;
  } catch {
    // Write the row anyway: a missed check costs at most one extra row.
  }
  // A write that did not land must not mute this provider and status for the hour.
  if (!(await recordRun(run, options.sql))) {
    if (lastWritten.get(key) === now.getTime()) lastWritten.delete(key);
  }
}
