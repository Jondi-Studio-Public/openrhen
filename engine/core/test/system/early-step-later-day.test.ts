import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * The routine step timing design note: the engine is now the only author of a pending routine
 * step's placement, derived fresh every run (`deriveCommitmentRoutineSteps`) and placed by
 * `scheduling/routine-placement.ts`'s `placeRoutineChains` inside both projection passes. This
 * fixture is the wash (5, wait 90) -> hang out (5, wait 240) -> pack chain the plan's own Tests
 * section names: a work commitment tomorrow at 07:00 UTC, an "office" location whose default preset
 * resolves for it ('inherit'), and an evening band (`DEFAULT_TIME_BANDS`, 17:00-22:00 local) both
 * flexible steps prefer.
 */

const now = new Date("2026-11-04T15:05:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

const lunchPreset = {
  id: "class-preset",
  version: 1,
  name: "Class prep",
  activityName: "Class prep",
  status: "active" as const,
  replacesWakeRoutine: false,
  steps: [
    {
      id: "lunch-step",
      title: "Prepare lunch",
      durationMinutes: 15,
      sequence: 0,
      timingRule: "flexible" as const,
      maxLeadMinutes: 1440,
      energy: "low" as const,
      contexts: [],
      dependencyIds: [],
      phase: "before" as const
    }
  ]
};
function state(overrides: Record<string, unknown> = {}) {
  return portalStateSchema.parse({
    settings: {
      timezone: "UTC",
      planningHorizonEnd: "22:00",
      defaultUsableFraction: 1,
      defaultSetupBufferMinutes: 0,
      defaultTransitionBufferMinutes: 0,
      submissionBufferMinutes: 0,
      submissionBufferPercent: 0,
      energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
      estimateBucketsMinutes: [15, 30, 60],
      conditionCatalog: ["school"],
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16
    },
    areas: [{ id: "a", name: "A", status: "active", sortOrder: 0 }],
    outcomes: [{ id: "o", title: "O", areaId: "a", status: "active", definitionOfDone: "d", value: 3 }],
    projects: [
      {
        id: "p",
        title: "Assessment",
        area: "a",
        outcomeId: "o",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3,
        deadline: new Date(now.getTime() + 3 * 24 * HOUR).toISOString()
      }
    ],
    actions: [
      {
        id: "act",
        projectId: "p",
        title: "UNIT101 mechanics questions",
        status: "active",
        optimisticMinutes: 30,
        expectedMinutes: 60,
        remainingMinutes: 60,
        pessimisticMinutes: 90,
        energy: "medium",
        minimumSessionMinutes: 15,
        maximumSessionMinutes: 60,
        importance: 3,
        consequence: 3,
        contexts: [],
        dependencyIds: [],
        splittable: true,
        setupMinutes: 0,
        schedulingMode: "one_off"
      }
    ],
    commitments: [
      {
        id: "class",
        title: "Evening Class",
        status: "confirmed",
        startsAt: iso(17 * HOUR - 5 * MIN),
        endsAt: iso(21 * HOUR),
        locationId: "school",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    ],
    routineSteps: [],
    routinePresets: [lunchPreset],
    conditionDefinitions: [
      { id: "school", name: "School", kind: "location", status: "active", defaultRoutinePresetId: "class-preset" }
    ],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: [],
    currentEnergy: "medium",
    horizonEnd: iso(3 * 24 * HOUR),
    activeSession: null,
    currentSituation: { locationId: "school", locationSetAt: now.toISOString(), transportModes: [] },
    ...overrides
  });
}
function run(overrides: Record<string, unknown> = {}) {
  return calculatePlanAndForecast(
    planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-0000000000a5",
      inputVersion: "early-step-later-day",
      calculatedAt: now.toISOString(),
      horizonEnd: iso(3 * 24 * HOUR),
      state: state(overrides)
    })
  );
}

describe("an early step placed on a later day", () => {
  it("is listed but does not outrank today's ordinary work (3 pm lunch prep for an 8 am class tomorrow)", () => {
    const r = run();
    expect(r.currentDirective).toMatchObject({ kind: "action", title: "UNIT101 mechanics questions" });
    expect(r.canDoNow?.map((item) => item.title)).toContain("Prepare lunch");
  });

  it("still leads when there is no work to do", () => {
    const r = run({ actions: [], projects: [] });
    expect(r.currentDirective).toMatchObject({ kind: "routine_step", title: "Prepare lunch" });
  });
});
