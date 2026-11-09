import { databaseUrl } from "@/server/runtime-env";
import { ensureUser } from "./ensure-user";
import { sqlPool } from "./sql-pool";

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
 * throws: a failed write is logged and the work it describes carries on.
 */
export async function recordRun(run: RunRecord): Promise<void> {
  const url = databaseUrl();
  if (!url) return;
  try {
    const sql = sqlPool(url);
    const userId = await ensureUser(sql);
    await sql`
      INSERT INTO integration_sync_runs (user_id, provider, trigger, started_at, finished_at, status, summary)
      VALUES (${userId}, ${run.provider}, ${run.trigger}, ${run.startedAt.toISOString()}, ${run.finishedAt.toISOString()}, ${run.status}, ${sql.json(run.summary as never)})
    `;
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
}
