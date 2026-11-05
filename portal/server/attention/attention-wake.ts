import { runAttentionWakeTick, type AttentionWakeTick } from "@openrhen/database";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";
import { readAttentionCounts } from "./counts";
import type { AttentionReaders } from "./readers";

/**
 * Wakes the owner's agent when the attention feed goes from nothing to something (the proactive wake design,
 * `attention_waiting`). It runs on the worker's 60 second pulse tick, reads the same counts the status block shows,
 * and queues at most one wake an hour through `agent_wakes`; the worker's sender is the only thing that POSTs.
 *
 * What counts: blocking data-health items and a due catch-up. The open check-in is left out because an unanswered one
 * already has its own wake after 10 minutes, and a failed source is left out because a blip must not wake anyone.
 */
export async function runAttentionWake(
  sql: PoolSql,
  options: { now?: Date; readers?: AttentionReaders } = {}
): Promise<AttentionWakeTick> {
  const now = options.now ?? new Date();
  const userId = await ensureUser(sql);
  const counts = await readAttentionCounts(sql, { agent: null, scopes: undefined, now }, options.readers);
  // A failed read says nothing about whether items wait, so it neither wakes nor closes an episode.
  if (counts.sourcesFailed > 0 && counts.healthBlocking + counts.catchUpDue === 0) return "idle";
  const asleep =
    (
      await sql`SELECT 1 FROM pulse_segments WHERE user_id = ${userId} AND ended_at IS NULL AND state = 'asleep' LIMIT 1`
    ).length > 0;
  return runAttentionWakeTick(sql, { userId, waiting: counts.healthBlocking + counts.catchUpDue, asleep, now });
}
