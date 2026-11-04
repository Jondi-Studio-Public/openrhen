import {
  CLOSE_TABLE_OF,
  CLOSED_TABLES,
  alreadyClosedRefusal,
  ancestorClosedRefusal,
  closeCall,
  closeVerbRule,
  isClosedStatus,
  notClosableRefusal,
  openSessionRefusal,
  reasonRequiredRefusal,
  requiredRefusal,
  restoreCall,
  restoreStatus,
  restoreToolFor,
  toolForVerb,
  UNDO_CLOSED_BY_SUFFIX,
  verbFor,
  wrongToolForRestoreRefusal,
  wrongVerbRefusal,
  wrongStateRefusal,
  type CascadedRow,
  type CloseEntityCommand,
  type CloseEntityResult,
  type CloseType,
  type CloseVerb,
  type DependentRow,
  type SkippedRow
} from "@openrhen/contracts";
import { changeLogConfirmedBy, requestAgent } from "@/server/agent-actor";
import type { PortalState } from "@/state/portal-state";
import { assertNotHomeLocation } from "./close-rules";
import { firstClosedAncestor } from "./close-ancestors";
import { applyClose, batchEntries, planClose, restoreBatch, type CascadeContext } from "./close-cascade";
import { assertCloseBudget, closeBudgetApplies, lockCloseBudget } from "./close-budget";
import { cascadeIsOwnCreate, verifyUndoOfCreate } from "./close-undo";
import { claimCommandReceipt, commandRequestHash, hasCommandReceipt } from "./command-receipt";
import { CommandConflictError, notFound, refused, versionConflict } from "./command-errors";
import { stableUuid } from "./command-values";
import { ensureUser } from "./ensure-user";
import { recordStateChange } from "./planning-evidence";
import { readStateAfterCommit } from "./read-after-commit";
import type { PoolSql, Sql, TxSql } from "./sql-pool";
import { WriteSnapshot } from "./write-snapshot";

/**
 * Close and restore one row of any of the eight types (archive-removals design sections 1 to 3; plan WP2a). The
 * archive and cancel tools both land here: `verb` is the tool that was used, `do` says close or restore. The
 * status columns change here; `closed_at`, `closed_from_status` and `closed_by` are stamped by the database trigger
 * (migration 0141), which reads the actor this command sets as its first statement, so a close made through any other
 * path is stamped `system`, never `person`.
 */

type Locked = {
  status: string;
  version: number;
  closed_at: Date | null;
  closed_from_status: string | null;
  closed_by: string | null;
  closed_batch: string | null;
  closed_reason: string | null;
};

/** Refusal kinds (`agent-refusal.ts`) for the types whose name there differs. */
const REFUSAL_KIND: Record<CloseType, string> = {
  area: "area",
  outcome: "outcome",
  project: "project",
  action: "action",
  deliverable: "deliverable",
  commitment: "commitment",
  routine_preset: "routine",
  condition_definition: "context"
};

const labelOf = (type: string): string => type.replace(/_/g, " ");

/** The id a row of this type is stored under, from the id as the caller sent it. */
export async function storedIdFor(type: CloseType, userId: string, rawId: string): Promise<string> {
  switch (type) {
    case "area":
      return stableUuid(`area:${userId}`, rawId);
    case "outcome":
      return stableUuid(`outcome:${userId}`, rawId);
    case "project":
      return stableUuid(`project:${userId}`, rawId);
    case "action":
      return stableUuid(`action:${userId}`, rawId);
    case "deliverable":
      return stableUuid(`deliverable:${userId}`, rawId);
    case "commitment":
      return stableUuid(`commitment:${userId}`, rawId);
    case "routine_preset":
      return stableUuid(`routine-preset:${userId}`, rawId);
    // keyed by its own slug, which every requirement and pathway names
    case "condition_definition":
      return rawId.trim().toLocaleLowerCase();
  }
}

/** The status and version of a closable row (locked `FOR NO KEY UPDATE`), undefined when it is missing; the save floor reads it. */
export async function lockedStatusOf(
  tx: Sql,
  userId: string,
  type: CloseType,
  rawId: string
): Promise<{ status: string; version: number } | undefined> {
  const row = await readRow(tx, userId, type, await storedIdFor(type, userId, rawId), true);
  return row === undefined ? undefined : { status: row.status, version: row.version };
}

/** The row with the closed columns, locked `FOR NO KEY UPDATE` when `lock`; undefined when it is missing or another user's. */
async function readRow(
  tx: Sql,
  userId: string,
  type: CloseType,
  id: string,
  lock: boolean
): Promise<Locked | undefined> {
  const lockClause = lock ? tx`FOR NO KEY UPDATE OF x` : tx``;
  const columns = tx`x.status::text AS status, x.version, x.closed_at, x.closed_from_status, x.closed_by, x.closed_batch, x.closed_reason`;
  let rows: Locked[];
  switch (type) {
    case "area":
      rows = await tx<Locked[]>`SELECT ${columns} FROM areas x WHERE x.id=${id} AND x.user_id=${userId} ${lockClause}`;
      break;
    case "outcome":
      rows = await tx<
        Locked[]
      >`SELECT ${columns} FROM outcomes x JOIN areas a ON a.id=x.area_id WHERE x.id=${id} AND a.user_id=${userId} ${lockClause}`;
      break;
    case "project":
      rows = await tx<
        Locked[]
      >`SELECT ${columns} FROM projects x JOIN outcomes o ON o.id=x.outcome_id JOIN areas a ON a.id=o.area_id WHERE x.id=${id} AND a.user_id=${userId} ${lockClause}`;
      break;
    case "action":
      rows = await tx<
        Locked[]
      >`SELECT ${columns} FROM actions x JOIN projects p ON p.id=x.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE x.id=${id} AND a.user_id=${userId} ${lockClause}`;
      break;
    case "deliverable":
      rows = await tx<
        Locked[]
      >`SELECT ${columns} FROM deliverables x JOIN projects p ON p.id=x.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE x.id=${id} AND a.user_id=${userId} ${lockClause}`;
      break;
    case "commitment":
      rows = await tx<
        Locked[]
      >`SELECT ${columns} FROM commitments x WHERE x.id=${id} AND x.user_id=${userId} ${lockClause}`;
      break;
    case "routine_preset":
      rows = await tx<
        Locked[]
      >`SELECT ${columns} FROM routine_presets x WHERE x.id=${id} AND x.user_id=${userId} ${lockClause}`;
      break;
    case "condition_definition":
      rows = await tx<
        Locked[]
      >`SELECT ${columns} FROM condition_definitions x WHERE x.id=${id} AND x.user_id=${userId} ${lockClause}`;
      break;
  }
  return rows[0];
}

/** The actor the trigger stamps: the person, the agent, or the agent's close the owner confirmed (plan D7). */
function actorName(undo = false): string {
  const agent = requestAgent();
  const suffix = undo ? UNDO_CLOSED_BY_SUFFIX : "";
  if (agent === null) return `person${suffix}`;
  return changeLogConfirmedBy() === "owner" ? `agent:${agent}:confirmed` : `agent:${agent}${suffix}`;
}

/** The label a close that took back a create carries (the Closed page hides it; its `closed_by` ends `:undo`). */
const UNDO_LABEL = "undo of create";

/** A restore needs every ancestor open (read top down with `FOR SHARE`, so a concurrent close of one waits for this restore). */
async function assertAncestorsOpen(tx: Sql, type: CloseType, shownId: string, id: string): Promise<void> {
  const closed = await firstClosedAncestor(tx, type, id);
  if (closed) throw refused(ancestorClosedRefusal({ type, id: shownId, ancestor: closed }));
}

/** The open session that blocks a close of this row, if any (plan D15). */
async function openSessionOn(
  tx: Sql,
  userId: string,
  type: CloseType,
  id: string
): Promise<{ id: string; target_type: string | null } | undefined> {
  const live = tx`s.user_id=${userId} AND s.ended_at IS NULL AND s.status::text IN ('running','paused','awaiting_feedback')`;
  if (type === "action")
    return (
      await tx<
        { id: string; target_type: string | null }[]
      >`SELECT s.id, s.target_type FROM sessions s WHERE ${live} AND s.action_id=${id} LIMIT 1`
    )[0];
  if (type === "deliverable")
    return (
      await tx<
        { id: string; target_type: string | null }[]
      >`SELECT s.id, s.target_type FROM sessions s WHERE ${live} AND ((s.target_type='deliverable' AND s.target_id=${id}) OR s.action_id IN (SELECT id FROM actions WHERE deliverable_id=${id})) LIMIT 1`
    )[0];
  if (type === "commitment")
    return (
      await tx<
        { id: string; target_type: string | null }[]
      >`SELECT s.id, s.target_type FROM sessions s WHERE ${live} AND ((s.target_type='fixed_commitment' AND s.target_id=${id}) OR (s.target_type='routine_step' AND s.target_id IN (SELECT id FROM routine_steps WHERE commitment_id=${id}))) LIMIT 1`
    )[0];
  return undefined;
}

/** Open rows that still wait on the row just cancelled, each with the read that shows what to edit (design 7). */
export async function dependentsOf(tx: Sql, type: CloseType, id: string): Promise<DependentRow[]> {
  if (type !== "action" && type !== "project" && type !== "deliverable") return [];
  const found: DependentRow[] = [];
  const push = (kind: "action" | "project" | "deliverable", rows: { id: string; title: string }[]) => {
    for (const row of rows)
      found.push({
        type: kind,
        id: row.id,
        title: row.title,
        call: {
          tool: "rhen_show",
          arguments: { entity: kind, id: row.id },
          note: `it still waits on the ${labelOf(type)} that was just cancelled: remove that prerequisite with rhen_save, or restore the ${labelOf(type)}`
        }
      });
  };
  const openActions = [...(closeVerbRule("action")?.cancelFrom ?? [])];
  const openDeliverables = [...(closeVerbRule("deliverable")?.cancelFrom ?? [])];
  const openProjects = [...(closeVerbRule("project")?.cancelFrom ?? [])];
  if (type === "action")
    push(
      "action",
      await tx<
        { id: string; title: string }[]
      >`SELECT ac.id, ac.title FROM action_dependencies d JOIN actions ac ON ac.id=d.action_id WHERE d.depends_on_action_id=${id} AND ac.status::text IN ${tx(openActions)}`
    );
  if (type === "deliverable")
    push(
      "deliverable",
      await tx<
        { id: string; title: string }[]
      >`SELECT dl.id, dl.title FROM deliverable_dependencies d JOIN deliverables dl ON dl.id=d.deliverable_id WHERE d.depends_on_deliverable_id=${id} AND dl.status::text IN ${tx(openDeliverables)}`
    );
  push(
    "action",
    await tx<
      { id: string; title: string }[]
    >`SELECT ac.id, ac.title FROM entity_prerequisites ep JOIN actions ac ON ac.id=ep.entity_id WHERE ep.entity_kind='action' AND ep.requires_kind=${type} AND ep.requires_id=${id} AND ac.status::text IN ${tx(openActions)}`
  );
  push(
    "project",
    await tx<
      { id: string; title: string }[]
    >`SELECT p.id, p.title FROM entity_prerequisites ep JOIN projects p ON p.id=ep.entity_id WHERE ep.entity_kind='project' AND ep.requires_kind=${type} AND ep.requires_id=${id} AND p.status::text IN ${tx(openProjects)}`
  );
  push(
    "deliverable",
    await tx<
      { id: string; title: string }[]
    >`SELECT dl.id, dl.title FROM entity_prerequisites ep JOIN deliverables dl ON dl.id=ep.entity_id WHERE ep.entity_kind='deliverable' AND ep.requires_kind=${type} AND ep.requires_id=${id} AND dl.status::text IN ${tx(openDeliverables)}`
  );
  return found;
}

/** What the ledger row of a command holds beyond the before-image; a retried call rebuilds its result from it (plan D8, D21). */
interface LedgerEvidence {
  do: "close" | "restore";
  verb: "archive" | "cancel";
  batch: string | null;
  cascade: CascadedRow[];
  skipped: SkippedRow[];
  restoredTo?: string;
  assumed?: boolean;
  closed?: number;
  counted?: boolean;
  undoOfCreate?: string;
}

const beforeImage = (id: string, row: Locked) => ({
  id,
  version: row.version,
  status: row.status,
  closed_at: row.closed_at,
  closed_from_status: row.closed_from_status,
  closed_by: row.closed_by,
  closed_batch: row.closed_batch,
  closed_reason: row.closed_reason
});

/** What a stored `close_entity` proposal adds: the children it listed when it was filed, which must still be the live set. */
export interface CloseEntityOptions {
  expectedChildren?: { type: string; id: string; version: number }[];
}

export async function closeEntity(
  sql: PoolSql,
  command: CloseEntityCommand,
  options: CloseEntityOptions = {}
): Promise<{ closed: CloseEntityResult; state: PortalState }> {
  const userId = await ensureUser(sql);
  const commandId = command.commandId ?? crypto.randomUUID();
  const receipt = {
    id: commandId,
    userId,
    commandType: "close_entity",
    requestHash: commandRequestHash("close_entity", command)
  };
  if (await hasCommandReceipt(sql, receipt))
    return { closed: await rebuildResult(sql, userId, command, commandId), state: await readStateAfterCommit(sql) };
  let closed: CloseEntityResult | undefined;
  await sql.begin(async (tx) => {
    if (!(await claimCommandReceipt(tx, receipt))) return;
    // First statement after the claim: the trigger stamps `closed_by` from this setting, which lives only until the
    // transaction ends. The claim sits before it so a replay never stamps.
    await tx`SELECT set_config('priorities.actor', ${actorName()}, true)`;
    // An agent's close keeps the rows it touches so it can be undone (write-snapshot.ts). Opened before any row lock:
    // it takes the plan publication lock first.
    const snap = await WriteSnapshot.open(tx, userId, commandId, "save");
    // The brake's lock comes after the plan publication lock and before any row lock (a restore is never counted).
    if (command.do === "close" && closeBudgetApplies()) await lockCloseBudget(tx, userId);
    closed =
      command.do === "close"
        ? await close(tx, userId, command, commandId, snap, options)
        : await reopen(tx, userId, command, commandId, snap);
  });
  // Lost the claim to a concurrent send of the same command: it landed, so answer as a retry would.
  closed ??= await rebuildResult(sql, userId, command, commandId);
  return { closed, state: await readStateAfterCommit(sql) };
}

async function close(
  tx: TxSql,
  userId: string,
  command: CloseEntityCommand,
  commandId: string,
  snap: WriteSnapshot | null,
  options: CloseEntityOptions
): Promise<CloseEntityResult> {
  const { type } = command;
  const id = await storedIdFor(type, userId, command.id);
  const row = await readRow(tx, userId, type, id, true);
  if (!row) throw notFound(REFUSAL_KIND[type], command.id);
  if (command.expectedVersion != null && command.expectedVersion !== row.version)
    throw versionConflict(labelOf(type), command.id, command.expectedVersion, row.version);
  if (isClosedStatus(row.status))
    throw refused(alreadyClosedRefusal({ type, id: command.id, status: row.status, version: row.version }));
  const allowed = verbFor(type, row.status);
  if (allowed === null) throw refused(notClosableRefusal({ type, id: command.id, status: row.status }));
  // An undo of the actor's own create, proved in the write ledger and sent with the version it left (plan B2). It takes
  // the verb the row's state allows, needs no reason, is not counted by the brake and is stamped `:undo`.
  // The exemption also needs everything the close takes with it to be the actor's own create: a prep action the owner
  // made, linked to the agent's commitment, is not the agent's to close past the brake without a reason.
  const undo =
    command.undoOfCommandId !== undefined &&
    typeof command.expectedVersion === "number" &&
    command.includeChildren !== true &&
    (await verifyUndoOfCreate(tx, userId, type, id, command.undoOfCommandId, row.version)) &&
    (await cascadeIsOwnCreate(
      tx,
      userId,
      (
        await planClose(tx, cascadeContext(userId, type, id, command, row.version, command.reason), {
          lock: false,
          refuse: false
        })
      ).rows
    ));
  const verb: CloseVerb = undo && allowed !== "either" ? allowed : command.verb;
  if (!undo && allowed !== "either" && allowed !== verb)
    throw refused(wrongVerbRefusal({ type, id: command.id, status: row.status, version: row.version, asked: verb }));
  if (undo) await tx`SELECT set_config('priorities.actor', ${actorName(true)}, true)`;
  // The owner (and an owner-confirmed replay, which carries the stored reason) needs no reason; an agent gives one.
  const reason = command.reason?.trim() || (undo ? UNDO_LABEL : undefined);
  if (requestAgent() !== null && changeLogConfirmedBy() !== "owner" && reason === undefined)
    throw refused(
      reasonRequiredRefusal({
        verb,
        type,
        id: command.id,
        version: row.version,
        ...(command.includeChildren ? { includeChildren: true } : {})
      })
    );
  const session = await openSessionOn(tx, userId, type, id);
  if (session)
    throw refused(
      openSessionRefusal({ type, id: command.id, sessionId: session.id, sessionTarget: session.target_type })
    );
  if (type === "condition_definition" && verb === "archive") await assertNotHomeLocation(tx, userId, id, command.id);

  const ctx = cascadeContext(userId, type, id, command, row.version, reason);
  const plan = await planClose(tx, ctx, { lock: true, refuse: true });
  const confirmed = changeLogConfirmedBy() === "owner";
  // The hourly brake: this call's rows (the target and everything that closes with it) against the last hour's closures.
  await assertCloseBudget(tx, userId, 1 + plan.rows.length, {
    exempt: undo,
    nextCall: closeCall({
      verb,
      type,
      id: command.id,
      version: row.version,
      ...(command.includeChildren ? { includeChildren: true } : {}),
      ...(reason === undefined ? {} : { reason })
    })
  });
  if (requestAgent() !== null && !confirmed && (plan.needsOwner || plan.shared)) {
    // The route sends such a call to the owner as one proposal; reaching here means it changed since that decision.
    throw new CommandConflictError(
      `${labelOf(type)} "${command.id}" ${plan.shared ? "is shared with other people" : "now has something under it that is the owner's call (a deadline, a requirement route or prep for a shared commitment)"}, so closing it needs the owner's confirmation. Repeat the call; it will be filed for them to confirm.`,
      {
        nextCall: closeCall({
          verb,
          type,
          id: command.id,
          version: row.version,
          ...(command.includeChildren ? { includeChildren: true } : {}),
          ...(reason === undefined ? {} : { reason })
        })
      }
    );
  }
  if (options.expectedChildren !== undefined) {
    const key = (row: { type: string; id: string; version: number }) => `${row.type}:${row.id}:${row.version}`;
    const live = plan.rows.map(key).sort();
    const listed = options.expectedChildren.map(key).sort();
    if (live.length !== listed.length || live.some((item, index) => item !== listed[index]))
      throw new CommandConflictError(
        `${labelOf(type)} "${command.id}" has different open items under it than when this was proposed, so nothing was closed. Ask for the close again.`,
        {
          nextCall: closeCall({
            verb,
            type,
            id: command.id,
            version: row.version,
            ...(command.includeChildren ? { includeChildren: true } : {}),
            ...(reason === undefined ? {} : { reason })
          })
        }
      );
  }
  for (const planned of plan.rows) {
    if (planned.type !== "action" && planned.type !== "deliverable") continue;
    const open = await openSessionOn(tx, userId, planned.type, planned.id);
    if (open)
      throw refused(
        openSessionRefusal({ type: planned.type, id: planned.id, sessionId: open.id, sessionTarget: open.target_type })
      );
  }
  const batch = crypto.randomUUID();
  const table = CLOSE_TABLE_OF[type];
  const closedStatus = verb === "archive" ? "archived" : "cancelled";
  await snap?.before(table, type === "condition_definition" ? [[userId, id]] : [id]);
  const where = type === "condition_definition" ? tx`id=${id} AND user_id=${userId}` : tx`id=${id}`;
  await tx`UPDATE ${tx(table)} SET status=${closedStatus}, closed_batch=${batch}, closed_reason=${reason ?? null}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE ${where}`;
  const cascade = { cascaded: await applyClose(tx, plan, batch, reason, snap), skipped: plan.skipped };
  const dependents = verb === "cancel" ? await dependentsOf(tx, type, id) : [];
  const version = row.version + 1;
  const deliverables = [
    ...(type === "deliverable" ? [id] : []),
    ...plan.rows.filter((r) => r.type === "deliverable").map((r) => r.id)
  ];
  const steps =
    deliverables.length === 0
      ? undefined
      : Number(
          (await tx<{ n: string }[]>`SELECT count(*) AS n FROM actions WHERE deliverable_id IN ${tx(deliverables)}`)[0]!
            .n
        );
  const evidence: LedgerEvidence = {
    do: "close",
    verb,
    batch,
    cascade: cascade.cascaded,
    skipped: cascade.skipped,
    // What the brake counts: this row and everything that closed with it, by a token-held agent.
    closed: 1 + cascade.cascaded.length,
    counted: closeBudgetApplies(),
    ...(undo ? { undoOfCreate: command.undoOfCommandId as string } : {})
  };
  await recordStateChange(tx, userId, {
    entityType: type,
    entityId: id,
    operation: "close",
    commandId,
    before: beforeImage(id, row),
    evidence: { ...evidence },
    at: new Date()
  });
  await snap?.save();
  return {
    type,
    id: command.id,
    do: "close",
    verb,
    status: closedStatus,
    version,
    batch,
    restore: restoreCall(type, command.id, version, closedStatus),
    cascaded: cascade.cascaded,
    skipped: cascade.skipped,
    dependents,
    ...(steps === undefined ? {} : { stepsLeft: steps })
  };
}

async function reopen(
  tx: TxSql,
  userId: string,
  command: CloseEntityCommand,
  commandId: string,
  snap: WriteSnapshot | null
): Promise<CloseEntityResult> {
  const { type, verb } = command;
  const id = await storedIdFor(type, userId, command.id);
  if (command.expectedVersion == null) throw refused(requiredRefusal("The expected version of the closed row"));
  // Ancestors first (top down, shared), then the row itself, the order the plan's lock rule gives.
  const peek = await readRow(tx, userId, type, id, false);
  if (!peek) throw notFound(REFUSAL_KIND[type], command.id);
  if (isClosedStatus(peek.status)) await assertAncestorsOpen(tx, type, command.id, id);
  const row = await readRow(tx, userId, type, id, true);
  if (!row) throw notFound(REFUSAL_KIND[type], command.id);
  if (command.expectedVersion !== row.version)
    throw versionConflict(labelOf(type), command.id, command.expectedVersion, row.version);
  const tool = restoreToolFor(row.status);
  if (tool === null || !(CLOSED_TABLES[CLOSE_TABLE_OF[type]].closed as readonly string[]).includes(row.status))
    throw refused(
      wrongStateRefusal({
        kind: labelOf(type),
        id: command.id,
        state: row.status,
        needs: "it to be archived or cancelled",
        nextCall: { tool: "rhen_show", arguments: { entity: type, id: command.id }, note: "shows its state" }
      })
    );
  // A close that took back a create (its `closed_by` ends `:undo`) is restored with either tool: the journal names the
  // verb it guessed when the row was made, the server chose the one the row's state took.
  const undone = row.closed_by?.endsWith(UNDO_CLOSED_BY_SUFFIX) === true;
  if (tool !== toolForVerb(verb) && !undone)
    throw refused(
      wrongToolForRestoreRefusal({ type, id: command.id, status: row.status, version: row.version, asked: verb })
    );
  // A concurrent close may have closed an ancestor between the peek and the lock; the shared locks above hold now.
  await assertAncestorsOpen(tx, type, command.id, id);

  const landing = restoreStatus(type, row.closed_from_status, row.status);
  const table = CLOSE_TABLE_OF[type];
  await snap?.before(table, type === "condition_definition" ? [[userId, id]] : [id]);
  const where = type === "condition_definition" ? tx`id=${id} AND user_id=${userId}` : tx`id=${id}`;
  // A project that was archived and comes back starts its pace baseline over, as reactivating it by save does.
  if (type === "project" && row.status === "archived" && landing.status === "active")
    await tx`UPDATE projects SET status=${landing.status}, forecast_started_at=NULL, baseline_estimate_minutes=NULL, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE ${where}`;
  else
    await tx`UPDATE ${tx(table)} SET status=${landing.status}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE ${where}`;
  // The parent is back; now the batch's rows that are still closed and unchanged (children only when asked).
  const cascade = await restoreBatch(
    tx,
    cascadeContext(userId, type, id, command, row.version, undefined),
    row.closed_batch,
    snap
  );
  const version = row.version + 1;
  const evidence: LedgerEvidence = {
    do: "restore",
    verb,
    batch: null,
    cascade: cascade.cascaded,
    skipped: cascade.skipped,
    restoredTo: landing.status,
    assumed: landing.assumed
  };
  await recordStateChange(tx, userId, {
    entityType: type,
    entityId: id,
    operation: "restore",
    commandId,
    before: beforeImage(id, row),
    evidence: { ...evidence, closedBatch: row.closed_batch },
    at: new Date()
  });
  await snap?.save();
  return {
    type,
    id: command.id,
    do: "restore",
    verb,
    status: landing.status,
    version,
    batch: null,
    restoredTo: landing.status,
    assumed: landing.assumed,
    restore: null,
    cascaded: cascade.cascaded,
    skipped: cascade.skipped,
    dependents: []
  };
}

const cascadeContext = (
  userId: string,
  type: CloseType,
  id: string,
  command: CloseEntityCommand,
  version: number,
  reason: string | undefined
): CascadeContext => ({
  userId,
  type,
  id,
  shownId: command.id,
  verb: command.verb,
  version,
  includeChildren: command.includeChildren === true,
  ...(reason === undefined ? {} : { reason })
});

/**
 * A retried call (or the loser of a race on the same command id) answers with the result the first send produced:
 * the live row for its status and version, the ledger row for the batch and what moved with it (plan D21).
 */
async function rebuildResult(
  sql: PoolSql,
  userId: string,
  command: CloseEntityCommand,
  commandId: string
): Promise<CloseEntityResult> {
  const { type } = command;
  const id = await storedIdFor(type, userId, command.id);
  const row = await readRow(sql, userId, type, id, false);
  if (!row) throw notFound(REFUSAL_KIND[type], command.id);
  const ledger = (
    await sql<
      { evidence: Partial<LedgerEvidence> }[]
    >`SELECT evidence FROM write_rows WHERE write_id=${commandId} LIMIT 1`
  )[0]?.evidence;
  const closedNow = isClosedStatus(row.status);
  return {
    type,
    id: command.id,
    do: command.do,
    verb: command.verb,
    status: row.status,
    version: row.version,
    batch: command.do === "close" ? (row.closed_batch ?? ledger?.batch ?? null) : null,
    ...(command.do === "restore"
      ? { restoredTo: ledger?.restoredTo ?? row.status, assumed: ledger?.assumed ?? false }
      : {}),
    restore: closedNow ? restoreCall(type, command.id, row.version, row.status) : null,
    cascaded: ledger?.cascade ?? [],
    skipped: ledger?.skipped ?? [],
    dependents: []
  };
}

/** What a close or restore would touch, read without writing: the facts the route's decision needs (plan D10, WP3). */
export interface ClosePreview {
  found: boolean;
  status: string | null;
  version: number | null;
  /** Who closed the row (`closed_by`: `person`, `agent:<name>`, `agent:<name>:confirmed`, `system`), null when open or unknown. */
  closedBy: string | null;
  /** Every row besides the target that the call would change, with the version a proposal must pin. */
  children: { type: string; id: string; version: number; title: string; needsOwner: boolean }[];
  skipped: SkippedRow[];
  /** The types touched, the target's included (the token needs `write:entity:<type>` for each). */
  closeTypes: string[];
  /** The target plus every row it takes with it. */
  rowCount: number;
  /** Something under it is the owner's call. */
  needsOwner: boolean;
  /** The commitment is shared to a calendar. */
  shared: boolean;
}

/** The version of one closable row, null when it is missing or another user's; a proposal's staleness check reads it. */
export async function closeRowVersion(
  sql: Sql,
  userId: string,
  type: CloseType,
  rawId: string
): Promise<number | null> {
  const row = await readRow(sql, userId, type, await storedIdFor(type, userId, rawId), false);
  return row?.version ?? null;
}

export async function previewClose(sql: Sql, command: CloseEntityCommand): Promise<ClosePreview> {
  const userId = await ensureUser(sql);
  const { type } = command;
  const id = await storedIdFor(type, userId, command.id);
  const row = await readRow(sql, userId, type, id, false);
  const base = {
    found: false,
    status: null,
    version: null,
    closedBy: null,
    children: [],
    skipped: [],
    closeTypes: [type],
    rowCount: 1,
    needsOwner: false,
    shared: false
  };
  if (!row) return base;
  const ctx = cascadeContext(userId, type, id, command, row.version, command.reason);
  if (command.do === "restore") {
    const entries =
      command.includeChildren || type === "commitment"
        ? await batchEntries(sql, userId, type, id, row.closed_batch)
        : [];
    const shared =
      type === "commitment"
        ? ((await sql<{ s: boolean }[]>`SELECT share_to_calendar AS s FROM commitments WHERE id=${id}`)[0]?.s ?? false)
        : false;
    return {
      ...base,
      found: true,
      status: row.status,
      version: row.version,
      closedBy: row.closed_by,
      children: entries.map((entry) => ({
        type: entry.type,
        id: entry.id,
        version: entry.version,
        title: "",
        needsOwner: false
      })),
      closeTypes: [...new Set([type, ...entries.map((entry) => entry.type)])],
      rowCount: 1 + entries.length,
      shared,
      needsOwner: shared
    };
  }
  const plan = await planClose(sql, ctx, { lock: false, refuse: false });
  return {
    found: true,
    status: row.status,
    version: row.version,
    closedBy: row.closed_by,
    children: plan.rows.map((r) => ({
      type: r.type,
      id: r.id,
      version: r.version,
      title: r.title,
      needsOwner: r.needsOwner
    })),
    skipped: plan.skipped,
    closeTypes: [...new Set([type, ...plan.rows.map((r) => r.type)])],
    rowCount: 1 + plan.rows.length,
    needsOwner: plan.needsOwner,
    shared: plan.shared
  };
}
