import type { StoredRoutineStep } from "@/state/portal-state";

/** The fields a save may rewrite. Everything absent is carried back from the stored step unchanged. */
export interface RoutineStepChange {
  title?: string;
  durationMinutes?: number;
  timingRule?: StoredRoutineStep["timingRule"];
  maxLeadMinutes?: number;
  phase?: StoredRoutineStep["phase"];
  energy?: StoredRoutineStep["energy"];
  status?: StoredRoutineStep["status"];
}

/**
 * A routine step as the entity command wants it: every column it rewrites, with the change applied
 * and the rest of the step handed straight back. The command is a whole-row write, so a save that
 * names only a status still has to restate the sequence, the dependencies and the linked occurrence
 * — and dropping one of them silently is how a night-before tick used to clear a step's place in its
 * routine. Both callers go through here so a status-only save and a full edit build the same row.
 */
export const routineStepEntity = (step: StoredRoutineStep, change: RoutineStepChange = {}): Record<string, unknown> => {
  const timingRule = change.timingRule ?? step.timingRule;
  const maxLeadMinutes = change.maxLeadMinutes ?? step.maxLeadMinutes;
  return {
    id: step.id,
    commitmentId: step.commitmentId,
    title: change.title ?? step.title,
    durationMinutes: change.durationMinutes ?? step.durationMinutes,
    sequence: step.sequence,
    timingRule,
    // A contiguous step has no lead window to state, and sending one anyway would outlive the switch.
    ...(timingRule === "flexible" ? { maxLeadMinutes } : {}),
    energy: change.energy ?? step.energy,
    contexts: step.contexts,
    phase: change.phase ?? step.phase,
    ...(step.actionWindowId ? { actionWindowId: step.actionWindowId } : {}),
    dependencyIds: step.dependencyIds,
    status: change.status ?? step.status
  };
};
