import {
  ancestorClosedRefusal,
  childrenOpenRefusal,
  closeCall,
  closeVerbRule,
  restoreCall,
  restoreStatus,
  verbFor,
  isClosedStatus,
  type CascadedRow,
  type CloseType,
  type CloseVerb,
  type SkippedRow
} from "@openrhen/contracts";
import { firstClosedAncestor } from "./close-ancestors";
import { resolveOpenChildren } from "./close-children";
import { refused, wrongState } from "./command-errors";
import type { Sql } from "./sql-pool";
import type { WriteSnapshot } from "./write-snapshot";

/**
 * What a close or restore does to rows other than the one named: the open children of an area, outcome or project
 * (with `include-children`), and a cancelled commitment's pending steps and prep actions. `closeEntity` plans first
 * (read, with row locks when it will write), then applies the plan in the same batch; a restore reads the closing
 * command's ledger evidence and reopens only the rows still closed at the version that close left them (plan D8).
 */
export interface CascadeContext {
  userId: string;
  type: CloseType;
  /** The stored id of the row being closed or restored. */
  id: string;
  /** The id as the caller sent it, for the calls a refusal names. */
  shownId: string;
  verb: CloseVerb;
  /** The row's version before this call. */
  version: number;
  includeChildren: boolean;
  reason?: string | undefined;
}

export type CascadeType = "outcome" | "project" | "action" | "deliverable" | "routine_step";

const TABLE_OF: Record<CascadeType, string> = {
  outcome: "outcomes",
  project: "projects",
  action: "actions",
  deliverable: "deliverables",
  routine_step: "routine_steps"
};

/** A row the call will close, as read before the write. */
export interface PlannedRow {
  type: CascadeType;
  id: string;
  /** Its status before the close. */
  from: string;
  /** Its version before the close. */
  version: number;
  title: string;
  /** The status the close writes. */
  closedStatus: string;
  needsOwner: boolean;
}

export interface CascadePlan {
  rows: PlannedRow[];
  skipped: SkippedRow[];
  /** Some row is the owner's call (D9): an agent's call is one proposal, not a direct write. */
  needsOwner: boolean;
  /** The commitment is shared to a calendar. */
  shared: boolean;
}

export interface CascadeOutcome {
  cascaded: CascadedRow[];
  skipped: SkippedRow[];
}

const EMPTY: CascadePlan = { rows: [], skipped: [], needsOwner: false, shared: false };

/**
 * Reads what closing this row takes with it. With `refuse` (the handler) a parent with open children and no
 * `include-children`, or a commitment whose preparation has started, is refused; without it (the route's pre-read)
 * the plan is simply what the call would touch. `lock` takes `FOR NO KEY UPDATE` on every row read.
 */
export async function planClose(
  tx: Sql,
  ctx: CascadeContext,
  options: { lock: boolean; refuse: boolean }
): Promise<CascadePlan> {
  if (ctx.type === "area" || ctx.type === "outcome" || ctx.type === "project") {
    const children = await resolveOpenChildren(tx, { type: ctx.type, id: ctx.id }, options.lock);
    if (children.length === 0) return EMPTY;
    if (!ctx.includeChildren) {
      if (!options.refuse) return EMPTY;
      throw refused(
        childrenOpenRefusal({
          type: ctx.type,
          id: ctx.shownId,
          verb: ctx.verb,
          version: ctx.version,
          count: children.length,
          deadlined: children.filter((child) => child.deadlined).map((child) => child.title),
          ...(ctx.reason === undefined ? {} : { reason: ctx.reason })
        })
      );
    }
    const rows = children.map((child): PlannedRow => {
      // An open action or deliverable is dropped (cancelled); an outcome or project follows the parent's verb where its rules allow it.
      const allowed = verbFor(child.type, child.status);
      const verb: CloseVerb = allowed === "either" ? ctx.verb : allowed === "archive" ? "archive" : "cancel";
      return {
        type: child.type,
        id: child.id,
        from: child.status,
        version: child.version,
        title: child.title,
        closedStatus: verb === "archive" ? "archived" : "cancelled",
        needsOwner: child.needsOwner
      };
    });
    return { rows, skipped: [], needsOwner: rows.some((row) => row.needsOwner), shared: false };
  }
  if (ctx.type === "commitment") return planCommitment(tx, ctx, options);
  return EMPTY;
}

async function planCommitment(
  tx: Sql,
  ctx: CascadeContext,
  options: { lock: boolean; refuse: boolean }
): Promise<CascadePlan> {
  const forUpdate = options.lock ? tx`FOR NO KEY UPDATE` : tx``;
  const commitment = (
    await tx<
      { project_id: string | null; share_to_calendar: boolean }[]
    >`SELECT project_id, share_to_calendar FROM commitments WHERE id=${ctx.id}`
  )[0];
  if (!commitment) return EMPTY;
  const started = await tx<
    { id: string }[]
  >`SELECT id FROM routine_steps WHERE commitment_id=${ctx.id} AND status IN ('doing','completed') LIMIT 1`;
  if (started.length > 0 && options.refuse)
    throw wrongState({
      kind: "commitment",
      id: ctx.shownId,
      state: "under way (its preparation has started)",
      needs: "its preparation not to have started",
      nextCall: {
        tool: "rhen_status",
        arguments: {},
        note: "shows what is under way; finish or stop it, then repeat"
      }
    });
  const rows: PlannedRow[] = [];
  const skipped: SkippedRow[] = [];
  const steps = await tx<
    { id: string; status: string; version: number; title: string }[]
  >`SELECT id, status, version, title FROM routine_steps WHERE commitment_id=${ctx.id} AND status IN ('pending','blocked') ORDER BY sequence ${forUpdate}`;
  for (const step of steps)
    rows.push({
      type: "routine_step",
      id: step.id,
      from: step.status,
      version: step.version,
      title: step.title,
      closedStatus: "cancelled",
      needsOwner: false
    });
  const openActions = [...(closeVerbRule("action")?.cancelFrom ?? [])];
  const prep = await tx<
    {
      id: string;
      status: string;
      version: number;
      title: string;
      deadline_at: Date | null;
      project_id: string;
      deliverable_id: string | null;
    }[]
  >`SELECT id, status::text AS status, version, title, deadline_at, project_id, deliverable_id FROM actions WHERE prep_for_commitment_id=${ctx.id} AND status::text IN ${tx(openActions)} ORDER BY created_at, id ${forUpdate}`;
  for (const action of prep) {
    const dependents = await tx<
      { n: string }[]
    >`SELECT (SELECT count(*) FROM action_dependencies d JOIN actions o ON o.id=d.action_id WHERE d.depends_on_action_id=${action.id} AND o.status::text IN ${tx(openActions)}) + (SELECT count(*) FROM entity_prerequisites WHERE requires_kind='action' AND requires_id=${action.id}) AS n`;
    let reason: string | null = null;
    if (action.deadline_at !== null) reason = "it has a deadline of its own";
    else if (action.deliverable_id !== null || Number(dependents[0]!.n) > 0)
      reason = "it has another open link (a deliverable it is a step of, or work that waits on it)";
    else if (commitment.project_id !== null && action.project_id !== commitment.project_id)
      reason = "it sits on another project than the commitment";
    if (reason !== null)
      skipped.push({
        type: "action",
        id: action.id,
        reason: `Prep action "${action.title}" was left open: ${reason}.`,
        call: closeCall({ verb: "cancel", type: "action", id: action.id, version: action.version })
      });
    else
      rows.push({
        type: "action",
        id: action.id,
        from: action.status,
        version: action.version,
        title: action.title,
        closedStatus: "cancelled",
        needsOwner: false
      });
  }
  return { rows, skipped, needsOwner: commitment.share_to_calendar, shared: commitment.share_to_calendar };
}

/** Writes the plan: one before-image per table, each row to its closed status in the parent's batch. Returns the ledger's cascade list. */
export async function applyClose(
  tx: Sql,
  plan: CascadePlan,
  batch: string,
  reason: string | undefined,
  snap: WriteSnapshot | null
): Promise<CascadedRow[]> {
  const done: CascadedRow[] = [];
  for (const type of ["outcome", "project", "action", "deliverable", "routine_step"] as const) {
    const rows = plan.rows.filter((row) => row.type === type);
    if (rows.length === 0) continue;
    const table = TABLE_OF[type];
    await snap?.before(
      table as never,
      rows.map((row) => row.id)
    );
    for (const row of rows) {
      // A step has no closed_* columns (it follows its commitment); the rest are stamped by the trigger.
      if (type === "routine_step")
        await tx`UPDATE routine_steps SET status=${row.closedStatus}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${row.id}`;
      else
        await tx`UPDATE ${tx(table)} SET status=${row.closedStatus}, closed_batch=${batch}, closed_reason=${reason ?? null}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${row.id}`;
      done.push({ type, id: row.id, from: row.from, version: row.version + 1 });
    }
  }
  return done;
}

/** The rows the closing command of this batch took with it, from its ledger evidence. */
export async function batchEntries(
  tx: Sql,
  userId: string,
  type: CloseType,
  id: string,
  closedBatch: string | null
): Promise<CascadedRow[]> {
  if (closedBatch === null) return [];
  const ledger = (
    await tx<
      { evidence: { cascade?: CascadedRow[] } }[]
    >`SELECT evidence FROM write_rows WHERE user_id=${userId} AND entity_type=${type} AND entity_id=${id} AND operation='close' AND evidence->>'batch'=${closedBatch} LIMIT 1`
  )[0];
  if (ledger) return ledger.evidence.cascade ?? [];
  if (type !== "commitment") return [];
  // An occurrence closed by its rule's end has no row of its own: the rule's `close` row holds the steps that closed
  // with every occurrence of that end (`[step, commitment, from, version]`), so this one's come from there. An import
  // can end several rules in one batch, so every row of the batch is read.
  const ends = await tx<
    { evidence: { steps?: unknown } }[]
  >`SELECT evidence FROM write_rows WHERE user_id=${userId} AND entity_type='commitment_recurrence_rule' AND operation='close' AND evidence->>'batch'=${closedBatch}`;
  const rows: CascadedRow[] = [];
  for (const end of ends)
    for (const tuple of Array.isArray(end.evidence.steps) ? (end.evidence.steps as unknown[]) : []) {
      if (!Array.isArray(tuple) || tuple[1] !== id) continue;
      rows.push({
        type: tuple[4] === "action" ? "action" : "routine_step",
        id: String(tuple[0]),
        from: String(tuple[2]),
        version: Number(tuple[3])
      });
    }
  return rows;
}

/**
 * Reopens the batch's rows that are still closed at the version the close left them (a commitment's always; an
 * area's, outcome's or project's only with `include-children`). The rest stay as they are and are listed with the
 * call that restores them on their own. Called after the parent is back, so a child under a parent that stayed closed
 * (it was edited since) is found under a closed ancestor and left alone.
 */
export async function restoreBatch(
  tx: Sql,
  ctx: CascadeContext,
  closedBatch: string | null,
  snap: WriteSnapshot | null
): Promise<CascadeOutcome> {
  const cascaded: CascadedRow[] = [];
  const skipped: SkippedRow[] = [];
  if (ctx.type !== "commitment" && !ctx.includeChildren) return { cascaded, skipped };
  const entries = await batchEntries(tx, ctx.userId, ctx.type, ctx.id, closedBatch);
  for (const entry of entries) {
    const type = entry.type as CascadeType;
    const table = TABLE_OF[type];
    const row = (
      type === "routine_step"
        ? await tx<
            { status: string; version: number; closed_from_status: string | null }[]
          >`SELECT status, version, NULL::text AS closed_from_status FROM routine_steps WHERE id=${entry.id} FOR NO KEY UPDATE`
        : await tx<
            { status: string; version: number; closed_from_status: string | null }[]
          >`SELECT status::text AS status, version, closed_from_status FROM ${tx(table)} WHERE id=${entry.id} FOR NO KEY UPDATE`
    )[0];
    const own = (reason: string, call: SkippedRow["call"]) =>
      skipped.push({ type: entry.type, id: entry.id, reason, call });
    if (!row) {
      own("It no longer exists.", null);
      continue;
    }
    const closed = type === "routine_step" ? row.status === "cancelled" : isClosedStatus(row.status);
    if (!closed) {
      own(`It is ${row.status} again already.`, null);
      continue;
    }
    const own_call = type === "routine_step" ? null : restoreCall(type, entry.id, row.version, row.status);
    if (row.version !== entry.version) {
      own("It was changed after it was closed, so it was left as it is.", own_call);
      continue;
    }
    if (type !== "routine_step") {
      const above = await firstClosedAncestor(tx, type, entry.id);
      if (above) {
        const refusal = ancestorClosedRefusal({ type, id: entry.id, ancestor: above });
        own(refusal.message, refusal.nextCall ?? null);
        continue;
      }
    }
    const landing = type === "routine_step" ? entry.from : restoreStatus(type, row.closed_from_status).status;
    await snap?.before(table as never, [entry.id]);
    if (type === "project" && row.status === "archived" && landing === "active")
      await tx`UPDATE projects SET status=${landing}, forecast_started_at=NULL, baseline_estimate_minutes=NULL, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${entry.id}`;
    else
      await tx`UPDATE ${tx(table)} SET status=${landing}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${entry.id}`;
    cascaded.push({ type: entry.type, id: entry.id, from: row.status, version: row.version + 1 });
  }
  return { cascaded, skipped };
}
