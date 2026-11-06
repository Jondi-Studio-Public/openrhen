import type { PlanningEntityCommand } from "@openrhen/contracts";
import type { StoredCommitment } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";

/**
 * "I'm free": the person is not occupied by this commitment any more, though it is still on. The save sends
 * `free` alone, so nothing else about the commitment (and nothing the family calendar shows) is restated; the
 * plan recalculates and offers the next task. `free: false` takes it back.
 */
export function freeCommitmentCommand(commitment: StoredCommitment, free: boolean): PlanningEntityCommand {
  return {
    commandId: createClientId(),
    expectedVersion: commitment.version ?? null,
    type: "save_entity",
    entityType: "commitment",
    entity: { id: commitment.id, free }
  };
}

/**
 * Whether the button is on offer: a confirmed commitment that has started and has not reached its end. Before
 * the start there is nothing to free, and the server refuses it.
 */
export function canBeFreed(
  commitment: StoredCommitment,
  now: Date,
  endsAt: Date = new Date(commitment.endsAt)
): boolean {
  return commitment.status === "confirmed" && new Date(commitment.startsAt) <= now && now < endsAt;
}
