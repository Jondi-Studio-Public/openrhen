import { AGENT_PROPOSAL_EXPIRY_DAYS, ATTENTION_WAITING_DAYS } from "@openrhen/contracts";
import type { Sql } from "@/server/persistence/postgres/sql-pool";

export interface ProposalsWaiting {
  count: number;
  /** Oldest `created_at` among the waiting proposals, ISO. */
  oldestAt: string;
  /** The nearest expiry (`created_at` + 14 days), ISO, when one is under the waiting threshold from expiring. */
  expiringAt?: string;
}

/**
 * One agent's non-shadow proposals that are still pending and have waited more than the waiting threshold (2 days),
 * for the attention feed's `proposals_waiting` summary. A row already past its 14 days is an expiry outcome, not a
 * waiting proposal, whether or not `expireOld` has stamped it. Reads only.
 */
export async function readProposalsWaiting(sql: Sql, userId: string, agent: string): Promise<ProposalsWaiting | null> {
  const [row] = await sql<{ count: number; oldest: Date | null; expiring: boolean | null }[]>`
    SELECT count(*)::int AS count, min(created_at) AS oldest,
      (min(created_at) < now() - make_interval(days => ${AGENT_PROPOSAL_EXPIRY_DAYS - ATTENTION_WAITING_DAYS})) AS expiring
    FROM agent_proposals
    WHERE user_id=${userId} AND agent=${agent} AND shadow=false AND status='pending'
      AND created_at < now() - make_interval(days => ${ATTENTION_WAITING_DAYS})
      AND created_at >= now() - make_interval(days => ${AGENT_PROPOSAL_EXPIRY_DAYS})`;
  if (!row || row.count === 0 || row.oldest === null) return null;
  return {
    count: row.count,
    oldestAt: row.oldest.toISOString(),
    ...(row.expiring
      ? { expiringAt: new Date(row.oldest.getTime() + AGENT_PROPOSAL_EXPIRY_DAYS * 86_400_000).toISOString() }
      : {})
  };
}
