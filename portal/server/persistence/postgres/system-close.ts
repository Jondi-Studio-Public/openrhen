import {
  IMPORT_REMOVED_REASON_PREFIX,
  closeCall,
  type CascadedRow,
  type DependentRow,
  type SkippedRow
} from "@openrhen/contracts";
import { applyClose, planClose, type CascadePlan } from "./close-cascade";
import { closeBudgetApplies } from "./close-budget";
import { dependentsOf } from "./close-commands";
import { recordStateChange } from "./planning-evidence";
import type { Sql } from "./sql-pool";

/**
 * Closing a commitment on the server's own behalf, not a person's or an agent's: a calendar or feed source cancelled the
 * event, so the import cancels the commitment instead of deleting it (archive-removals design section 7, PR 7a). The
 * close is stamped `system` (the database trigger, because no actor is set) with a reason that starts with
 * {@link IMPORT_REMOVED_REASON_PREFIX}, which is the one marker that lets the same source reopen the row when the event
 * comes back. Steps and safe prep actions close with it in the same batch, and one ledger row per commitment lets
 * `closeEntity {do:"restore"}` bring them all back.
 */

/** A commitment's close plan, read and locked, with the weight the hourly brake counts for it. */
export interface LockedSystemClose {
  id: string;
  version: number;
  plan: CascadePlan;
  /** The commitment and every row that closes with it. */
  weight: number;
}

/** The ids of the sessions still running on the commitment or one of its steps (a source cancel leaves them running). */
async function openSessionIds(tx: Sql, userId: string, id: string): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    SELECT s.id FROM sessions s
    WHERE s.user_id=${userId} AND s.ended_at IS NULL AND s.status::text IN ('running','paused','awaiting_feedback')
      AND ((s.target_type='fixed_commitment' AND s.target_id=${id})
        OR (s.target_type='routine_step' AND s.target_id IN (SELECT id FROM routine_steps WHERE commitment_id=${id})))`;
  return rows.map((row) => row.id);
}

const planKey = (plan: CascadePlan) =>
  plan.rows
    .map((row) => `${row.type}:${row.id}:${row.version}`)
    .sort()
    .join("|");

/**
 * Locks an open commitment and reads what closing it would take with it. Returns null when it is missing or already
 * cancelled (a close of such a row writes nothing and counts for nothing).
 */
export async function lockSystemClose(tx: Sql, userId: string, id: string): Promise<LockedSystemClose | null> {
  const row = (
    await tx<
      { status: string; version: number }[]
    >`SELECT status, version FROM commitments WHERE id=${id} AND user_id=${userId} FOR NO KEY UPDATE`
  )[0];
  if (!row || row.status === "cancelled") return null;
  const planned = await planClose(
    tx,
    { userId, type: "commitment", id, shownId: id, verb: "cancel", version: row.version, includeChildren: false },
    { lock: true, refuse: false }
  );
  // A prep action with a session running on it is left open and listed: cancelling it would pull the work out from
  // under the person. (A session on the commitment itself is left running: see `closeCommitmentAsSystem`.)
  const running = new Set(
    (
      await tx<
        { action_id: string }[]
      >`SELECT DISTINCT action_id FROM sessions WHERE user_id=${userId} AND ended_at IS NULL AND status::text IN ('running','paused','awaiting_feedback') AND action_id IS NOT NULL`
    ).map((session) => session.action_id)
  );
  const busy = planned.rows.filter((planRow) => planRow.type === "action" && running.has(planRow.id));
  const skipped: SkippedRow[] = busy.map((planRow) => ({
    type: "action",
    id: planRow.id,
    reason: `Prep action "${planRow.title}" was left open: it has a session running.`,
    call: closeCall({ verb: "cancel", type: "action", id: planRow.id, version: planRow.version })
  }));
  const plan: CascadePlan = {
    ...planned,
    rows: planned.rows.filter((planRow) => !busy.includes(planRow)),
    skipped: [...planned.skipped, ...skipped]
  };
  return { id, version: row.version, plan, weight: 1 + plan.rows.length };
}

export interface SystemCloseArgs {
  userId: string;
  id: string;
  /** Why the source removed it, e.g. `Cancelled in Google Calendar`; the stored reason is the prefix plus this. */
  why: string;
  /** The import batch: it is the close batch and the command id of the ledger row. */
  batchId?: string | undefined;
  /** The plan the brake counted; the write is refused if it is not the plan the locked rows give now. */
  planned?: LockedSystemClose | undefined;
}

export interface SystemCloseResult {
  /** False when the commitment was missing or already cancelled: nothing was written. */
  closed: boolean;
  /** Rows closed, the commitment included. */
  rows: number;
}

/**
 * Cancels the commitment (once). An already-cancelled commitment is left exactly as it is: no `closed_*` rewrite, no
 * ledger row, nothing counted, so a person's earlier cancel and its restore batch survive an import that says the same.
 */
export async function closeCommitmentAsSystem(tx: Sql, args: SystemCloseArgs): Promise<SystemCloseResult> {
  const { userId, id } = args;
  const locked = await lockSystemClose(tx, userId, id);
  if (!locked) return { closed: false, rows: 0 };
  if (args.planned && planKey(args.planned.plan) !== planKey(locked.plan))
    throw new Error("A commitment changed while its cancellation was being counted. Nothing was written; try again.");
  const before = (
    await tx<
      {
        status: string;
        version: number;
        closed_at: Date | null;
        closed_from_status: string | null;
        closed_by: string | null;
        closed_batch: string | null;
        closed_reason: string | null;
      }[]
    >`SELECT status, version, closed_at, closed_from_status, closed_by, closed_batch, closed_reason FROM commitments WHERE id=${id}`
  )[0]!;
  const batch = args.batchId ?? crypto.randomUUID();
  const reason = `${IMPORT_REMOVED_REASON_PREFIX}${args.why}`;
  const sessions = await openSessionIds(tx, userId, id);
  await tx`UPDATE commitments SET status='cancelled', closed_batch=${batch}, closed_reason=${reason}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
  const cascaded: CascadedRow[] = await applyClose(tx, locked.plan, batch, reason, null);
  const dependents: DependentRow[] = await dependentsOf(tx, "commitment", id);
  await recordStateChange(tx, userId, {
    entityType: "commitment",
    entityId: id,
    operation: "close",
    commandId: args.batchId ?? null,
    before: { id, ...before },
    evidence: {
      do: "close",
      verb: "cancel",
      batch,
      cascade: cascaded,
      skipped: locked.plan.skipped,
      closed: 1 + cascaded.length,
      counted: closeBudgetApplies(),
      via: "import",
      importBatch: args.batchId ?? null,
      why: args.why,
      dependents: dependents.map((row) => ({ type: row.type, id: row.id, title: row.title, call: row.call })),
      openSessions: sessions
    },
    at: new Date()
  });
  return { closed: true, rows: 1 + cascaded.length };
}
