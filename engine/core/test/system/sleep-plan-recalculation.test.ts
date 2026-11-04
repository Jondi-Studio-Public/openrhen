import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

const now = new Date("2026-08-14T04:00:00.000Z");

function baseState(overrides: Record<string, unknown> = {}) {
  return portalStateSchema.parse({
    settings: {
      timezone: "Australia/Sydney",
      planningHorizonEnd: "22:00",
      defaultUsableFraction: 0.85,
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
    routinePresets: [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    activeSession: null,
    ...overrides
  });
}

function request(state: ReturnType<typeof baseState>) {
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-000000000003",
    inputVersion: "sleep-plan-recalculation-fixture",
    calculatedAt: now.toISOString(),
    horizonEnd: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    state
  });
}

describe("recalculating while a sleep is in progress", () => {
  // Reported bug: a sleep that is currently `sleeping` gets reclassified as a different, regenerated
  // night on the very next recalculation and reset to `planned` with its actuals wiped. This loses the
  // recorded start time for a sleep the user is still in. The suspected cause is in `sameNight` inside
  // `engine/core/src/engine.ts`: it compares the *stored* `plannedStartAt` against the *derived* plan's
  // `plannedStartAt`, but for a `sleeping` row, `deriveSleepPlans` substitutes `actualStartAt` in place
  // of the planned start when building that derived plan — so the two sides being compared are, for any
  // sleep that didn't start at exactly its planned instant, never equal.
  it("keeps a sleeping plan sleeping, with its actualStartAt intact, across a recalculation", () => {
    const plannedStartAt = new Date(now.getTime() - 30 * 60_000); // planned for 30 minutes ago
    const actualStartAt = new Date(now.getTime() - 20 * 60_000); // actually started 10 minutes late
    const plannedWakeAt = new Date(now.getTime() + 7 * 60 * 60_000);
    const state = baseState({
      sleepPlans: [
        {
          id: "current-sleep",
          plannedStartAt: plannedStartAt.toISOString(),
          plannedWakeAt: plannedWakeAt.toISOString(),
          desiredMinutes: 480,
          allowedMinutes: 480,
          sleepDeficitMinutes: 0,
          anchorDeviationMinutes: 0,
          hardErrors: [],
          explanation: "test fixture",
          status: "sleeping",
          actualStartAt: actualStartAt.toISOString()
        }
      ]
    });

    const response = calculatePlanAndForecast(request(state));
    const persisted = response.derivedState.sleepPlans
      .map((plan) => plan as Record<string, unknown>)
      .find((plan) => plan.id === "current-sleep");

    expect(persisted).toBeDefined();
    expect(persisted?.status).toBe("sleeping");
    expect(persisted?.actualStartAt).toBe(actualStartAt.toISOString());
  });

  // Companion probe (not the reported bug, found while fixing it): does a *second* recompute against a
  // `completed` row clobber evidentiary fields other than status/actualStartAt/actualWakeAt, whenever
  // the freshly calculated candidate for "tonight" coincidentally reproduces the same plannedStartAt as
  // the stored row (which happens whenever nothing material changed between the two recomputes)?
  it("probe: does a same-night completed row keep its corrected allowedMinutes across a second recompute", () => {
    const settingsOverrides = {
      timezone: "Australia/Sydney",
      planningHorizonEnd: "22:00",
      defaultUsableFraction: 0.85,
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
      maxAwakeHours: 16,
      lastWokeAt: now.toISOString()
    };
    const firstState = portalStateSchema.parse({
      settings: settingsOverrides,
      areas: [],
      outcomes: [],
      projects: [],
      actions: [],
      commitments: [],
      routineSteps: [],
      routinePresets: [],
      occurrences: [],
      sleepPlans: [],
      captures: [],
      completedToday: [],
      assertedConditions: ["home"],
      currentEnergy: "medium",
      horizonEnd: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
      activeSession: null
    });
    const firstResponse = calculatePlanAndForecast(request(firstState));
    const firstPlan = firstResponse.derivedState.sleepPlans[0] as Record<string, unknown>;
    expect(firstPlan).toBeDefined();

    // Simulate: the user started this plan, finished it, then corrected its logged duration to 15
    // minutes via sleep_log_entry — which, per entity-commands.ts, updates allowed_minutes directly
    // while leaving plannedStartAt/plannedWakeAt untouched as "evidence of what the engine scheduled."
    const correctedRow = {
      ...firstPlan,
      status: "completed" as const,
      allowedMinutes: 15,
      actualStartAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
      actualWakeAt: new Date(now.getTime() - 5 * 60_000).toISOString()
    };
    const secondState = portalStateSchema.parse({
      ...firstState,
      sleepPlans: [correctedRow]
    });
    const secondResponse = calculatePlanAndForecast(request(secondState));
    const secondPlan = secondResponse.derivedState.sleepPlans
      .map((plan) => plan as Record<string, unknown>)
      .find((plan) => plan.id === firstPlan.id);

    expect(secondPlan).toBeDefined();
    expect(secondPlan?.status).toBe("completed");
    expect(secondPlan?.allowedMinutes).toBe(15);
  });
});
