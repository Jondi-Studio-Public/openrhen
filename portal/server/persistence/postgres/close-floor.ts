import { closedBySaveRefusal, isCloseType, isClosedStatus } from "@openrhen/contracts";
import { changeLogConfirmedBy, requestAgent } from "@/server/agent-actor";
import { lockedStatusOf } from "./close-commands";
import { refused } from "./command-errors";
import type { Sql } from "./sql-pool";

/**
 * The save floor (archive-removals design section 3): an agent may not, through a save, bulk row or changeset item,
 * put a row into a closed status, move it from one closed status to the other, or create it closed. Closing is its own
 * call, which the refusal names with the real id and version. It lives in the save handlers, inside the write
 * transaction, because it must read the stored row (the pure route decision cannot).
 *
 * Applies to any agent request (a token or a header-only name); the owner, background writers and an owner-confirmed
 * replay of a proposal are not held to it. A save that restates the status a row already has (editing the title of a
 * closed row) is not a transition and passes. Only reads the row when the status named is a closed one.
 */
export async function assertNoClosedTransition(
  tx: Sql,
  userId: string,
  entityType: string,
  rawId: string,
  incomingStatus: unknown
): Promise<void> {
  if (requestAgent() === null || changeLogConfirmedBy() === "owner") return;
  if (typeof incomingStatus !== "string" || !isClosedStatus(incomingStatus)) return;
  if (!isCloseType(entityType)) return;
  const stored = await lockedStatusOf(tx, userId, entityType, rawId);
  if (stored !== undefined && stored.status === incomingStatus) return;
  throw refused(closedBySaveRefusal({ type: entityType, id: rawId, incoming: incomingStatus, stored }));
}
