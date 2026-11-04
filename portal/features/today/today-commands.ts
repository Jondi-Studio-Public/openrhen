import type { PlanningEntityCommand } from "@openrhen/contracts";
import type { PortalState, StoredRoutineStep, StoredSleepPlan } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { iso } from "@/features/today/local-datetime";
import { routineStepEntity } from "@/features/commitments/routine-step-save";

/**
 * The reference authoring module for `today`'s three single-command sites — see
 * The command authoring design note, decision 1. All three send exactly one command with no branch,
 * so all three are builders rather than orchestrators.
 */

/** What `saveDailyPlan` collects. `dayKey` is the page's own clock read, not this module's to make. */
export interface DailyPlanDraft {
  dayKey: string;
  desiredActionIds: string[];
  deferredAction: string;
  deferredReason: string;
}

/**
 * Composing the daily-plan entity is more than restating the form: `deferredItems` is a merge of
 * whatever was already stored for the day with the one item the form may be adding, and needs
 * the version read off the exact stored record that merge read — so both reads happen here, off the
 * same `existing`, rather than the version being looked up separately at the call site. Picking which
 * day's key that is stays on the page: that answer comes from the page's own clock, not from state.
 */
export function dailyPlanCommand(draft: DailyPlanDraft, state: PortalState): PlanningEntityCommand {
  const existing = state.dailyPlan?.localDate === draft.dayKey ? state.dailyPlan : undefined;
  const deferredItems = [
    ...(existing?.deferredItems ?? []),
    ...(draft.deferredAction && draft.deferredReason.trim()
      ? [{ actionId: draft.deferredAction, reason: draft.deferredReason.trim() }]
      : [])
  ];
  return {
    commandId: createClientId(),
    expectedVersion: existing?.version ?? null,
    type: "save_entity",
    entityType: "daily_plan",
    entity: { localDate: draft.dayKey, desiredActionIds: draft.desiredActionIds, deferredItems }
  };
}

/**
 * `markStepDone` ticks preparation off from the day itself, so the save is a status change and
 * nothing else — `routineStepEntity` restates every other column unchanged. Returns `null` rather than
 * throwing when the step named is no longer on the plan: a missing record coalescing to an absent
 * result mirrors how `versionIn` treats a missing record as `null` rather than throwing. The throw
 * itself stays at the call site — it is non-command tail (convention rule 1), and the page still
 * throws the exact sentence it always has, so the behaviour a caller observes is unchanged.
 */
export function routineStepStatusCommand(
  entityId: string,
  status: StoredRoutineStep["status"],
  state: PortalState
): PlanningEntityCommand | null {
  const step = state.routineSteps.find((candidate) => candidate.id === entityId);
  if (!step) return null;
  return {
    commandId: createClientId(),
    expectedVersion: step.version ?? null,
    type: "save_entity",
    entityType: "routine_step",
    entity: routineStepEntity(step, { status })
  };
}

/**
 * One night's override. The editor already holds the plan being edited — it is looked up once at
 * render time and used elsewhere in the same component to decide what to show — so this builder takes
 * it directly rather than repeating the find, the same way `deliverableUpdateCommand` takes its
 * `stored` aggregate rather than closing over it.
 */
export function sleepPlanOverrideCommand(
  plan: StoredSleepPlan,
  start: string,
  wake: string,
  timezone: string
): PlanningEntityCommand {
  return {
    commandId: createClientId(),
    expectedVersion: plan.version ?? null,
    type: "save_entity",
    entityType: "sleep_plan",
    entity: {
      id: plan.id,
      plannedStartAt: iso(start, timezone),
      plannedWakeAt: iso(wake, timezone)
    }
  };
}

/**
 * Answers a night's bedtime-deviation warning: `early` keeps the plan as placed and clears the
 * warning; `near` switches the engine to the nearer, shorter night on the next run
 *
 */
export function sleepPlanPlacementChoiceCommand(
  plan: StoredSleepPlan,
  placementChoice: "early" | "near"
): PlanningEntityCommand {
  return {
    commandId: createClientId(),
    expectedVersion: plan.version ?? null,
    type: "save_entity",
    entityType: "sleep_plan",
    entity: { id: plan.id, placementChoice }
  };
}
