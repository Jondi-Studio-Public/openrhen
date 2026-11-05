import {
  AGENT_WAKE_TTL_MINUTES,
  ATTENTION_WAKE_MIN_GAP_MINUTES,
  ATTENTION_WAKE_OPEN_TARGET,
  agentWakeDedupeKey,
  type AgentWakeEvent
} from "@openrhen/contracts";
import type postgres from "postgres";

/**
 * Queues a wake for the owner's OpenClaw agent. Returns whether a row was added:
 * the same event and target a second time adds nothing, so a repeated tick or a restart cannot wake the agent twice.
 * Producers call this and nothing else; the worker's sender is the only thing that POSTs. `sql` may be a transaction.
 */
export async function enqueueAgentWake(
  sql: postgres.Sql | postgres.TransactionSql,
  input: { userId: string; event: AgentWakeEvent; targetId: string; now?: Date }
): Promise<boolean> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + AGENT_WAKE_TTL_MINUTES[input.event] * 60_000);
  const rows = await sql`
    INSERT INTO agent_wakes (user_id, event, target_id, dedupe_key, expires_at, created_at)
    VALUES (${input.userId}, ${input.event}, ${input.targetId}, ${agentWakeDedupeKey(input.event, input.targetId)}, ${expiresAt.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/**
 * Re-entry: a lapse wake that has not been sent yet is no longer true, so it is marked dead rather than sent.
 * The sender's send-time "still lapsed" check is the backstop for one already claimed.
 */
export async function cancelPendingLapseWakes(
  sql: postgres.Sql | postgres.TransactionSql,
  userId: string
): Promise<number> {
  const rows = await sql`
    UPDATE agent_wakes SET status='dead', last_error='cancelled'
    WHERE user_id=${userId} AND event='pulse_lapsed' AND status='pending'
    RETURNING id`;
  return rows.length;
}

/** The unknown segment closed (contact or re-entry): a pulse_unknown wake not yet sent is no longer true. */
export async function cancelPendingUnknownWakes(
  sql: postgres.Sql | postgres.TransactionSql,
  userId: string
): Promise<number> {
  const rows = await sql`
    UPDATE agent_wakes SET status='dead', last_error='cancelled'
    WHERE user_id=${userId} AND event='pulse_unknown' AND status='pending'
    RETURNING id`;
  return rows.length;
}

/** The owner or agent read the attention feed: a waiting-attention wake not yet sent has done its job. The episode stays open. */
export async function cancelPendingAttentionWakes(
  sql: postgres.Sql | postgres.TransactionSql,
  userId: string
): Promise<number> {
  const rows = await sql`
    UPDATE agent_wakes SET status='dead', last_error='cancelled'
    WHERE user_id=${userId} AND event='attention_waiting' AND status='pending'
    RETURNING id`;
  return rows.length;
}

export type AttentionWakeTick = "closed" | "idle" | "asleep" | "capped" | "enqueued" | "open";

/**
 * One minute's decision for the waiting-attention wake. `waiting` is the feed's `now` count without the check-in
 * (it has its own wake) and without failed sources. An episode runs from the count rising above 0 to it falling
 * back to 0: its row keeps the dedupe key `attention_waiting:open`, so the unique index refuses a second wake
 * inside it, and a fall to 0 renames that key so the next rise can wake again. On top of that, no more than one
 * wake an hour (counted from the last row of any status), and none while the owner is asleep. Nothing here is
 * held in memory, so a restart cannot repeat or lose a wake.
 */
export async function runAttentionWakeTick(
  sql: postgres.Sql | postgres.TransactionSql,
  input: { userId: string; waiting: number; asleep: boolean; now?: Date }
): Promise<AttentionWakeTick> {
  const now = input.now ?? new Date();
  if (input.waiting <= 0) {
    await cancelPendingAttentionWakes(sql, input.userId);
    const closed = await sql`
      UPDATE agent_wakes SET dedupe_key = 'attention_waiting:closed:' || id::text
      WHERE user_id=${input.userId} AND event='attention_waiting' AND dedupe_key=${agentWakeDedupeKey("attention_waiting", ATTENTION_WAKE_OPEN_TARGET)}
      RETURNING id`;
    return closed.length > 0 ? "closed" : "idle";
  }
  if (input.asleep) return "asleep";
  const since = new Date(now.getTime() - ATTENTION_WAKE_MIN_GAP_MINUTES * 60_000).toISOString();
  const recent = await sql`
    SELECT 1 FROM agent_wakes
    WHERE user_id=${input.userId} AND event='attention_waiting' AND created_at > ${since}::timestamptz LIMIT 1`;
  if (recent.length > 0) return "capped";
  const added = await enqueueAgentWake(sql, {
    userId: input.userId,
    event: "attention_waiting",
    targetId: now.toISOString(),
    now
  });
  return added ? "enqueued" : "open";
}
