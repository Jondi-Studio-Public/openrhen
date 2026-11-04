import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * Learned estimate calibration (logic design §5): the factor the state read derives from
 * session history reaches every estimate in the matching area, names itself in the evidence, and
 * does nothing when switched off or when another area owns it.
 */

const now = new Date("2026-08-19T00:00:00.000Z");
const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

function request(options: { enabled?: boolean; calibration?: unknown; singleFigure?: boolean } = {}) {
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
      maxAwakeHours: 16,
      ...(options.enabled === undefined ? {} : { estimateCalibrationEnabled: options.enabled })
    },
    areas: [
      { id: "work", name: "Work", status: "active", sortOrder: 0 },
      { id: "home", name: "Home", status: "active", sortOrder: 1 }
    ],
    outcomes: [
      { id: "outcome", areaId: "work", title: "Outcome", definitionOfDone: "Done.", value: 3, status: "active" }
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
        internalDeadlineAt: iso(20 * DAY)
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
    activeSession: null,
    ...(options.calibration === undefined ? {} : { estimateCalibration: options.calibration })
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

const factor = (value: number, samples = 6) => ({ factor: value, samples, lastSampleAt: iso(-DAY) });
const protectedMinutes = (response: ReturnType<typeof calculatePlanAndForecast>) =>
  (
    response.schedule as { forecasts: { projectId: string; protectedRemainingMinutes: number | null }[] }
  ).forecasts.find((forecast) => forecast.projectId === "proj")?.protectedRemainingMinutes;
const evidence = (response: ReturnType<typeof calculatePlanAndForecast>) =>
  (response.recommendation as unknown as { evidence?: string[] }).evidence ?? [];

describe("learned estimate calibration", () => {
  it("leaves estimates alone without history", () => {
    const response = calculatePlanAndForecast(request());
    // The single-figure 60 is padded by the known-uncertainty multiplier (1.15): 69.
    expect(protectedMinutes(response)).toBe(69);
    expect(evidence(response).join(" ")).not.toContain("learned from");
  });

  it("scales the area's estimates by its own factor and says so", () => {
    const response = calculatePlanAndForecast(
      request({ calibration: { overall: factor(1.2, 9), areas: [{ areaId: "work", ...factor(1.5) }] } })
    );
    // Mean 60 × 1.5 = 90, padded by 1.15: 103.5 rounds up to 104.
    expect(protectedMinutes(response)).toBe(104);
    expect(evidence(response).join(" ")).toContain("scaled ×1.5 learned from 6 finished actions in this area");
  });

  it("falls back to the all-areas factor when the area has none of its own", () => {
    const response = calculatePlanAndForecast(
      request({ calibration: { overall: factor(1.25, 9), areas: [{ areaId: "home", ...factor(2) }] } })
    );
    expect(protectedMinutes(response)).toBe(87); // 60 × 1.25 = 75, padded by 1.15: 86.25
    expect(evidence(response).join(" ")).toContain("learned from 9 finished actions across areas");
  });

  it("parses a calibration with or without the learned spread and passes the spread through", () => {
    const withoutSpread = request({ calibration: { overall: factor(1.5), areas: [] } });
    expect(withoutSpread.state.estimateCalibration.overall?.spread).toBeUndefined();
    const withSpread = request({ calibration: { overall: { ...factor(1.5), spread: 1.3 }, areas: [] } });
    expect(withSpread.state.estimateCalibration.overall?.spread).toBe(1.3);
    // The single figure has no spread of its own, so the learned spread (1.3, above the project's 1.15)
    // pads the scaled mean: 90 × 1.3 = 117.
    expect(protectedMinutes(calculatePlanAndForecast(withSpread))).toBe(117);
  });

  it("passes a learned spread through to the project and names it when there is no factor", () => {
    // The spread reaches the project, the evidence says padding, and it widens the single figure's padding.
    const padded = calculatePlanAndForecast(
      request({ calibration: { overall: { ...factor(1), spread: 1.3 }, areas: [] } })
    );
    expect(protectedMinutes(padded)).toBe(78);
    expect(evidence(padded).join(" ")).toContain("padded ×1.3 learned from 6 finished actions across areas");
    expect(evidence(padded).join(" ")).not.toContain("scaled ×1 ");
    const none = calculatePlanAndForecast(
      request({ calibration: { overall: { ...factor(1), spread: 1 }, areas: [] } })
    );
    expect(evidence(none).join(" ")).not.toContain("learned from");
  });

  it("applies nothing once switched off", () => {
    const response = calculatePlanAndForecast(
      request({ enabled: false, calibration: { overall: factor(2), areas: [{ areaId: "work", ...factor(2) }] } })
    );
    expect(protectedMinutes(response)).toBe(69);
  });
});
