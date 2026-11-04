import { portalStateSchema, type DayPlan } from "@openrhen/contracts";
import {
  localDate,
  recommend,
  selectCurrentDirective,
  simulateDayPlan,
  type PlanningResult,
  type RecommendArguments
} from "../../src/index.js";

/**
 * Runs the day-plan simulation over engine-level inputs (a schedule and the arguments a ranking was
 * made from) without a whole planning request. Tests that build scenarios directly from
 * `planSchedule` and `recommend` — the property and replay suites — use this to check the projected
 * day too. The wire state it fabricates carries only what the directive chain and horizon read:
 * timezone, daily horizon, and empty sleep and routine facts.
 */
type HarnessOptions = { timezone?: string; planningHorizonEnd?: string; dayPlanDays?: number };

function harnessState(args: RecommendArguments & { planning: PlanningResult }, options: HarnessOptions) {
  const timezone = options.timezone ?? args.timezone ?? "UTC";
  return portalStateSchema.parse({
    settings: {
      timezone,
      planningHorizonEnd: options.planningHorizonEnd ?? "22:00",
      defaultUsableFraction: 1,
      defaultSetupBufferMinutes: 0,
      defaultTransitionBufferMinutes: 0,
      submissionBufferMinutes: 0,
      submissionBufferPercent: 0,
      energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
      estimateBucketsMinutes: [15, 30, 60],
      conditionCatalog: ["home"],
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16
    },
    areas: [],
    outcomes: [],
    projects: [],
    actions: [],
    commitments: [],
    routineSteps: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: [],
    currentEnergy: args.currentEnergy ?? "high",
    horizonEnd: args.horizonEnd.toISOString(),
    activeSession: null,
    // An explicit daily horizon in the arguments is honoured through the same override the portal
    // uses for "work later tonight", so the harness reads it from state exactly as the engine does.
    ...(args.dailyHorizonEnd
      ? {
          dailyPlan: {
            id: "harness",
            localDate: localDate(args.now, timezone),
            desiredActionIds: [],
            deferredItems: [],
            horizonOverrideAt: args.dailyHorizonEnd.toISOString()
          }
        }
      : {})
  });
}

/** The live directive for these arguments, as the engine would select it. */
export function directiveFor(args: RecommendArguments & { planning: PlanningResult }, options: HarnessOptions = {}) {
  return selectCurrentDirective({
    state: harnessState(args, options),
    commitments: args.protectedCommitments ?? args.commitments,
    now: args.now,
    sleepPlans: [],
    recommendation: recommend(args),
    schedule: args.planning
  });
}

export function dayPlanFor(
  args: RecommendArguments & { planning: PlanningResult },
  options: HarnessOptions = {}
): DayPlan {
  const state = harnessState(args, options);
  const recommendation = recommend(args);
  const currentDirective = selectCurrentDirective({
    state,
    commitments: args.protectedCommitments ?? args.commitments,
    now: args.now,
    sleepPlans: [],
    recommendation,
    schedule: args.planning
  });
  return simulateDayPlan({
    state,
    now: args.now,
    sleepPlans: [],
    schedule: args.planning,
    recommendArguments: args,
    recommendation,
    currentDirective,
    ...(options.dayPlanDays !== undefined ? { dayPlanDays: options.dayPlanDays } : {})
  });
}

/** The compact golden form a fixture pins: one string per block, easy to read in a diff. */
export function compactDayPlan(plan: DayPlan): string[] {
  return plan.blocks.map(
    (block) =>
      `${block.startsAt.slice(11, 16)}-${block.endsAt.slice(11, 16)} ${block.kind}${
        block.toLocationId ? `→${block.toLocationId}` : ""
      }${block.targetId ? ` ${block.targetId}` : ""} ${block.focusedMinutes}/${block.wallClockMinutes}${
        block.tier ? ` ${block.tier}` : ""
      }${block.gapKind ? ` ${block.gapKind}${block.boundaryKind ? `:${block.boundaryKind}` : ""}` : ""}`
  );
}
