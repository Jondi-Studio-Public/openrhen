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
  if (typeof incomingStatus !== "string" || !isCloseType(entityType)) return;
  const stored = await lockedStatusOf(tx, userId, entityType, rawId);
  if (stored !== undefined && stored.status === incomingStatus) return;
  // An open status only matters when it reopens a closed row; a create or an open-to-open save passes.
  if (!isClosedStatus(incomingStatus) && (stored === undefined || !isClosedStatus(stored.status))) return;
  throw refused(closedBySaveRefusal({ type: entityType, id: rawId, incoming: incomingStatus, stored }));
}
