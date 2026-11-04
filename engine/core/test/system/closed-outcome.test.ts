import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * The weekly review's "Close outcome" sets the outcome to done. This is what the plan does with that: the
 * outcome's projects leave the forecast and are never recommended, and the same state with the outcome active
 * keeps them.
 */

const now = new Date("2026-08-19T00:00:00.000Z");
const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

function request(outcomeStatus: "active" | "done") {
  const state = portalStateSchema.parse({
    settings: {
      timezone: "Australia/Sydney",
      planningHorizonEnd: "20:00",
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
    areas: [
      { id: "work", name: "Work", status: "active", sortOrder: 0 },
      { id: "home", name: "Home", status: "active", sortOrder: 1 }
    ],
    outcomes: [
      { id: "outcome", areaId: "work", title: "Outcome", definitionOfDone: "Done.", value: 3, status: outcomeStatus }
    ],
    projects: [
      {
        id: "proj",
        title: "proj",
        area: "Work",
        outcomeId: "outcome",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3,
        internalDeadlineAt: iso(-2 * DAY)
      }
    ],
    actions: [
      {
        id: "write",
        projectId: "proj",
        title: "write",
        status: "active",
        optimisticMinutes: 60,
        expectedMinutes: 60,
        pessimisticMinutes: 60,
        remainingMinutes: 60,
        splittable: true,
        setupMinutes: 0,
        energy: "medium",
        minimumSessionMinutes: 15,
        maximumSessionMinutes: 60,
        importance: 3,
        consequence: 3,
        contexts: [],
        dependencyIds: [],
        schedulingMode: "one_off"
      }
    ],
    commitments: [],
    routineSteps: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: iso(30 * DAY),
    activeSession: null
  });
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-00000000dc05",
    inputVersion: "estimate-calibration-fixture",
    calculatedAt: now.toISOString(),
    horizonEnd: iso(30 * DAY),
    state
  });
}

type Forecast = { projectId: string; health: string; overdue?: boolean; reasons: string[] };
const forecastOf = (response: ReturnType<typeof calculatePlanAndForecast>) =>
  (response.schedule as { forecasts: Forecast[] }).forecasts.find((forecast) => forecast.projectId === "proj")!;
describe("closing an outcome", () => {
  it("keeps its projects forecast and recommendable while the outcome is active", () => {
    const response = calculatePlanAndForecast(request("active"));
    expect(forecastOf(response).health).not.toBe("unknown");
    // Its date has passed, so while the outcome is active the project is overdue and Review's panel lists it.
    expect(forecastOf(response).overdue).toBe(true);
    const recommendation = response.recommendation as unknown as { candidates: { eligible: boolean }[] };
    expect(recommendation.candidates[0]!.eligible).toBe(true);
  });

  it("stops forecasting and recommending its projects once the outcome is done", () => {
    const response = calculatePlanAndForecast(request("done"));
    const forecast = forecastOf(response);
    expect(forecast.health).toBe("unknown");
    expect(forecast.reasons.join(" ")).toContain("Parent outcome is not active.");
    expect(forecast.overdue).toBe(false);
    const recommendation = response.recommendation as unknown as {
      primary: unknown;
      candidates: { eligible: boolean; exclusionReasons: string[] }[];
    };
    expect(recommendation.primary).toBeNull();
    expect(recommendation.candidates.every((candidate) => !candidate.eligible)).toBe(true);
    expect(recommendation.candidates[0]!.exclusionReasons).toContain("Parent outcome is not active.");
  });
});
