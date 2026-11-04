import { closedBySaveRefusal, isCloseType, isClosedStatus } from "@openrhen/contracts";
import { changeLogConfirmedBy, requestAgent } from "@/server/agent-actor";
import { lockedStatusOf } from "./close-commands";
import { refused } from "./command-errors";
import type { Sql } from "./sql-pool";

/**
 * The save floor (archive-removals design section 3): an agent may not, through a save, bulk row or changeset item,
 * put a row into a closed status, move it from one closed status to the other, create it closed, or reopen a closed
 * row. Closing and reopening are their own calls, which the refusal names with the real id and version. It lives in the save handlers, inside the write
 * transaction, because it must read the stored row (the pure route decision cannot).
 *
 * Applies to any agent request (a token or a header-only name); the owner, background writers and an owner-confirmed
 * replay of a proposal are not held to it. A save that restates the status a row already has (editing the title of a
 * closed row) is not a transition and passes. Reads the stored row (locked) whenever the save names a status.
 */
export async function assertNoClosedTransition(
  tx: Sql,
  userId: string,
  entityType: string,
  rawId: string,
  incomingStatus: unknown
): Promise<void> {
  if (requestAgent() === null || changeLogConfirmedBy() === "owner") return;
  if (!isCloseType(entityType)) return;
  const incoming = statusWritten(entityType, incomingStatus);
  if (incoming === undefined) return;
  const stored = await lockedStatusOf(tx, userId, entityType, rawId);
  if (stored !== undefined && stored.status === incoming) return;
  // An open status only matters when it reopens a closed row; a create or an open-to-open save passes.
  if (!isClosedStatus(incoming) && (stored === undefined || !isClosedStatus(stored.status))) return;
  throw refused(closedBySaveRefusal({ type: entityType, id: rawId, incoming, stored }));
}

/** What a save that leaves the status out writes: the handler's own default, for the kinds that have one. */
const OMITTED_STATUS: Readonly<Partial<Record<string, string>>> = {
  routine_preset: "active",
  condition_definition: "active",
  deliverable: "needs_breakdown"
};

/**
 * The status a save will write, read the way the handler reads it: trimmed (the handlers trim before they write) and
 * lower-cased (so a cased or padded spelling cannot slip past a check that compares raw text), and the handler's
 * default when the save leaves it out. Undefined when the save names no status and the kind has no default (the
 * handler then refuses the save itself, or the stored value stays).
 */
export function statusWritten(entityType: string, raw: unknown): string | undefined {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (text) return text;
  return OMITTED_STATUS[entityType];
}
