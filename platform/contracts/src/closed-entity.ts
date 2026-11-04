/**
 * The closed-entity vocabulary of the archive and cancel tools (the design notes; plan
 * decisions D1, D14, D16). Pure: which types can be closed, which verb each status takes, where a restore lands, the
 * restore call a closed row carries, and the refusals a close or restore raises. The server command
 * (`close-commands.ts`), the route, the CLI and the served text all read this one module.
 */
import { z } from "zod";
import type { AgentCall } from "./agent-error.js";
import { CLOSED_TABLES, isClosedStatus, type ClosedTable } from "./closed-status.js";
import { requiredRefusal, wrongStateRefusal, type Refusal } from "./agent-refusal.js";

/** The eight canonical types a close or restore can name. */
export const CLOSE_TYPES = [
  "area",
  "outcome",
  "project",
  "action",
  "deliverable",
  "commitment",
  "routine_preset",
  "condition_definition"
] as const;
export type CloseType = (typeof CLOSE_TYPES)[number];

export type CloseVerb = "archive" | "cancel";

/** The types `rhen_archive` takes. */
export const ARCHIVE_TYPES = [
  "area",
  "outcome",
  "project",
  "action",
  "deliverable",
  "routine_preset",
  "condition_definition"
] as const satisfies readonly CloseType[];

/**
 * The types `rhen_cancel` takes. `area` is here for one reason: a legacy cancelled area is restored with the
 * cancel tool, because a restore follows the row's state (plan D1). Closing an area with it is refused.
 */
export const CANCEL_TYPES = [
  "area",
  "outcome",
  "project",
  "action",
  "deliverable",
  "commitment"
] as const satisfies readonly CloseType[];

/** The table (key of `CLOSED_TABLES`) each type is stored in. */
export const CLOSE_TABLE_OF: Readonly<Record<CloseType, ClosedTable>> = {
  area: "areas",
  outcome: "outcomes",
  project: "projects",
  action: "actions",
  deliverable: "deliverables",
  commitment: "commitments",
  routine_preset: "routine_presets",
  condition_definition: "condition_definitions"
};

interface VerbRule {
  /** Statuses a close with the archive verb may start from. */
  readonly archiveFrom: readonly string[];
  /** Statuses a close with the cancel verb may start from. */
  readonly cancelFrom: readonly string[];
}

const OPEN_ACTION = ["inbox", "planned", "active", "doing", "waiting", "blocked"] as const;
const OPEN_DELIVERABLE = [
  "needs_breakdown",
  "ready",
  "in_progress",
  "under_review",
  "awaiting_result",
  "ready_to_complete"
] as const;

/** Plan D16. */
const VERB_RULES: Readonly<Record<CloseType, VerbRule>> = {
  area: { archiveFrom: ["active", "paused", "done"], cancelFrom: [] },
  outcome: { archiveFrom: ["active", "paused", "done"], cancelFrom: ["active", "paused"] },
  project: { archiveFrom: ["active", "paused", "done"], cancelFrom: ["active", "paused"] },
  action: { archiveFrom: ["done"], cancelFrom: OPEN_ACTION },
  deliverable: { archiveFrom: ["completed"], cancelFrom: OPEN_DELIVERABLE },
  commitment: { archiveFrom: [], cancelFrom: ["confirmed", "tentative"] },
  routine_preset: { archiveFrom: ["active"], cancelFrom: [] },
  condition_definition: { archiveFrom: ["active"], cancelFrom: [] }
};

export function isCloseType(type: string): type is CloseType {
  return (CLOSE_TYPES as readonly string[]).includes(type);
}

/** The verb rule of a type, or undefined for a type that cannot be closed. */
export function closeVerbRule(type: string): VerbRule | undefined {
  return isCloseType(type) ? VERB_RULES[type] : undefined;
}

/**
 * Which verb(s) a row in this status takes: `archive`, `cancel`, `either`, or null for a closed row, an unknown status
 * or an unknown type.
 */
export function verbFor(type: string, status: string): "archive" | "cancel" | "either" | null {
  const rule = closeVerbRule(type);
  if (rule === undefined) return null;
  const archive = rule.archiveFrom.includes(status);
  const cancel = rule.cancelFrom.includes(status);
  return archive && cancel ? "either" : archive ? "archive" : cancel ? "cancel" : null;
}

/** The tool that restores a row in this closed status; null for a status that is not closed. */
export function restoreToolFor(status: string): "rhen_archive" | "rhen_cancel" | null {
  return status === "archived" ? "rhen_archive" : status === "cancelled" ? "rhen_cancel" : null;
}

/**
 * The verb the CLI journals to take a record it created out of the plan (the status `HIDING_STATUS` names, as a verb).
 * A deliverable is left out: closing one does not close its step actions, so its create stays non-undoable.
 */
export const UNDO_VERB: Readonly<Partial<Record<CloseType, CloseVerb>>> = {
  area: "archive",
  outcome: "cancel",
  project: "cancel",
  action: "cancel",
  commitment: "cancel",
  routine_preset: "archive",
  condition_definition: "archive"
};

/** An undo of a create is only honoured this long after the create (never longer than the before-image retention). */
export const UNDO_WINDOW_HOURS = 24;

/** The most closures token agents may make in a rolling hour (counting the call), the same figure as the per-call cap. */
export const CLOSE_BUDGET_LIMIT = 20;
export const CLOSE_BUDGET_WINDOW_MINUTES = 60;

/** The `closed_by` suffix of a close that took back a create; the Closed page hides such rows. */
export const UNDO_CLOSED_BY_SUFFIX = ":undo";

/**
 * How many rows one `close` ledger row closed: its `closed` count, else (PR 3 rows) the target plus the cascade.
 * The SQL in `close-budget.ts` computes the same.
 */
export function closedCount(evidence: { closed?: unknown; cascade?: unknown }): number {
  if (typeof evidence.closed === "number") return evidence.closed;
  return 1 + (Array.isArray(evidence.cascade) ? evidence.cascade.length : 0);
}

/**
 * Refusal for a close that would take token agents past the hourly budget. The stateless rolling-hour rule: a call
 * applies only when the closures in the last hour plus its own rows stay within the limit; a call over it is filed for
 * the owner. `nextCall` is the same call, which the route then files.
 */
export function closeBudgetRefusal(input: {
  used: number;
  rows: number;
  nextCall: AgentCall;
  oldestAgesOutAt?: Date | null;
}): Refusal {
  const when = input.oldestAgesOutAt
    ? ` The oldest counted closure ages out at ${input.oldestAgesOutAt.toISOString()}.`
    : "";
  return {
    message:
      `Closing ${input.rows} more would make ${input.used + input.rows} closures by agents in the last hour, over the ${CLOSE_BUDGET_LIMIT} allowed, ` +
      `so nothing was closed.${when} Repeat the call and it is filed as a proposal for the owner to confirm.`,
    nextCall: input.nextCall
  };
}

export const toolForVerb = (verb: CloseVerb): "rhen_archive" | "rhen_cancel" =>
  verb === "archive" ? "rhen_archive" : "rhen_cancel";

/**
 * Where a restore lands (plan D14): the status the row left, except a running one (an action's `doing`/`active`, a
 * deliverable's `in_progress`), which would start a state with no session behind it. A row with no recorded origin,
 * or one that is not a status of the type, goes to the table's default and says so (`assumed`).
 */
export function restoreStatus(
  type: string,
  closedFrom: string | null | undefined,
  _closedStatus?: string
): { status: string; assumed: boolean } {
  const rule = closeVerbRule(type);
  if (rule === undefined) throw new RangeError(`${type} cannot be restored.`);
  const fallback = CLOSED_TABLES[CLOSE_TABLE_OF[type as CloseType]].restoreDefault;
  const valid = new Set([...rule.archiveFrom, ...rule.cancelFrom]);
  if (closedFrom == null || isClosedStatus(closedFrom) || !valid.has(closedFrom))
    return { status: fallback, assumed: true };
  if (type === "action" && (closedFrom === "doing" || closedFrom === "active"))
    return { status: "planned", assumed: false };
  if (type === "deliverable" && closedFrom === "in_progress") return { status: "ready", assumed: false };
  return { status: closedFrom, assumed: false };
}

const labelOf = (type: string): string => type.replace(/_/g, " ");
const cap = (text: string): string => `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
const quoted = (id: string): string => `"${id.length > 80 ? `${id.slice(0, 80)}...` : id}"`;

/** The restore call a closed row carries: the tool follows the row's state, the version is the row's own. */
export function restoreCall(type: string, id: string, version: number, status: string): AgentCall {
  const tool = restoreToolFor(status);
  if (tool === null)
    throw new RangeError(`A ${labelOf(type)} that is ${status} is not closed, so there is nothing to restore.`);
  return { tool, arguments: { type, id, do: "restore", "expected-version": version } };
}

/** A close call for a row, as the tool takes it. */
export function closeCall(input: {
  verb: CloseVerb;
  type: string;
  id: string;
  version: number;
  includeChildren?: boolean;
  reason?: string;
}): AgentCall {
  return {
    tool: toolForVerb(input.verb),
    arguments: {
      type: input.type,
      id: input.id,
      do: "close",
      "expected-version": input.version,
      ...(input.includeChildren ? { "include-children": true } : {}),
      ...(input.reason === undefined ? {} : { reason: input.reason })
    }
  };
}

/**
 * The command the close route and the server handler take. `verb` is the tool the caller used (it picks the status a
 * close writes and the tool a restore must match); `do` is required so a dropped key is an error, never a default.
 */
export const closeEntityCommandSchema = z
  .object({
    commandId: z.string().uuid().optional(),
    type: z.enum(CLOSE_TYPES),
    id: z.string().min(1),
    verb: z.enum(["archive", "cancel"]),
    do: z.enum(["close", "restore"]),
    // null is accepted only with `undoOfCommandId` (a forced undo or redo from the CLI journal): it means "no version".
    expectedVersion: z.number().int().positive().nullable().optional(),
    reason: z.string().max(500).optional(),
    includeChildren: z.boolean().optional(),
    // The command id of the agent's own create this close takes back (the server verifies it in the write ledger).
    undoOfCommandId: z.string().uuid().optional()
  })
  .refine((command) => command.expectedVersion !== null || command.undoOfCommandId !== undefined, {
    message: "expectedVersion may be null only for an undo of a create.",
    path: ["expectedVersion"]
  })
  .refine(
    (command) => command.do !== "restore" || command.expectedVersion != null || command.undoOfCommandId !== undefined,
    {
      message: "A restore needs the expected version of the closed row.",
      path: ["expectedVersion"]
    }
  )
  .refine((command) => command.undoOfCommandId === undefined || command.includeChildren !== true, {
    message: "An undo of a create takes back one row; it cannot include children.",
    path: ["includeChildren"]
  })
  .refine((command) => command.undoOfCommandId === undefined || command.do === "close", {
    message: "undoOfCommandId goes with do close.",
    path: ["undoOfCommandId"]
  });
export type CloseEntityCommand = z.infer<typeof closeEntityCommandSchema>;

// ---- refusals: each says what is wrong and ends in a call that can be sent as it stands ----

const note = (text: string, call: AgentCall): AgentCall => ({ ...call, note: text });

/** A close of a row that is already closed: names the restore call. */
export function alreadyClosedRefusal(input: { type: string; id: string; status: string; version: number }): Refusal {
  const call = restoreCall(input.type, input.id, input.version, input.status);
  return {
    message: `${cap(labelOf(input.type))} ${quoted(input.id)} is already ${input.status}, so it cannot be closed again. Restore it first if it should be closed another way.`,
    nextCall: note("reopens it", call)
  };
}

/**
 * The verb does not fit the row's state. An open action or deliverable is dropped (cancel), a finished one is tidied
 * away (archive); a type with one verb names that one.
 */
export function wrongVerbRefusal(input: {
  type: string;
  id: string;
  status: string;
  version: number;
  asked: CloseVerb;
  reason?: string;
}): Refusal {
  const rule = closeVerbRule(input.type);
  const allowed = verbFor(input.type, input.status);
  const instead: CloseVerb = input.asked === "archive" ? "cancel" : "archive";
  const who = `${cap(labelOf(input.type))} ${quoted(input.id)}`;
  const finished = input.status === "done" || input.status === "completed";
  let message: string;
  if (
    input.asked === "archive" &&
    !finished &&
    rule !== undefined &&
    rule.archiveFrom.length > 0 &&
    rule.cancelFrom.length > 0
  )
    message = `${who} is ${input.status}, so it is still open and cannot be archived. If it is dropped, cancel it.`;
  else if (input.asked === "cancel" && finished)
    message = `${who} is ${input.status}, which is finished, so it cannot be cancelled. Archive it to tidy it away.`;
  else
    message = `${who} is ${input.status}, and a ${labelOf(input.type)} is ${instead === "archive" ? "archived" : "cancelled"}, not ${input.asked === "archive" ? "archived" : "cancelled"}.`;
  const verb: CloseVerb = allowed === "either" || allowed === null ? instead : allowed;
  return {
    message,
    nextCall: note(
      `${verb} it instead`,
      closeCall({
        verb,
        type: input.type,
        id: input.id,
        version: input.version,
        ...(input.reason === undefined ? {} : { reason: input.reason })
      })
    )
  };
}

/** A restore through the tool that does not match the row's closed state: names the other tool's exact restore call. */
export function wrongToolForRestoreRefusal(input: {
  type: string;
  id: string;
  status: string;
  version: number;
  asked: CloseVerb;
}): Refusal {
  const call = restoreCall(input.type, input.id, input.version, input.status);
  return {
    message: `${cap(labelOf(input.type))} ${quoted(input.id)} is ${input.status}, so it is restored with ${call.tool}, not ${toolForVerb(input.asked)}.`,
    nextCall: note(`restores it from ${input.status}`, call)
  };
}

/** A close of a parent that still has open children, without `include-children`: count, deadlined titles, the retry call. */
export function childrenOpenRefusal(input: {
  type: string;
  id: string;
  verb: CloseVerb;
  version: number;
  count: number;
  deadlined: readonly string[];
  reason?: string;
}): Refusal {
  const shown = input.deadlined
    .slice(0, 5)
    .map((title) => `"${title.length > 60 ? `${title.slice(0, 60)}...` : title}"`);
  const more = input.deadlined.length - shown.length;
  return {
    message:
      `${cap(labelOf(input.type))} ${quoted(input.id)} still has ${input.count} open ${input.count === 1 ? "item" : "items"} under it` +
      (shown.length > 0 ? `, with deadlines: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : "") +
      ". Close them with it, or finish or move them first.",
    nextCall: note(
      "closes it and everything open under it",
      closeCall({
        verb: input.verb,
        type: input.type,
        id: input.id,
        version: input.version,
        includeChildren: true,
        ...(input.reason === undefined ? {} : { reason: input.reason })
      })
    )
  };
}

/** A restore under a closed parent: names the ancestor and its restore call. */
export function ancestorClosedRefusal(input: {
  type: string;
  id: string;
  ancestor: { type: string; id: string; status: string; version: number };
}): Refusal {
  const call = restoreCall(input.ancestor.type, input.ancestor.id, input.ancestor.version, input.ancestor.status);
  return {
    message: `${cap(labelOf(input.type))} ${quoted(input.id)} cannot be restored while ${labelOf(input.ancestor.type)} ${quoted(input.ancestor.id)} above it is ${input.ancestor.status}. Restore that first.`,
    nextCall: note(`restores the ${labelOf(input.ancestor.type)} above it`, call)
  };
}

/** A close while a session is open on the row (or on its steps): names the session and the call that finishes it. */
export function openSessionRefusal(input: {
  type: string;
  id: string;
  sessionId: string;
  /** The session's `target_type`; an action's own session is finished with `rhen_session`, any other with `rhen_activity`. */
  sessionTarget: string | null;
}): Refusal {
  const onAction = input.sessionTarget === null || input.sessionTarget === "action";
  const call: AgentCall = onAction
    ? {
        tool: "rhen_session",
        arguments: { subcommand: "finish", outcome: "unsure" },
        note: "ends the open session, then repeat this call"
      }
    : {
        tool: "rhen_activity",
        arguments: { subcommand: "finish", outcome: "stopped" },
        note: "ends the open session, then repeat this call"
      };
  return {
    message: `${cap(labelOf(input.type))} ${quoted(input.id)} has a session open on it (id ${input.sessionId}), so it cannot be closed now. Finish that session first.`,
    nextCall: call
  };
}

/** An agent's close without the reason the Closed page shows. */
export function reasonRequiredRefusal(input: {
  verb: CloseVerb;
  type: string;
  id: string;
  version: number;
  includeChildren?: boolean;
}): Refusal {
  const call = closeCall({
    verb: input.verb,
    type: input.type,
    id: input.id,
    version: input.version,
    ...(input.includeChildren ? { includeChildren: true } : {}),
    reason: "<why it is being closed>"
  });
  return {
    ...requiredRefusal("A reason", '"finished the quarter"'),
    nextCall: note("repeat with the reason filled in", call)
  };
}

/**
 * A save that would put a row into a closed status, or move it between closed statuses, or create it closed
 * (archive-removals design section 3, the save floor). Closing is its own call, so the refusal names it with the real
 * id and version; a close from one closed status to the other goes through a restore first.
 */
export function closedBySaveRefusal(input: {
  type: string;
  id: string;
  incoming: string;
  stored?: { status: string; version: number } | undefined;
}): Refusal {
  const who = `${cap(labelOf(input.type))} ${quoted(input.id)}`;
  const word = input.incoming === "archived" ? "archive" : "cancel";
  if (input.stored === undefined)
    return {
      message:
        `${who} cannot be created already ${input.incoming}: setting status ${input.incoming} through a save is refused. ` +
        `Create it open, then close it with ${toolForVerb(word)} (do close, with a reason).`
    };
  if (isClosedStatus(input.stored.status)) {
    const call = restoreCall(input.type, input.id, input.stored.version, input.stored.status);
    return {
      message:
        `${who} is already ${input.stored.status}, and setting status ${input.incoming} through a save is refused. ` +
        `Restore it first if it should be closed the other way.`,
      nextCall: note("reopens it", call)
    };
  }
  const allowed = verbFor(input.type, input.stored.status);
  const verb: CloseVerb = allowed === "archive" || allowed === "cancel" ? allowed : word;
  return {
    message:
      `Setting status ${input.incoming} through a save is refused: ${labelOf(input.type)} ${quoted(input.id)} is ${input.stored.status}, ` +
      `and closing it is its own call, ${toolForVerb(verb)} with do close and a reason.`,
    nextCall: note(
      `${verb} it`,
      closeCall({
        verb,
        type: input.type,
        id: input.id,
        version: input.stored.version,
        reason: "<why it is being closed>"
      })
    )
  };
}

/** A row in a state the verb never takes, as a plain refusal (used by the handler for an unknown or unreadable state). */
export function notClosableRefusal(input: { type: string; id: string; status: string }): Refusal {
  return wrongStateRefusal({ kind: labelOf(input.type), id: input.id, state: input.status, needs: "it to be open" });
}

// ---- the result of a close or restore ----

/** A row closed or reopened as a side effect of the call (a child, a step, a prep action), with its status before and its version after. */
export interface CascadedRow {
  type: string;
  id: string;
  from: string;
  version: number;
}

/** A row the call left alone, why, and the call that closes or restores it on its own. */
export interface SkippedRow {
  type: string;
  id: string;
  reason: string;
  call: AgentCall | null;
}

/** An open row that has the closed one as a prerequisite, and the read that shows what to edit to release it. */
export interface DependentRow {
  type: string;
  id: string;
  title: string;
  call: AgentCall;
}

/** What `closeEntity` answers with besides the state. */
export interface CloseEntityResult {
  type: string;
  id: string;
  do: "close" | "restore";
  verb: CloseVerb;
  /** The row's status after the call. */
  status: string;
  /** The row's version after the call. */
  version: number;
  /** The `closed_batch` of the close; null after a restore. */
  batch: string | null;
  /** Restore only: the status the row went back to, and whether that was the table default because the origin was unknown. */
  restoredTo?: string;
  assumed?: boolean;
  /** After a close: the call that restores it. Null after a restore. */
  restore: AgentCall | null;
  cascaded: CascadedRow[];
  skipped: SkippedRow[];
  /** After a cancel: open rows that still wait on the cancelled one. */
  dependents: DependentRow[];
  /** A closed deliverable's steps are left as they are (they follow its status in reads). */
  stepsLeft?: number;
  /** True when a re-count inside the transaction found rows the pre-read did not (a child created meanwhile is not closed). */
  createdSince?: boolean;
}
