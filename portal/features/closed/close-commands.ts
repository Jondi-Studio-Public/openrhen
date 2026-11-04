import type { CloseEntityCommand, CloseEntityResult, CloseType, CloseVerb } from "@openrhen/contracts";
import { CommandRefusal } from "@/shared/command-refusal";

/**
 * The close route's bodies and the words around its answers, as pure functions. A body is built from fields
 * (`type`, `id`, `verb`, `expectedVersion`), never from the agent-tool call a result carries: that call is
 * kebab-case and has no `verb`, so posting it would fail `closeEntityCommandSchema`.
 */

export interface CloseTarget {
  type: CloseType;
  /** The id as the portal state shows it, which is what the route takes. */
  id: string;
  title: string;
  /** The version the caller read; absent for a row whose version the state does not carry (the close then skips the check). */
  version: number | undefined;
}

interface Envelope {
  /** One id per attempt, so a retry after a lost answer replays rather than closes twice. */
  commandId: string;
}

export function closeCommandFor(
  target: Pick<CloseTarget, "type" | "id" | "version">,
  verb: CloseVerb,
  options: Envelope & { includeChildren?: boolean }
): CloseEntityCommand {
  return {
    commandId: options.commandId,
    type: target.type,
    id: target.id,
    verb,
    do: "close",
    ...(target.version === undefined ? {} : { expectedVersion: target.version }),
    ...(options.includeChildren ? { includeChildren: true } : {})
  };
}

export function restoreCommandFor(
  row: { type: CloseType; id: string; restoreVerb: CloseVerb; version: number },
  options: Envelope & { includeChildren?: boolean }
): CloseEntityCommand {
  return {
    commandId: options.commandId,
    type: row.type,
    id: row.id,
    verb: row.restoreVerb,
    do: "restore",
    expectedVersion: row.version,
    ...(options.includeChildren ? { includeChildren: true } : {})
  };
}

/** Types whose restore brings back their children only when asked. */
const PARENT_TYPES: readonly string[] = ["area", "outcome", "project"];

/**
 * Undo of a close, from the close's result. When the close took rows with it (an area, outcome or project closed with
 * `includeChildren`), the undo asks for them back too; a commitment's restore always reopens its own batch.
 */
export function undoCommandFor(closed: CloseEntityResult, options: Envelope): CloseEntityCommand {
  return restoreCommandFor(
    { type: closed.type as CloseType, id: closed.id, restoreVerb: closed.verb, version: closed.version },
    { ...options, includeChildren: PARENT_TYPES.includes(closed.type) && closed.cascaded.length > 0 }
  );
}

/**
 * The refusal that offers "Close all": a parent with open children. The server builds its `nextCall` with
 * `include-children` (the tool's spelling) and answers 400; anything else is not this refusal.
 */
export function isChildrenRefusal(error: unknown): error is CommandRefusal {
  return (
    error instanceof CommandRefusal && error.status === 400 && error.nextCall?.arguments["include-children"] === true
  );
}

const shorten = (title: string) => (title.length > 60 ? `${title.slice(0, 60)}...` : title);

const KIND_LABEL: Record<string, [string, string]> = {
  action: ["action", "actions"],
  routine_step: ["routine step", "routine steps"],
  project: ["project", "projects"],
  outcome: ["outcome", "outcomes"],
  deliverable: ["deliverable", "deliverables"]
};

/** "2 actions and 1 routine step", by kind. */
function cascadeByKind(cascaded: CloseEntityResult["cascaded"]): string {
  const counts = new Map<string, number>();
  for (const row of cascaded) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  const parts = [...counts].map(([type, n]) => {
    const label = KIND_LABEL[type] ?? [type, `${type}s`];
    return `${n} ${n === 1 ? label[0] : label[1]}`;
  });
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The toast after a close: what closed, what closed with it, what was left open. */
export function closeToastText(title: string, closed: CloseEntityResult): string {
  const word = closed.verb === "archive" ? "archived" : "cancelled";
  let text = `${shorten(title)} ${word}`;
  if (closed.cascaded.length > 0)
    text +=
      closed.type === "commitment"
        ? `, with ${cascadeByKind(closed.cascaded)}`
        : ` and ${closed.cascaded.length} under it`;
  text += ".";
  if (closed.skipped.length > 0) text += ` ${closed.skipped.length} left open.`;
  return text;
}

/** The toast after a restore (an Undo, or Restore on the Closed page). */
export function restoreToastText(title: string, restored: CloseEntityResult): string {
  const landed = restored.restoredTo ?? restored.status;
  let text = `Restored ${shorten(title)} as ${landed}${restored.assumed ? `; the old status was not recorded` : ""}.`;
  if (restored.skipped.length > 0) text += ` ${restored.skipped.length} under it was left closed.`;
  return text;
}

/**
 * What a failed close, undo or restore says. A stale version is the common one; the server's sentence for it is
 * written for an agent (it carries a retry call), so the page never shows it. Every other refusal is already a plain
 * sentence and is shown as it is.
 */
export function failureText(error: unknown, doing: "close" | "undo" | "restore"): string {
  if (error instanceof CommandRefusal && error.status === 409 && error.currentVersion !== undefined) {
    if (doing === "close")
      return "Changed since you opened it, so nothing was closed. The page is up to date; try again.";
    if (doing === "undo")
      return "Changed since you closed it, so it was not restored. Open Review > Closed to restore it.";
    return "Changed since the list was loaded; it has been refreshed.";
  }
  // A fetch that never reached the server rejects with a bare TypeError ("Failed to fetch").
  if (error instanceof TypeError)
    return "The server could not be reached; the change may not have been saved. Check and try again.";
  return error instanceof Error ? error.message : "The change was not saved.";
}
