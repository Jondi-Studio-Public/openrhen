import { AGENT_WAKE_TTL_MINUTES, agentWakeDedupeKey, type AgentWakeEvent } from "@openrhen/contracts";
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
    INSERT INTO agent_wakes (user_id, event, target_id, dedupe_key, expires_at)
    VALUES (${input.userId}, ${input.event}, ${input.targetId}, ${agentWakeDedupeKey(input.event, input.targetId)}, ${expiresAt.toISOString()}::timestamptz)
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
