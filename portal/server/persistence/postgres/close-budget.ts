import {
  CLOSE_BUDGET_LIMIT,
  CLOSE_BUDGET_WINDOW_MINUTES,
  closeBudgetRefusal,
  type AgentCall
} from "@openrhen/contracts";
import { changeLogConfirmedBy, requestScopes } from "@/server/agent-actor";
import { CommandConflictError } from "./command-errors";
import type { Sql } from "./sql-pool";

/**
 * The close brake (archive-removals design section 4, F3-05): token agents together may close at most
 * `CLOSE_BUDGET_LIMIT` rows in any rolling hour. The stateless rule: a call applies only when the closures already made
 * in the last hour plus the rows it would close stay within the limit; otherwise the call is filed for the owner. The
 * hour is counted from the write ledger (`write_rows`, operation `close`), never from the `closed_*` columns, so a
 * close followed by a restore followed by a close counts twice.
 *
 * What counts: rows whose actor is an agent (not the owner, not `system`), made by a token-held agent
 * (`evidence.counted` is not false), not an owner-confirmed replay and not an undo of a create. A row's weight is its
 * `closed` figure (the target and everything that closed with it), else the target plus its cascade (rows written
 * before the figure existed).
 */

/** The key every closer takes first; own namespace, apart from `pulse_recorder:`, `agent_proposals:` and the like. */
const lockKey = (userId: string) => `close_budget:${userId}`;
const LOCK_WAIT = "5s";

/** Whether the brake applies to this request: a token-held agent, not the owner's confirmation of its proposal. */
export function closeBudgetApplies(): boolean {
  return requestScopes() !== undefined && changeLogConfirmedBy() !== "owner";
}

/** Serialises the budget check and the close that follows it for one user. Waits at most `LOCK_WAIT`. */
export async function lockCloseBudget(tx: Sql, userId: string): Promise<void> {
  const previous = (await tx<{ value: string }[]>`SELECT current_setting('lock_timeout') AS value`)[0]?.value ?? "0";
  await tx`SELECT set_config('lock_timeout', ${LOCK_WAIT}, true)`;
  try {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(userId)}, 0))`;
  } catch (error) {
    if ((error as { code?: string }).code === "55P03")
      throw new CommandConflictError(
        "Another close is being counted right now, so this one was not made. Wait a few seconds, then repeat the identical call (the same command-id, if it had one).",
        {
          nextCall: {
            tool: "rhen_status",
            arguments: {},
            note: "repeat the identical close once a few seconds have passed"
          }
        }
      );
    throw error;
  }
  await tx`SELECT set_config('lock_timeout', ${previous}, true)`;
}

/** Closures by token agents in the last hour, and when the oldest of them leaves the window. */
export async function closedInWindow(
  sql: Sql,
  userId: string,
  now: Date = new Date()
): Promise<{ used: number; oldestAgesOutAt: Date | null }> {
  const rows = await sql<{ used: string; oldest: Date | null }[]>`
    SELECT COALESCE(SUM(
             COALESCE((r.evidence->>'closed')::int,
                      1 + CASE WHEN jsonb_typeof(r.evidence->'cascade') = 'array' THEN jsonb_array_length(r.evidence->'cascade') ELSE 0 END)
           ), 0) AS used,
           MIN(r.created_at) AS oldest
    FROM write_rows r
    JOIN writes w ON w.id = r.write_id
    WHERE r.user_id = ${userId}
      AND r.operation = 'close'
      AND r.created_at > ${now}::timestamptz - make_interval(mins => ${CLOSE_BUDGET_WINDOW_MINUTES})
      AND w.actor IS NOT NULL AND w.actor <> 'system'
      AND COALESCE(r.evidence->>'counted', 'true') <> 'false'
      AND r.evidence->>'confirmedBy' IS NULL
      AND r.evidence->>'undoOfCreate' IS NULL`;
  const row = rows[0];
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  return {
    used: Number(row?.used ?? 0),
    oldestAgesOutAt: oldest ? new Date(oldest.getTime() + CLOSE_BUDGET_WINDOW_MINUTES * 60_000) : null
  };
}

/**
 * Refuses (a conflict whose next call is the same call, which the route then files as a proposal) when closing `rows`
 * more would pass the hourly limit. Call it holding the lock from `lockCloseBudget`. Does nothing for the owner, for a
 * confirmed replay, or for an exempt undo of a create.
 */
export async function assertCloseBudget(
  tx: Sql,
  userId: string,
  rows: number,
  options: { exempt?: boolean; nextCall: AgentCall; now?: Date }
): Promise<void> {
  if (options.exempt === true || !closeBudgetApplies()) return;
  const { used, oldestAgesOutAt } = await closedInWindow(tx, userId, options.now);
  if (used + rows <= CLOSE_BUDGET_LIMIT) return;
  const refusal = closeBudgetRefusal({ used, rows, oldestAgesOutAt, nextCall: options.nextCall });
  throw new CommandConflictError(refusal.message, { nextCall: options.nextCall });
}
