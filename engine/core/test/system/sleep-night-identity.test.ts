import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * The sleep placement design note "Interfaces and contracts" (the `sameNight` rule) and "Night
 * identity": a night's id is stable across a recompute for every status except `cancelled`, which
 * keeps its identity only while `plannedStartAt` is unchanged — the same abandoned attempt — and
 * revives as `planned` the moment a fresh candidate's start has moved on. Finding 6 (the design notes
 * own Testing item, `sleep-placement.md` "System"): completing a bedtime step and then moving `now`
 * past bedtime must never make the step's own night look like a different one, so the step stays
 * `completed`.
 */

const now = new Date("2026-08-14T04:00:00.000Z"); // 14:00 local — safely inside the daytime window.

const bedtimePreset = {
  id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  name: "Wind down",
  activityName: "Sleep",
  status: "active" as const,
  steps: [
    {
      id: "step-1",
      title: "Drink water",
      durationMinutes: 10,
      sequence: 0,
      timingRule: "contiguous" as const,
      energy: "low" as const,
      contexts: [],
      dependencyIds: [],
      phase: "before" as const
    }
  ]
};

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
      maxAwakeHours: 16,
      lastWokeAt: new Date(now.getTime() - 6 * 60 * 60_000).toISOString()
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

function request(state: ReturnType<typeof baseState>, at: Date = now) {
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-000000000011",
    inputVersion: "sleep-night-identity-fixture",
    calculatedAt: at.toISOString(),
    horizonEnd: new Date(at.getTime() + 24 * 60 * 60_000).toISOString(),
    state
  });
}

function tonightOf(response: ReturnType<typeof calculatePlanAndForecast>): Record<string, unknown> {
  return (response.derivedState.sleepPlans as Array<Record<string, unknown>>)
    .filter((plan) => plan.status === "planned" || plan.status === "cancelled")
    .sort(
      (a, b) => new Date(a.plannedStartAt as string).getTime() - new Date(b.plannedStartAt as string).getTime()
    )[0]!;
}

describe("sleep night identity: the sameNight rule", () => {
  it("echoes a cancelled attempt while its start is unchanged — the same abandoned attempt", () => {
    const fresh = tonightOf(calculatePlanAndForecast(request(baseState())));
    const cancelledState = baseState({
      sleepPlans: [
        {
          id: fresh.id,
          plannedStartAt: fresh.plannedStartAt,
          plannedWakeAt: fresh.plannedWakeAt,
          desiredMinutes: fresh.desiredMinutes,
          allowedMinutes: 0,
          sleepDeficitMinutes: fresh.desiredMinutes,
          anchorDeviationMinutes: 0,
          hardErrors: [],
          explanation: "Did not sleep.",
          status: "cancelled"
        }
      ]
    });
    const result = tonightOf(calculatePlanAndForecast(request(cancelledState)));
    expect(result.id).toBe(fresh.id);
    expect(result.status).toBe("cancelled");
    expect(result.plannedStartAt).toBe(fresh.plannedStartAt);
  });

  it("revives a cancelled night as planned once a fresh candidate's start has moved on", () => {
    const fresh = tonightOf(calculatePlanAndForecast(request(baseState())));
    // A stored cancelled row whose start no longer matches what tonight would recompute to (an hour
    // earlier than the fresh candidate) is a genuinely different attempt from the night the engine now
    // plans — the abandoned attempt has moved on, so it must not freeze the directive forever.
    const movedStart = new Date(new Date(fresh.plannedStartAt as string).getTime() - 60 * 60_000).toISOString();
    const cancelledState = baseState({
      sleepPlans: [
        {
          id: fresh.id,
          plannedStartAt: movedStart,
          plannedWakeAt: fresh.plannedWakeAt,
          desiredMinutes: fresh.desiredMinutes,
          allowedMinutes: 0,
          sleepDeficitMinutes: fresh.desiredMinutes,
          anchorDeviationMinutes: 0,
          hardErrors: [],
          explanation: "Did not sleep.",
          status: "cancelled"
        }
      ]
    });
    const result = tonightOf(calculatePlanAndForecast(request(cancelledState)));
    expect(result.id).toBe(fresh.id);
    expect(result.status).toBe("planned");
    expect(result.plannedStartAt).toBe(fresh.plannedStartAt);
  });
});

describe("sleep night identity: finding 6", () => {
  it("keeps a completed bedtime step completed on the same night after now moves past bedtime", () => {
    const preBedtime = new Date("2026-08-14T11:00:00.000Z"); // 21:00 local — before the 23:00 bedtime.
    const base = baseState();
    const state1 = portalStateSchema.parse({
      ...base,
      settings: { ...base.settings, bedtimeRoutinePresetId: bedtimePreset.id },
      routinePresets: [bedtimePreset]
    });
    const response1 = calculatePlanAndForecast(request(state1, preBedtime));
    const tonight1 = tonightOf(response1);
    const step1 = (response1.derivedState.routineSteps as Array<Record<string, unknown>>).find(
      (item) => item.anchorType === "sleep_plan" && item.purpose === "bedtime" && item.anchorId === tonight1.id
    )!;
    expect(step1.status).toBe("pending");

    // Move past bedtime and mark the step completed, as if the user finished it moments before
    // midnight and the next recompute now runs a couple of hours later, well past the anchor.
    const postBedtime = new Date("2026-08-14T14:00:00.000Z"); // 00:00 local the next day.
    const state2 = portalStateSchema.parse({
      ...base,
      settings: { ...base.settings, bedtimeRoutinePresetId: bedtimePreset.id },
      routinePresets: [bedtimePreset],
      sleepPlans: response1.derivedState.sleepPlans,
      routineSteps: [{ ...step1, status: "completed" }]
    });
    const response2 = calculatePlanAndForecast(request(state2, postBedtime));
    const tonight2 = tonightOf(response2);
    expect(tonight2.id).toBe(tonight1.id);
    const step1After = (response2.derivedState.routineSteps as Array<Record<string, unknown>>).find(
      (item) => item.id === step1.id
    );
    expect(step1After?.status).toBe("completed");
    expect(step1After?.anchorId).toBe(tonight1.id);
  });
});
