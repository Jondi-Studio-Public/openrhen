import type { PlanningEntityCommand, SplitCommitmentSourceCommand } from "@openrhen/contracts";
import type { StoredCommitment, StoredRoutineStep } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import type { RoutineSource } from "@/features/commitments/commitment-routine";
import { routineStepEntity, type RoutineStepChange } from "@/features/commitments/routine-step-save";

/**
 * The authoring module for `commitment-detail`'s two single-command sites — see
 * The command authoring design note, decision 1. Both send exactly one command with no branch, so
 * both are builders. The page's own recalculation follow-up after `saveSource` is not part of either
 * builder — it goes through `usePortal()`'s `recalculate` rather than a raw `fetch`, which is a plain
 * replacement of one dispatch mechanism for another, not something an authoring module owns.
 */

/** The stored commitment as the entity command wants it: every column it rewrites, unchanged. */
function commitmentEntity(item: StoredCommitment): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    status: item.status,
    setupBeforeMinutes: item.setupBeforeMinutes,
    transitionAfterMinutes: item.transitionAfterMinutes,
    // Preserve the share-to-calendar flag: a routine-source save would otherwise default it to
    // false when entity.shareToCalendar is absent, and a shared commitment would be un-shared
    // on the next plan without any deliberate action by the user.
    shareToCalendar: item.shareToCalendar ?? false,
    ...(item.location ? { location: item.location } : {}),
    ...(item.locationId ? { locationId: item.locationId } : {}),
    ...(item.projectId ? { projectId: item.projectId } : {})
  };
}

/**
 * Changes which routine source a commitment draws its preparation steps from. The version comes
 * from the commitment record already in hand, not from a lookup (conventions rule 1 — never wrap a
 * record you already hold).
 */
export function commitmentRoutineSourceCommand(
  commitment: StoredCommitment,
  source: RoutineSource,
  presetId: string
): PlanningEntityCommand {
  return {
    commandId: createClientId(),
    expectedVersion: commitment.version ?? null,
    type: "save_entity",
    entityType: "commitment",
    entity: {
      ...commitmentEntity(commitment),
      routineSource: source,
      ...(source === "preset" ? { routinePresetId: presetId } : {})
    }
  };
}

/**
 * The step's own fields go back with the change applied. Nothing here names a routine source: the
 * server flips the commitment to `custom` because the edit happened, and the chip re-reads it. Wraps
 * `routineStepEntity` from `routine-step-save.ts`, which is not renamed or edited by this pass.
 */
export function routineStepEditCommand(step: StoredRoutineStep, change: RoutineStepChange): PlanningEntityCommand {
  return {
    commandId: createClientId(),
    expectedVersion: step.version ?? null,
    type: "save_entity",
    entityType: "routine_step",
    entity: routineStepEntity(step, change)
  };
}

/**
 * **Not the same event**: takes the source with link id `linkId` off `commitment` as a commitment of
 * its own. The version is the one on the commitment already in hand; a commitment the store has not
 * versioned has nothing to split, so it is refused here rather than sent.
 */
export function splitSourceCommand(commitment: StoredCommitment, linkId: string): SplitCommitmentSourceCommand {
  if (commitment.version === undefined) throw new Error("This commitment has not been saved yet.");
  return { commandId: createClientId(), expectedVersion: commitment.version, commitmentId: commitment.id, linkId };
}
