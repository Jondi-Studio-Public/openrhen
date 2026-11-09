import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * The engine reads a stored refined consequence only when it was fitted for the stars the record has now.
 * A star edit therefore wins immediately, with no refit hook in the writer.
 */

const now = new Date("2026-08-19T00:00:00.000Z");
const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

type Refine = { consequenceRefined?: number; consequenceRefinedForStars?: number };

function request(project: Refine & { consequence?: number }, action: Refine & { consequence?: number }) {
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
    areas: [{ id: "work", name: "Work", status: "active", sortOrder: 0 }],
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
        ...project
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
        schedulingMode: "one_off",
        ...action
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
    requestId: "00000000-0000-4000-8000-00000000dc06",
    inputVersion: "consequence-refined-fixture",
    calculatedAt: now.toISOString(),
    horizonEnd: iso(30 * DAY),
    state
  });
}

const consequenceScore = (project: Refine & { consequence?: number }, action: Refine & { consequence?: number }) => {
  const response = calculatePlanAndForecast(request(project, action));
  const recommendation = response.recommendation as unknown as {
    candidates: { action: { id: string }; scoreComponents: { consequence: number } }[];
  };
  return recommendation.candidates.find((c) => c.action.id === "write")!.scoreComponents.consequence;
};

describe("refined consequence reaching the engine", () => {
  it("uses a refined value fitted for the current stars", () => {
    const stars = consequenceScore({}, {});
    const refined = consequenceScore({}, { consequenceRefined: 5, consequenceRefinedForStars: 3 });
    expect(refined).toBeGreaterThan(stars);
    const projectRefined = consequenceScore({ consequenceRefined: 5, consequenceRefinedForStars: 3 }, {});
    expect(projectRefined).toBeGreaterThan(stars);
  });

  it("ignores a refined value fitted for different stars (a star edit wins)", () => {
    const stars = consequenceScore({}, {});
    expect(consequenceScore({}, { consequenceRefined: 5, consequenceRefinedForStars: 2 })).toBe(stars);
    expect(consequenceScore({ consequenceRefined: 5, consequenceRefinedForStars: 4 }, {})).toBe(stars);
  });

  it("ignores a refined value that lacks its stars-at-fit marker, and the reverse", () => {
    const stars = consequenceScore({}, {});
    expect(consequenceScore({}, { consequenceRefined: 5 })).toBe(stars);
    expect(consequenceScore({}, { consequenceRefinedForStars: 3 })).toBe(stars);
  });

  it("rejects refined values outside 0..6 and non-integer stars markers at the schema", () => {
    expect(() => request({}, { consequenceRefined: 7, consequenceRefinedForStars: 3 })).toThrow();
    expect(() => request({}, { consequenceRefined: Number.NaN, consequenceRefinedForStars: 3 })).toThrow();
    expect(() => request({}, { consequenceRefined: 3.5, consequenceRefinedForStars: 2.5 })).toThrow();
    expect(() => request({}, { consequenceRefined: 5.5, consequenceRefinedForStars: 3 })).not.toThrow();
  });
});
