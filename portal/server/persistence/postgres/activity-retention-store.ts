import { ACTIVITY_PURGE_BATCH } from "@openrhen/contracts";
import { markSourceGoneTx } from "./derived-source-gone-store";
import type { TxSql } from "./sql-pool";

/**
 * The retention purge, one person at a time inside the caller's transaction (the derived tick's, which already holds
 * the per-person activity lock, or `purgeExpiredActivity`'s own). Permanent by default: it looks only at sources whose
 * `activity_source_state.retention_days` is set, so a source with no setting, or no state row at all, is never touched.
 * Rows of source `derived` and `derived-shadow` are never deleted by retention (the classification history stays for
 * the predictor), and retention does not use the lineage delete helper: derived rows outlive their source. Before a batch of source rows
 * goes, `source_gone` is appended for the still-open facts whose last sources are in that batch, in the same
 * transaction. Work per call is bounded by `maxBatches` of `ACTIVITY_PURGE_BATCH` rows; what is left waits for the next call.
 */

/** Batches one derived tick may delete, across all sources. */
export const RETENTION_BATCHES_PER_TICK = 4;

export interface RetentionSourceResult {
  source: string;
  removed: number;
}

export interface RetentionPassResult {
  removed: number;
  sources: RetentionSourceResult[];
  /** True when the batch budget ran out with work probably left, so the caller should come back soon. */
  more: boolean;
}

export async function purgeExpiredForUserTx(
  tx: TxSql,
  userId: string,
  now: Date,
  maxBatches: number = RETENTION_BATCHES_PER_TICK
): Promise<RetentionPassResult> {
  const states = await tx<{ source: string; retention_days: number }[]>`
    SELECT source, retention_days FROM activity_source_state
    WHERE user_id = ${userId} AND retention_days IS NOT NULL AND source NOT IN ('derived', 'derived-shadow')
    ORDER BY source`;
  const sources: RetentionSourceResult[] = [];
  let budget = maxBatches;
  let more = false;
  for (const state of states) {
    if (budget <= 0) {
      more = true;
      break;
    }
    const cutoff = new Date(now.getTime() - state.retention_days * 86_400_000);
    let removed = 0;
    while (budget > 0) {
      const batch = await tx<{ id: string }[]>`
        SELECT id FROM activity_events
        WHERE user_id = ${userId} AND source = ${state.source} AND ts_start < ${cutoff} AND COALESCE(ts_end, ts_start) < ${cutoff}
        LIMIT ${ACTIVITY_PURGE_BATCH}`;
      if (batch.length === 0) break;
      const ids = batch.map((row) => row.id);
      await markSourceGoneTx(tx, userId, ids, now);
      await tx`DELETE FROM activity_events WHERE user_id = ${userId} AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(${tx.json(ids)}))`;
      removed += ids.length;
      budget -= 1;
      if (ids.length < ACTIVITY_PURGE_BATCH) break;
      if (budget <= 0) more = true;
    }
    sources.push({ source: state.source, removed });
    if (removed > 0)
      await tx`
        UPDATE activity_source_state
        SET cursor = COALESCE(cursor, '{}'::jsonb) || ${tx.json({ lastPurge: { removed, at: now.toISOString() } })}
        WHERE user_id = ${userId} AND source = ${state.source}`;
  }
  return { removed: sources.reduce((sum, item) => sum + item.removed, 0), sources, more };
}
