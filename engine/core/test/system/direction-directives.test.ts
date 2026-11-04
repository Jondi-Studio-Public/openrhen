import { describe, expect, it } from "vitest";
import {
  PLAN_FORECAST_CONTRACT_VERSION,
  planForecastRequestSchema,
  planForecastResponseSchema,
  portalStateSchema
} from "@openrhen/contracts";
import { PLAN_FORECAST_ENGINE_VERSION, calculatePlanAndForecast } from "../../src/index.js";

// 17:30 in the seed zone; the daily horizon in these fixtures is 18:00.
const now = new Date("2026-08-14T07:30:00.000Z");
const HOUR = 60 * 60_000;

function baseState(overrides: Record<string, unknown> = {}) {
  return portalStateSchema.parse({
    settings: {
      timezone: "Australia/Sydney",
      locale: "en-AU",
      planningHorizonEnd: "18:00",
      defaultUsableFraction: 0.8,
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
      maxAwakeHours: 18
    },
    areas: [{ id: "area-1", name: "Study", status: "active", sortOrder: 0 }],
    outcomes: [
      { id: "outcome-1", areaId: "area-1", title: "Outcome", definitionOfDone: "Done", value: 3, status: "active" }
    ],
    projects: [
      {
        id: "project-1",
        title: "Project one",
        area: "area-1",
        outcomeId: "outcome-1",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3,
        internalDeadlineAt: new Date(now.getTime() + 5 * 24 * HOUR).toISOString()
      }
    ],
    actions: [
      {
        id: "action-1",
        projectId: "project-1",
        title: "Write the report",
        status: "active",
        optimisticMinutes: 100,
        expectedMinutes: 120,
        remainingMinutes: 120,
        pessimisticMinutes: 160,
        energy: "medium",
        minimumSessionMinutes: 45,
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
    commitments: [],
    routineSteps: [],
    routinePresets: [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: [],
    currentEnergy: "medium",
    horizonEnd: new Date(now.getTime() + 30 * 24 * HOUR).toISOString(),
    activeSession: null,
    ...overrides
  });
}

function request(state: ReturnType<typeof baseState>) {
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-000000000003",
    inputVersion: "direction-fixture",
    calculatedAt: now.toISOString(),
    horizonEnd: new Date(now.getTime() + 30 * 24 * HOUR).toISOString(),
    state
  });
}

describe("boundary and answer directives", () => {
  it("names the daily horizon and tomorrow's first fit when too little of the day is left", () => {
    const response = calculatePlanAndForecast(request(baseState()));
    expect(response.engineVersion).toBe(PLAN_FORECAST_ENGINE_VERSION);
    expect(() => planForecastResponseSchema.parse(response)).not.toThrow();
    const directive = response.currentDirective;
    expect(directive.kind).toBe("boundary");
    if (directive.kind !== "boundary") throw new Error("expected boundary");
    expect(directive.boundaryKind).toBe("daily_horizon");
    expect(directive.boundaryAt).toBe("2026-08-14T08:00:00.000Z");
    expect(directive.nextFit?.targetId).toBe("action-1");
    expect(directive.nextFit?.kind).toBe("action");
    // The next local day in the seed zone, after the assumed night.
    expect(new Date(directive.nextFit!.at).getTime()).toBeGreaterThanOrEqual(Date.parse("2026-08-14T21:00:00.000Z"));
    expect(directive.title).toContain("Nothing fits before the day ends at 6:00 pm");
  });

  it("asks the question when an unanswered context is the only blocker, carrying what would lead", () => {
    const state = baseState({
      conditionDefinitions: [{ id: "home", name: "home", kind: "location", status: "active" }],
      currentSituation: {},
      settings: { ...baseState().settings, planningHorizonEnd: "22:00" },
      actions: [
        {
          ...baseState().actions[0],
          requirementPathways: [{ id: "path", contextIds: ["home"] }]
        }
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    expect(() => planForecastResponseSchema.parse(response)).not.toThrow();
    const directive = response.currentDirective;
    expect(directive.kind).toBe("answer");
    if (directive.kind !== "answer") throw new Error("expected answer");
    expect(directive.question).toBe("Are you at home?");
    expect(directive.contextIds).toEqual(["home"]);
    expect(directive.candidate).toEqual({
      kind: "action",
      targetId: "action-1",
      title: "Write the report",
      recommendedMinutes: 60
    });
  });
});

describe("week outlook", () => {
  it("reports the detailed band by project and by area, and which projects are under-paced", () => {
    const state = baseState({ settings: { ...baseState().settings, planningHorizonEnd: "22:00" } });
    const response = calculatePlanAndForecast(request(state));
    const outlook = response.weekOutlook as {
      capacityMinutes: number;
      reservedMinutes: number;
      freeMinutes: number;
      projects: Array<{ projectId: string; reservedMinutes: number; paceShortfallMinutes: number; health: string }>;
      underPacedProjectIds: string[];
      areas: Array<{ areaId: string; reservedMinutes: number }>;
    };
    expect(outlook).toBeDefined();
    expect(outlook.capacityMinutes).toBeGreaterThan(0);
    expect(outlook.reservedMinutes + outlook.freeMinutes).toBe(outlook.capacityMinutes);
    const project = outlook.projects.find((item) => item.projectId === "project-1")!;
    expect(project.reservedMinutes).toBeGreaterThan(0);
    expect(project.health).toBe("on_track");
    // On track and holding its whole reservation this week: not a shortfall the review needs to see.
    expect(outlook.underPacedProjectIds).toEqual([]);
    expect(outlook.areas).toEqual([{ areaId: "area-1", reservedMinutes: project.reservedMinutes }]);
  });
});
