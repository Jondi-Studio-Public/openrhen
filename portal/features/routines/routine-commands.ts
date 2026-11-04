import type { PlanningEntityCommand } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import type { RoutinePresetDraft } from "@/features/routines/routine-editor";
import { createClientId } from "@/shared/client-id";
import { versionIn } from "@/shared/version-in";

/**
 * The authoring module for `routines`'s single-command site — see
 * The command authoring design note, decision 1. The save is a builder that takes only the
 * envelope and entity; validation, topological reorder, and the whole success tail stay at the
 * call site.
 */

/**
 * Saves a `routine_preset` entity. Takes the already-ordered draft that the page has composed,
 * normalized, and validated, so the builder does nothing but read the version and assemble the
 * envelope. The validation, the topological reorder that renumbers every step's `sequence`, the
 * `submittingRef` guard, and the success tail (message, editor close, baseline reset) all stay at
 * the call site, because `savedDraft` depends on the ordered steps and the page needs them anyway.
 */
export function routinePresetCommand(savedDraft: RoutinePresetDraft, state: PortalState): PlanningEntityCommand {
  return {
    commandId: createClientId(),
    expectedVersion: versionIn(state.routinePresets, savedDraft.id),
    type: "save_entity",
    entityType: "routine_preset",
    entity: {
      id: savedDraft.id,
      name: savedDraft.name,
      activityName: savedDraft.activityName,
      status: savedDraft.status,
      replacesWakeRoutine: savedDraft.replacesWakeRoutine,
      steps: savedDraft.steps
    }
  };
}
