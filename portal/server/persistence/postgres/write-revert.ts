import { isClosedStatus } from "@openrhen/contracts";
import { changeLogConfirmedBy, requestAgent } from "@/server/agent-actor";
import { REENTERED_REASON } from "@/server/pulse/pulse-reentry";
import type { RevertCommand } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { claimCommandReceipt, commandRequestHash, hasCommandReceipt } from "./command-receipt";
import {
  CommandConflictError,
  ForbiddenCommandError,
  InvalidCommandError,
  NotFoundCommandError,
  openSessionConflict,
  revertConflict
} from "./command-errors";
import { assertCloseBudget, lockCloseBudget } from "./close-budget";
import { refuseDeletingReferencedRows } from "./delete-guard";
import { hasCycle } from "./graph-checks";
import { assertNoPrerequisiteCycle } from "./prerequisites";
import { ensureUser } from "./ensure-user";
import { localMomentFormatter } from "./local-moment";
import { recordStateChange } from "./planning-evidence";
import { overlappingNight } from "./sleep-wake";
import type { PendingQuery } from "postgres";
import type { PoolSql, TxSql } from "./sql-pool";
import { readStateAfterCommit } from "./read-after-commit";
import {
  snapshotKeyColumns,
  SNAPSHOT_TABLES,
  systemColumnsFor,
  COMPARE_ONLY_SYSTEM_COLUMNS,
  imageExpression,
  keyCondition,
  readImages,
  type SnapshotKind,
  type SnapshotRow,
  type SnapshotTable
} from "./write-snapshot";

/**
 * Undo and redo of an agent's session, check-in or catch-up write from the row snapshot `WriteSnapshot` kept
 * for it. These writes change several rows that no restating
 * command can put back, so the server puts the stored images back itself, and only while nothing has touched the
 * rows since: an edit made after the agent's write is never overwritten (unless `force`).
 *
 * A row image is `to_jsonb` of the row. `undone` is the images as the last undo left them, which a redo expects to
 * find; a redo then overwrites `after` with what it left, so the next undo is checked against the right images.
 */
type Image = Record<string, unknown> | null;
interface StoredRow extends SnapshotRow {
  undone?: Image;
}

const KIND_LABEL: Record<SnapshotKind, string> = {
  session: "This session",
  check_in: "This check-in",
  catch_up: "This catch-up settle",
  confirm: "This confirm",
  save: "This save",
  activity: "This activity change",
  recurrence: "This recurrence change",
  cadence: "This cadence completion",
  wake: "This wake",
  reenter: "This re-entry",
  stretch: "This stretch answer",
  disruption: "This disruption"
};

/** The tables whose `status` a close writes (the eight closeable kinds). */
const CLOSEABLE_TABLES: ReadonlySet<string> = new Set([
  "areas",
  "outcomes",
  "projects",
  "actions",
  "deliverables",
  "commitments",
  "routine_presets",
  "condition_definitions"
]);

/** How many of the rows go from open to closed when each is put at its target image. */
function closingRows(
  rows: readonly StoredRow[],
  expectedOf: (row: StoredRow) => Image,
  targetOf: (row: StoredRow) => Image
): number {
  const statusOf = (image: Image) => (typeof image?.status === "string" ? image.status : null);
  return rows.filter((row) => {
    if (!CLOSEABLE_TABLES.has(row.table)) return false;
    const to = statusOf(targetOf(row));
    const from = statusOf(expectedOf(row));
    return to !== null && from !== null && isClosedStatus(to) && !isClosedStatus(from);
  }).length;
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQLSTATE_UNIQUE_VIOLATION = "23505";
const SQLSTATE_FOREIGN_KEY_VIOLATION = "23503";

export async function runRevertCommand(sql: PoolSql, command: RevertCommand): Promise<PortalState> {
  const userId = await ensureUser(sql);
  const requestHash = commandRequestHash(`revert_${command.direction}`, command);
  if (
    await hasCommandReceipt(sql, {
      id: command.commandId,
      userId,
      commandType: `revert_${command.direction}`,
      requestHash
    })
  )
    return await readStateAfterCommit(sql);
  await sql.begin(async (tx) => {
    // A request racing its own retry passes the pre-check above in both; the loser finds the receipt taken
    // and replays (see `claimCommandReceipt`).
    if (
      !(await claimCommandReceipt(tx, {
        id: command.commandId,
        userId,
        commandType: `revert_${command.direction}`,
        requestHash
      }))
    )
      return;
    await revert(tx, userId, command);
  });
  return await readStateAfterCommit(sql);
}

async function revert(tx: TxSql, userId: string, command: RevertCommand): Promise<void> {
  if (UUID.test(command.target)) {
    const changeset = await tx<{ response: { members?: unknown }; state: string | null }[]>`
      SELECT response, state FROM writes WHERE user_id=${userId} AND id=${command.target} AND command_type='changeset' FOR UPDATE`;
    if (changeset[0]) return revertChangeset(tx, userId, command, changeset[0]);
    // A member is undone with its set, never alone, so the set never says applied over a member that is not.
    const within = await tx<{ id: string }[]>`
      SELECT id FROM writes WHERE user_id=${userId} AND command_type='changeset' AND response->'members' ? ${command.target} LIMIT 1`;
    if (within[0])
      throw new CommandConflictError(
        `Write ${command.target} is part of changeset ${within[0].id}, and a changeset is undone or redone whole. Use the changeset id instead.`,
        {
          nextCall: {
            tool: "rhen_undo",
            arguments: { id: within[0].id, ...(command.direction === "redo" ? { redo: true } : {}) }
          }
        }
      );
  }
  await revertOne(tx, userId, command);
}

/**
 * A changeset is undone as one write: its members newest first (redo: oldest
 * first), each checked against its own images, in the caller's one transaction, so one refusal leaves every member
 * as it was. Two members on the same row stay right because each one's images follow the one before. A member that
 * kept no images (a deliverable save) is not undone; the preview and the apply already said so. One that kept them
 * and has since lost them (the newest 500) refuses the whole set, which can no longer be put back whole. The cycle
 * check runs once over every member's rows after the last one, since a walk can pass through a state no member
 * leaves.
 */
async function revertChangeset(
  tx: TxSql,
  userId: string,
  command: RevertCommand,
  changeset: { response: { members?: unknown; undoable?: unknown }; state: string | null }
): Promise<void> {
  const undoing = command.direction === "undo";
  if (undoing && changeset.state !== "applied")
    throw new CommandConflictError(
      `Changeset ${command.target} is already undone, so there is nothing to undo. To put it back, redo it.`,
      { nextCall: { tool: "rhen_undo", arguments: { id: command.target, redo: true } } }
    );
  if (!undoing && changeset.state !== "undone")
    throw new CommandConflictError(`Changeset ${command.target} is not undone, so there is nothing to redo.`, {
      nextCall: { tool: "rhen_undo", arguments: { list: true }, note: "shows the recorded writes with their ids" }
    });
  const members = Array.isArray(changeset.response.members)
    ? changeset.response.members.filter((member): member is string => typeof member === "string" && UUID.test(member))
    : [];
  const kept = new Set(
    (
      await tx<{ id: string }[]>`
        SELECT id FROM writes WHERE user_id=${userId} AND id::text IN ${tx(members.length ? members : [""])}
          AND images IS NOT NULL AND state IS NOT NULL`
    ).map((row) => row.id)
  );
  // Which members kept images when the set was applied; a set applied before this was recorded counts what is kept.
  const undoable = Array.isArray(changeset.response.undoable)
    ? members.filter((member) => (changeset.response.undoable as unknown[]).includes(member))
    : members.filter((member) => kept.has(member));
  if (undoable.some((member) => !kept.has(member)))
    throw new NotFoundCommandError(
      `That changeset is too old to ${undoing ? "undo" : "redo"} whole: the portal keeps what the newest 500 writes changed, and some of its writes are older. Make a fresh save instead; rhen_undo with list true shows which writes can still be reversed.`,
      {
        nextCall: {
          tool: "rhen_undo",
          arguments: { list: true },
          note: "shows the recorded writes with their ids"
        }
      }
    );
  const order = undoing ? [...undoable].reverse() : undoable;
  const walked: StoredRow[] = [];
  for (const member of order) await revertOne(tx, userId, { ...command, target: member }, walked);
  await refuseDependencyCycle(tx, userId, walked);
  await tx`
    UPDATE writes SET state=${undoing ? "undone" : "applied"}, updated_at=now()
    WHERE user_id=${userId} AND id=${command.target}`;
}

/**
 * Why a re-entry cannot be put back, and what to do instead. The plan's pulse recorder re-evaluates within seconds
 * and ends the "back on plan" segment as soon as the pulse moves on (for example to free), and a later write can touch
 * the place, energy or contexts the re-entry set; either is a change this undo must not overwrite.
 */
function reenterRefusal(undoing: boolean, byAgent: boolean): string {
  if (!undoing)
    return "This re-entry cannot be redone: the pulse or the facts it set have changed since it was undone. Ask the owner what they want; rhen_reenter only works while the pulse is lapsed.";
  return (
    "This re-entry can no longer be undone: the plan's pulse has moved on since it was written (a check-in, a session or a new lapse followed it), or the place, energy or contexts it set were changed afterwards. " +
    "An undo of a re-entry only works until then (the pulse moving to free or asleep by itself does not stop it), and rhen_reenter cannot be used again while the pulse is on. " +
    "Nothing was changed. To correct a wrong answer: tell the owner, set the place with rhen_arrive, and for energy or contexts ask the owner to correct them in the portal" +
    (byAgent ? " (or undo the re-entry there from Review > Agent changes)." : ".")
  );
}

/**
 * The pulse recorder ends a re-entry's `on/reentered` segment within seconds, by opening whatever it judges next. When
 * that is only the plan's own derived state (free, asleep, or a scheduled commitment, none of it a confirmation by
 * anyone), the re-entry is still the newest thing anyone said about the pulse, so this puts the segment back open and
 * drops those derived segments; the ordinary comparison and restore then bring the lapsed segment back, and there are
 * never two open. Anything else after it (a check-in, a session, a new lapse, a gap, a disruption) is real history:
 * it is left in place and the comparison refuses the undo as before. Runs in the revert's transaction, so a refusal
 * further on puts everything back. Takes the recorder's own lock so a tick cannot add a segment while this reads.
 */
async function reopenReenteredSegment(tx: TxSql, userId: string, rows: StoredRow[]): Promise<void> {
  const image = rows.find(
    (row) => row.table === "pulse_segments" && row.after !== null && row.after.reason === REENTERED_REASON
  );
  if (!image) return;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`pulse_recorder:${userId}`}, 0))`;
  const own = await tx<{ ended_at: Date | null }[]>`
    SELECT ended_at FROM pulse_segments WHERE id=${image.id} AND user_id=${userId} FOR UPDATE`;
  const endedAt = own[0]?.ended_at;
  if (!endedAt) return;
  const later = await tx<
    {
      id: string;
      state: string;
      reason: string | null;
      source: string | null;
      started_at: Date;
      ended_at: Date | null;
    }[]
  >`
    SELECT id, state, reason, source, started_at, ended_at FROM pulse_segments
    WHERE user_id=${userId} AND id <> ${image.id} AND started_at >= ${endedAt} ORDER BY started_at, created_at FOR UPDATE`;
  const derived = (segment: (typeof later)[number]) =>
    (segment.state === "free" && segment.reason === "free") ||
    (segment.state === "asleep" && segment.reason === "asleep") ||
    (segment.state === "on" && segment.reason === "scheduled" && segment.source === "schedule");
  // Contiguous from the end of the re-entry's segment, so nothing sits between that the recorder did not write.
  let cursor = endedAt.getTime();
  for (const segment of later) {
    if (!derived(segment) || segment.started_at.getTime() !== cursor) return;
    if (segment.ended_at) cursor = segment.ended_at.getTime();
    else cursor = Number.NaN;
  }
  const disrupted = await tx`
    SELECT 1 FROM pulse_disruptions WHERE user_id=${userId} AND created_at >= ${new Date(String(image.after!.started_at))} LIMIT 1`;
  if (disrupted.length > 0) return;
  if (later.length > 0)
    await tx`DELETE FROM pulse_segments WHERE user_id=${userId} AND id IN ${tx(later.map((segment) => segment.id))}`;
  await tx`UPDATE pulse_segments SET ended_at=NULL WHERE id=${image.id} AND user_id=${userId}`;
}

/** `walked`: a changeset's walk collects each member's rows here and checks for a cycle once, after the last. */
async function revertOne(tx: TxSql, userId: string, command: RevertCommand, walked?: StoredRow[]): Promise<void> {
  // A target that is not a uuid names no write, so it is answered like one that kept no images.
  const found = UUID.test(command.target)
    ? await tx<{ agent: string | null; kind: SnapshotKind; rows: StoredRow[]; state: string }[]>`
    SELECT actor AS agent, kind, images AS rows, state FROM writes
    WHERE user_id=${userId} AND id=${command.target} AND images IS NOT NULL AND state IS NOT NULL FOR UPDATE`
    : [];
  const snapshot = found[0];
  // The rows name tables the SQL below writes to by name, so a stored snapshot is checked again on the way out.
  if (
    snapshot &&
    (!(snapshot.kind in KIND_LABEL) ||
      !snapshot.rows.every((row) => (SNAPSHOT_TABLES as readonly string[]).includes(row.table)))
  )
    throw new Error(`The snapshot for ${command.target} names a table or kind a revert does not handle.`);
  if (!snapshot)
    throw new NotFoundCommandError(
      `Nothing was kept to undo write ${command.target} with: it was not an agent's write, it saved nothing to put back, or it is older than the newest 500. Ask the owner to undo it from Review > Agent changes, or make a fresh save. Call rhen_undo with list true to see the writes that can be reversed.`,
      {
        nextCall: {
          tool: "rhen_undo",
          arguments: { list: true },
          note: "shows the recorded writes with their ids"
        }
      }
    );
  // An agent may undo only its own writes; the owner (no agent) may undo any.
  const caller = requestAgent();
  if (caller !== null && caller !== snapshot.agent)
    throw new ForbiddenCommandError(
      `Write ${command.target} was made by another agent; only that agent, or the owner, can undo it. List your own writes to pick one.`,
      {
        nextCall: {
          tool: "rhen_undo",
          arguments: { list: true },
          note: "shows the recorded writes with their ids"
        }
      }
    );
  // A confirmed proposal runs as the proposing agent with the owner's confirm on it, so the check above passes for
  // that agent. The owner decided that write; an agent reversing it would overrule them.
  if (caller !== null) {
    const confirmed = await tx`
      SELECT 1 FROM write_rows WHERE write_id=${command.target} AND user_id=${userId}
        AND evidence->>'confirmedBy'='owner' LIMIT 1`;
    if (confirmed.length > 0)
      throw new ForbiddenCommandError(
        `Write ${command.target} was a proposal the owner confirmed, so only the owner can undo or redo it; an agent cannot reverse a change the owner approved. Ask the owner to undo it from Review > Agent changes, or make a fresh save that changes it back (it files a new proposal if it needs their confirm). Call rhen_undo with list true to see the writes you can reverse yourself.`,
        {
          nextCall: {
            tool: "rhen_undo",
            arguments: { list: true },
            note: "shows the writes you may reverse; this one is the owner's to undo"
          }
        }
      );
  }
  // Forcing overwrites whatever the person changed since, so only the person may (Review -> Agent changes).
  if (caller !== null && command.force === true)
    throw new ForbiddenCommandError(
      "Only the owner can undo or redo over a later change; ask them to do it from Review > Agent changes, or make a fresh save."
    );
  const undoing = command.direction === "undo";
  if (undoing && snapshot.state !== "applied")
    throw new CommandConflictError(
      `Write ${command.target} is already undone, so there is nothing to undo. To put it back, redo it.`,
      { nextCall: { tool: "rhen_undo", arguments: { id: command.target, redo: true } } }
    );
  if (!undoing && snapshot.state !== "undone")
    throw new CommandConflictError(`Write ${command.target} is not undone, so there is nothing to redo.`, {
      nextCall: { tool: "rhen_undo", arguments: { list: true }, note: "shows the recorded writes with their ids" }
    });

  const rows = snapshot.rows;
  // Where the rows must stand now (the write's result, or what the last undo left) and where they go.
  const expectedOf = (row: StoredRow): Image =>
    undoing ? row.after : "undone" in row ? (row.undone ?? null) : row.before;
  const targetOf = (row: StoredRow): Image => (undoing ? row.before : row.after);
  // Columns the planner owns on some rows (see `CONDITIONAL_SYSTEM_COLUMNS`). The comparison skips what is the
  // system's on the row as it must stand now. The restore skips a column only when it is the system's both on the
  // row now and on the image going back, so a hand-set image is written over a row the planner has since rewritten.
  const comparedSkipOf = (row: StoredRow) => [
    ...systemColumnsFor(row.table, expectedOf(row)),
    ...(COMPARE_ONLY_SYSTEM_COLUMNS[row.table] ?? [])
  ];
  const restoredSkipOf = (row: StoredRow) => systemColumnsFor(row.table, expectedOf(row), targetOf(row));

  // An agent's redo of a close, or undo of a restore, puts rows back closed: the hourly brake counts them like the close
  // they repeat (taken first, ahead of the row locks, in the order every closer uses).
  const closing = caller !== null && changeLogConfirmedBy() !== "owner" ? closingRows(rows, expectedOf, targetOf) : 0;
  if (closing > 0) {
    await lockCloseBudget(tx, userId);
    try {
      await assertCloseBudget(tx, userId, closing, {
        nextCall: {
          tool: "rhen_undo",
          arguments: { id: command.target, ...(undoing ? {} : { redo: true }) },
          note: "repeat once closures have aged out of the hour, or ask the owner to do it from Review > Agent changes"
        }
      });
    } catch (error) {
      if (error instanceof CommandConflictError)
        throw new CommandConflictError(
          error.message.replace(
            / Repeat the call and it is filed as a proposal for the owner to confirm\./,
            " Wait until it ages out, or ask the owner to do it from Review > Agent changes."
          ),
          error.nextCall === undefined ? {} : { nextCall: error.nextCall }
        );
      throw error;
    }
  }

  if (undoing && snapshot.kind === "reenter") await reopenReenteredSegment(tx, userId, rows);

  if (command.force !== true) {
    for (const row of rows) {
      if (!(await currentMatches(tx, row.table, row.id, expectedOf(row), comparedSkipOf(row), snapshot.kind)))
        throw revertConflict(
          snapshot.kind === "reenter"
            ? reenterRefusal(undoing, caller !== null)
            : `${KIND_LABEL[snapshot.kind]} was changed after ${undoing ? "the agent's write" : "it was undone"}, so ${undoing ? "undoing" : "redoing"} it would overwrite that change.${caller !== null ? " Ask the owner to undo it from Review > Agent changes, or make a fresh save." : ""}`,
          "shows the recorded writes with their ids and state; a later write is what blocks this one"
        );
    }
  }

  if (command.force !== true)
    await refuseDeletingReferencedRows(tx, rows, targetOf, {
      kind: KIND_LABEL[snapshot.kind],
      undoing,
      byAgent: caller !== null
    });
  await refuseSecondOpenSession(tx, userId, rows, targetOf);
  await refuseOverlappingNights(
    tx,
    userId,
    rows,
    targetOf,
    `${KIND_LABEL[snapshot.kind]} cannot be ${undoing ? "undone" : "redone"}`
  );
  try {
    await restore(tx, rows, targetOf, restoredSkipOf);
    if (snapshot.kind === "stretch") await restoreStretchKey(tx, rows, targetOf);
  } catch (error) {
    // A row coming back would take a slot something newer now holds (the next pending check-in the scheduler
    // opened, a cadence completion already logged for that day): refuse rather than fail with a 500.
    if ((error as { code?: string }).code === SQLSTATE_UNIQUE_VIOLATION)
      throw revertConflict(
        `${KIND_LABEL[snapshot.kind]} cannot be ${undoing ? "undone" : "redone"}: something newer has taken its place since. Nothing was changed.${caller !== null ? " Ask the owner to resolve it from Review > Agent changes, or make a fresh save." : ""}`,
        "shows the recorded writes with their ids; the newer one is what took its place"
      );
    // A row going away is still referenced by something newer (a session on a created action, an action added to a
    // created project), or a row coming back points at one that is gone.
    if ((error as { code?: string }).code === SQLSTATE_FOREIGN_KEY_VIOLATION)
      throw revertConflict(
        `${KIND_LABEL[snapshot.kind]} cannot be ${undoing ? "undone" : "redone"}: something newer now refers to what it ${undoing ? "made" : "removed"}. Nothing was changed.${caller !== null ? " Ask the owner to resolve it from Review > Agent changes, or make a fresh save." : ""}`,
        "shows the recorded writes with their ids; the newer one is what refers to it"
      );
    throw error;
  }

  if (walked) walked.push(...rows);
  else await refuseDependencyCycle(tx, userId, rows);

  // The rows as the restore left them: what a redo will expect (undo), or what the next undo will expect (redo).
  const imagesByTable = new Map<SnapshotTable, Map<string, Image>>();
  for (const row of rows) {
    const images = imagesByTable.get(row.table) ?? new Map<string, Image>();
    images.set(row.id, await readImage(tx, row.table, row.id, false, snapshot.kind));
    imagesByTable.set(row.table, images);
  }
  const updated: StoredRow[] = rows.map((row) => {
    const image = imagesByTable.get(row.table)!.get(row.id) ?? null;
    return undoing ? { ...row, undone: image } : { ...row, after: image };
  });
  await tx`
    UPDATE writes SET images=${tx.json(updated as never)}, state=${undoing ? "undone" : "applied"}, updated_at=now()
    WHERE user_id=${userId} AND id=${command.target}`;

  // The ledger row the brake counts from: the rows this revert closed.
  if (closing > 0)
    await recordStateChange(tx, userId, {
      entityType: snapshot.kind,
      entityId: command.target,
      operation: "close",
      commandId: command.commandId,
      evidence: { closed: closing, via: "revert", target: command.target, counted: true },
      at: new Date()
    });

  // Through the one write path so the plan recalculates and the change log names the revert.
  await recordStateChange(tx, userId, {
    entityType: snapshot.kind,
    entityId: command.target,
    operation: command.direction,
    commandId: command.commandId,
    evidence: {
      target: command.target,
      agent: snapshot.agent,
      rows: rows.length,
      ...(command.force === true ? { forced: true } : {})
    },
    at: new Date()
  });
}

/**
 * Restoring edges can close a loop that was fine when the write was made (a dependency removed by the write, and the
 * reverse one added by someone since). The ordinary saves refuse a cycle; so does the revert, as a conflict.
 */
async function refuseDependencyCycle(tx: TxSql, userId: string, rows: StoredRow[]): Promise<void> {
  const touched = (table: SnapshotTable) => rows.some((row) => row.table === table);
  if (
    !touched("action_dependencies") &&
    !touched("entity_prerequisites") &&
    !touched("deliverable_dependencies") &&
    !touched("routine_step_dependencies") &&
    !touched("condition_definitions")
  )
    return;
  const edges = await tx<{ a: string; b: string }[]>`
    SELECT ad.action_id::text AS a, ad.depends_on_action_id::text AS b FROM action_dependencies ad
    JOIN actions ac ON ac.id=ad.action_id JOIN projects p ON p.id=ac.project_id
    JOIN outcomes o ON o.id=p.outcome_id JOIN areas ar ON ar.id=o.area_id WHERE ar.user_id=${userId}`;
  const graph = new Map<string, string[]>();
  for (const edge of edges) graph.set(edge.a, [...(graph.get(edge.a) ?? []), edge.b]);
  const deliverableEdges = await tx<{ a: string; b: string }[]>`
    SELECT dd.deliverable_id::text AS a, dd.depends_on_deliverable_id::text AS b FROM deliverable_dependencies dd
    JOIN deliverables d ON d.id=dd.deliverable_id JOIN projects p ON p.id=d.project_id
    JOIN outcomes o ON o.id=p.outcome_id JOIN areas ar ON ar.id=o.area_id WHERE ar.user_id=${userId}`;
  const deliverableGraph = new Map<string, string[]>();
  for (const edge of deliverableEdges) deliverableGraph.set(edge.a, [...(deliverableGraph.get(edge.a) ?? []), edge.b]);
  // A routine's steps may not wait on each other in a loop (the routine step save refuses it, per commitment).
  const stepEdges = await tx<{ a: string; b: string }[]>`
    SELECT d.step_id::text AS a, d.depends_on_step_id::text AS b FROM routine_step_dependencies d
    JOIN routine_steps s ON s.id=d.step_id WHERE s.user_id=${userId}`;
  const stepGraph = new Map<string, string[]>();
  for (const edge of stepEdges) stepGraph.set(edge.a, [...(stepGraph.get(edge.a) ?? []), edge.b]);
  // Nor may a capability's pathways reach the capability itself (the context save refuses it).
  const conditions = await tx<{ id: string; pathways: unknown }[]>`
    SELECT id, pathways FROM condition_definitions WHERE user_id=${userId}`;
  const pathwayGraph = new Map<string, string[]>(
    conditions.map((row) => [row.id, (Array.isArray(row.pathways) ? (row.pathways as string[][]) : []).flat()])
  );
  let cycle = hasCycle(graph) || hasCycle(deliverableGraph) || hasCycle(stepGraph) || hasCycle(pathwayGraph);
  if (!cycle)
    try {
      await assertNoPrerequisiteCycle(tx, userId);
    } catch (error) {
      if (!(error instanceof InvalidCommandError)) throw error;
      cycle = true;
    }
  if (cycle)
    throw revertConflict(
      "Putting those dependencies back would make a cycle with ones added since, so nothing was changed. Remove the newer dependency first, then repeat this undo or redo.",
      "shows the recorded writes with their ids; the newer dependency is among the later ones"
    );
}

/**
 * A session coming back open (undoing its finish, block or start, or redoing a start) must not leave the person with
 * two open sessions: the start command refuses a second one, and `sessions_one_running_per_user` would make the
 * restore fail as a database error. Another session opened since is a conflict, even with `force`, since forcing is
 * for edits to the snapshot's own rows.
 */
async function refuseSecondOpenSession(
  tx: TxSql,
  userId: string,
  rows: StoredRow[],
  targetOf: (row: StoredRow) => Image
): Promise<void> {
  for (const row of rows) {
    const target = targetOf(row);
    if (row.table !== "sessions" || target === null) continue;
    if (target.ended_at !== null || !OPEN_SESSION_STATUSES.includes(String(target.status))) continue;
    const others = await tx<{ id: string; status: string; target_type: string | null }[]>`
      SELECT id,status,target_type FROM sessions
      WHERE user_id=${userId} AND ended_at IS NULL AND status IN ${tx(OPEN_SESSION_STATUSES)} AND id::text <> ${row.id}
      LIMIT 1`;
    if (others[0]) {
      const open = openSessionConflict(others[0]);
      throw new CommandConflictError(
        `Another session is open now (id ${others[0].id}, ${others[0].status}), so bringing this one back would leave two open. End the other session first, then repeat this undo or redo.`,
        { nextCall: open.nextCall! }
      );
    }
  }
}

/** Tables with a unique `(parent, sequence)`: routine steps and preset steps. */
const SEQUENCED_TABLES: readonly SnapshotTable[] = ["routine_steps", "routine_preset_steps"];

const OPEN_SESSION_STATUSES = ["running", "paused", "awaiting_feedback"];

/**
 * A night coming back slept or completed (redoing a wake after a replacement night was logged, or undoing a finish
 * after a later night was) must not overlap a night recorded since: the sleep log refuses a second night for the
 * same hours, and the revert holds to the same rule (`overlappingNight`, shared with `refuseOverlappingNight`). Like a
 * second open session, this is a conflict even with `force`.
 */
async function refuseOverlappingNights(
  tx: TxSql,
  userId: string,
  rows: StoredRow[],
  targetOf: (row: StoredRow) => Image,
  refusal: string
): Promise<void> {
  const nights = rows.filter((row) => row.table === "sleep_plans");
  const own = nights.map((row) => row.id);
  for (const row of nights) {
    const target = targetOf(row);
    if (target === null || (target.status !== "completed" && target.status !== "sleeping")) continue;
    if (typeof target.actual_start_at !== "string") continue;
    const wake =
      target.status === "completed" && typeof target.actual_wake_at === "string" ? target.actual_wake_at : null;
    const other = await overlappingNight(
      tx,
      userId,
      own,
      new Date(target.actual_start_at),
      wake ? new Date(wake) : null
    );
    if (!other) continue;
    const local = await localMomentFormatter(tx, userId, new Date());
    throw new CommandConflictError(
      other.status === "sleeping"
        ? `${refusal}: a sleep started ${local(other.actual_start_at)} is running now (id ${other.id}), and the night it would bring back overlaps it. Finish that sleep first (rhen_wake), then repeat this undo or redo.`
        : `${refusal}: a night logged since, from ${local(other.actual_start_at)} to ${local(other.actual_wake_at!)} (id ${other.id}), overlaps the one it would bring back. Read that night, and correct or remove it before repeating this undo or redo.`,
      {
        nextCall: {
          tool: "rhen_show",
          arguments: { entity: "sleep-plan", id: other.id },
          note: other.status === "sleeping" ? "the running sleep; end it with rhen_wake" : "the overlapping night"
        }
      }
    );
  }
}

/**
 * The row's current image as `kind` images it (`imageExpression`), or null when it does not exist. `lock` takes
 * `FOR UPDATE` so the check and the restore agree.
 */
async function readImage(
  tx: TxSql,
  table: SnapshotTable,
  id: string,
  lock: boolean,
  kind?: SnapshotKind
): Promise<Image> {
  return (await readImages(tx, table, [id], lock, kind)).get(id) ?? null;
}

/**
 * Whether the row stands as `expected` (null: the row is absent), apart from the columns the system maintains
 * (`SYSTEM_COLUMNS`). Compared as jsonb, so key order is moot.
 */
async function currentMatches(
  tx: TxSql,
  table: SnapshotTable,
  id: string,
  expected: Image,
  skip: readonly string[],
  kind: SnapshotKind
): Promise<boolean> {
  if (expected === null) return (await readImage(tx, table, id, true, kind)) === null;
  // The names are this module's own constants, so they are written into the query rather than sent as a parameter.
  // `version` is moot: a later write to the row bumps it, and what matters is the columns the person sees.
  const skipped = `ARRAY[${[...skip, "version"].map((name) => `'${name}'`).join(", ")}]::text[]`;
  const { where, params } = keyCondition(table, "t", [id], 2);
  // A column added to the table since the image was taken is ignored, as `restore` ignores it: only the keys
  // the expected image holds are compared.
  const current = `(SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each(${imageExpression(table, "t", kind)}) e WHERE $1::jsonb ? e.key)`;
  const query = `SELECT (${current} - ${skipped} = $1::jsonb - ${skipped}) AS same FROM ${quote(table)} t WHERE ${where} FOR UPDATE`;
  const found = await tx.unsafe<{ same: boolean }[]>(query, [expected as never, ...params]);
  return found[0]?.same === true;
}

/**
 * Puts each row at its target image: deletes first in reverse `SNAPSHOT_TABLES` order (children before the
 * parents they reference), which also frees any unique slot a row coming back needs, then inserts and updates in
 * `SNAPSHOT_TABLES` order (parents before the children that reference them). A table with a `version` column
 * gets the current version + 1 rather than the image's, so a client holding the old version sees a change, and
 * `updated_at` is now. An update leaves the `SYSTEM_COLUMNS` as they are.
 */
async function restore(
  tx: TxSql,
  rows: StoredRow[],
  targetOf: (row: StoredRow) => Image,
  skippedOf: (row: StoredRow) => readonly string[]
): Promise<void> {
  const order = (row: StoredRow) => SNAPSHOT_TABLES.indexOf(row.table);
  const forward = [...rows].sort((a, b) => order(a) - order(b));
  const columnsOf = new Map<SnapshotTable, string[]>();
  const columnsFor = async (table: SnapshotTable): Promise<string[]> => {
    const cached = columnsOf.get(table);
    if (cached) return cached;
    // Generated and always-identity columns cannot be written; everything else comes from the image.
    const found = await tx<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name=${table}
        AND is_generated='NEVER' AND (identity_generation IS NULL OR identity_generation <> 'ALWAYS')
      ORDER BY ordinal_position`;
    const names = found.map((column) => column.column_name);
    columnsOf.set(table, names);
    return names;
  };

  // Rows whose `sequence` is unique within their parent: a swap would collide whichever row is written first, so the
  // rows going back are parked at distinct negative slots, and the targets are written over them below.
  let parked = 0;
  for (const row of forward) {
    if (!SEQUENCED_TABLES.includes(row.table) || targetOf(row) === null) continue;
    const { where, params } = keyCondition(row.table, "t", [row.id], 2);
    await tx.unsafe(`UPDATE ${quote(row.table)} t SET "sequence" = $1 WHERE ${where}`, [
      --parked,
      ...params
    ] as never[]);
  }

  for (const row of [...forward].reverse()) {
    if (targetOf(row) !== null) continue;
    const { where, params } = keyCondition(row.table, "t", [row.id]);
    await clearDerivedRows(tx, row.table, row.id);
    await tx.unsafe(`DELETE FROM ${quote(row.table)} t WHERE ${where}`, params);
  }
  for (const row of forward) {
    const target = targetOf(row);
    if (target === null) continue;
    // Only the columns the image holds: one added to the table since the snapshot keeps its value (or its default).
    const names = (await columnsFor(row.table)).filter((name) => name in target);
    const table = quote(row.table);
    const populate = `jsonb_populate_record(NULL::${table}, $1::jsonb)`;
    // A jsonb parameter takes the object itself: postgres.js serialises it, so a pre-stringified image would arrive as a JSON string.
    const image = target as never;
    const present = keyCondition(row.table, "t", [row.id]);
    const exists = await tx.unsafe(`SELECT 1 FROM ${table} t WHERE ${present.where} FOR UPDATE`, present.params);
    const hasVersion = names.includes("version");
    const hasUpdatedAt = names.includes("updated_at");
    if (exists.length === 0) {
      const values = names.map((name) =>
        name === "version" ? `r."version" + 1` : name === "updated_at" ? "now()" : `r.${quote(name)}`
      );
      await tx.unsafe(
        `INSERT INTO ${table} (${names.map(quote).join(", ")}) SELECT ${values.join(", ")} FROM ${populate} r`,
        [image]
      );
    } else {
      // The system's own columns keep their current values; the recalculation after the revert refreshes them.
      const skip = skippedOf(row);
      const sets = names
        .filter((name) => !snapshotKeyColumns(row.table).includes(name) && name !== "version" && !skip.includes(name))
        .map((name) => `${quote(name)} = r.${quote(name)}`);
      if (hasVersion) sets.push(`"version" = cur."version" + 1`);
      if (hasUpdatedAt) sets.push(`"updated_at" = now()`);
      // A link row with nothing but its key (an action's requirement) is already as the image says.
      if (sets.length === 0) continue;
      const current = keyCondition(row.table, "cur", [row.id], 2);
      await tx.unsafe(`UPDATE ${table} cur SET ${sets.join(", ")} FROM ${populate} r WHERE ${current.where}`, [
        image,
        ...current.params
      ]);
    }
  }
}

/**
 * A `stretch` snapshot images only the `stretch` key of `user_preferences.current_situation` (`imageExpression`), which
 * the generic restore cannot write back (it is no column). Sets or removes just that key, so everything else in the
 * situation, a location the phone reported since among it, stays as it is. The version and `updated_at` were bumped by
 * `restore`.
 */
async function restoreStretchKey(tx: TxSql, rows: StoredRow[], targetOf: (row: StoredRow) => Image): Promise<void> {
  for (const row of rows) {
    if (row.table !== "user_preferences") continue;
    const target = targetOf(row);
    if (target === null) continue;
    // `user_preferences` is keyed by `user_id` alone, so the stored id is the user id.
    const userId = row.id;
    const stretch = target.stretch ?? null;
    if (stretch === null)
      await tx`UPDATE user_preferences SET current_situation=COALESCE(current_situation,'{}'::jsonb) - 'stretch' WHERE user_id=${userId}`;
    else
      await tx`UPDATE user_preferences SET current_situation=jsonb_set(COALESCE(current_situation,'{}'::jsonb),'{stretch}',${tx.json(stretch as never)}) WHERE user_id=${userId}`;
  }
}

/**
 * Removes the planner's own output that points at a row about to be deleted, which would otherwise block the delete:
 * the ranking and recommendation rows for an action the confirm created, the forecast snapshots of a project it
 * created. Both are regenerated by the next recalculation, and neither is something the person edits. Anything a
 * person or an agent made that points at the row (a session on the action, an action in the project) is left, and
 * its foreign key refuses the delete as a conflict.
 */
async function clearDerivedRows(tx: TxSql, table: SnapshotTable, id: string): Promise<void> {
  if (table === "actions") {
    await tx`DELETE FROM recommendation_candidates WHERE action_id::text = ${id}`;
    await tx`UPDATE recommendations SET primary_action_id = NULL, primary_occurrence_id = NULL WHERE primary_action_id::text = ${id}`;
  } else if (table === "projects") {
    await tx`DELETE FROM forecast_snapshots WHERE project_id::text = ${id}`;
  } else if (table === "action_recurrence_rules") {
    // The planner's occurrences of a series the write made; it lays them out again for any series that stays.
    await clearOccurrenceReferences(tx, tx`SELECT id FROM action_occurrences WHERE rule_id::text = ${id}`);
    await tx`DELETE FROM action_occurrences WHERE rule_id::text = ${id} AND status = 'pending'`;
  } else if (table === "action_recurrence_windows") {
    await clearOccurrenceReferences(tx, tx`SELECT id FROM action_occurrences WHERE window_id::text = ${id}`);
    await tx`DELETE FROM action_occurrences WHERE window_id::text = ${id} AND status = 'pending'`;
  } else if (table === "action_occurrences") {
    await clearOccurrenceReferences(tx, tx`SELECT id FROM action_occurrences WHERE id = ${id}`);
  }
}

/**
 * The planner's ranking rows that name an occurrence (`recommendation_candidates.occurrence_id`,
 * `recommendations.primary_occurrence_id`, both restrictive foreign keys): regenerated by the next recalculation, and
 * they would otherwise stop the occurrence going even when its action stays.
 */
async function clearOccurrenceReferences(tx: TxSql, occurrences: PendingQuery<{ id: string }[]>): Promise<void> {
  const ids = (await occurrences).map((row) => row.id);
  if (ids.length === 0) return;
  await tx`DELETE FROM recommendation_candidates WHERE occurrence_id IN ${tx(ids)}`;
  await tx`UPDATE recommendations SET primary_occurrence_id = NULL WHERE primary_occurrence_id IN ${tx(ids)}`;
}
