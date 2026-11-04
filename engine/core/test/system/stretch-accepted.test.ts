import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * A stored accepted stretch waives the low-energy cut for its action while it lasts (PR 3): the whole
 * engine, from the stored situation to the ranked candidates.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = new Date("2026-08-14T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const ahead = (ms: number) => new Date(now.getTime() + ms).toISOString();

function wire(stretch: unknown) {
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
      conditionCatalog: ["home"],
      preferredBedtime: "23:00",
      preferredWakeTime: "06:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16,
      arrivalMarginMinutes: 0,
      lastWokeAt: ago(2 * HOUR)
    },
    areas: [{ id: "area-1", name: "Study", status: "active", sortOrder: 0 }],
    outcomes: [
      { id: "outcome-1", areaId: "area-1", title: "Pass", definitionOfDone: "Done", value: 3, status: "active" }
    ],
    projects: [
      {
        id: "project-1",
        title: "Course unit",
        area: "area-1",
        outcomeId: "outcome-1",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3,
        externalDeadlineAt: ahead(DAY)
      }
    ],
    actions: [
      {
        id: "unit-3",
        projectId: "project-1",
        title: "Unit 3",
        status: "active",
        optimisticMinutes: 300,
        expectedMinutes: 360,
        remainingMinutes: 360,
        pessimisticMinutes: 480,
        energy: "high",
        minimumSessionMinutes: 30,
        maximumSessionMinutes: 90,
        importance: 3,
        consequence: 3,
        contexts: [],
        dependencyIds: [],
        splittable: true,
        setupMinutes: 0
      }
    ],
    commitments: [],
    routineSteps: [],
    routinePresets: [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "low",
    horizonEnd: ahead(3 * DAY),
    activeSession: null,
    conditionDefinitions: [{ id: "home", name: "Home", kind: "location", status: "active" }],
    currentSituation: {
      locationId: "home",
      locationSetAt: ago(HOUR),
      energySetAt: ago(HOUR),
      transportModes: ["car"],
      ...(stretch ? { stretch } : {})
    }
  });
}

function run(stretch: unknown, at = now) {
  return calculatePlanAndForecast(
    planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-0000000ef0a2",
      inputVersion: "stretch-accepted-fixture",
      calculatedAt: at.toISOString(),
      horizonEnd: ahead(3 * DAY),
      state: wire(stretch)
    })
  );
}

const record = (over: Record<string, unknown> = {}) => ({
  actionId: "unit-3",
  title: "Unit 3",
  acceptedAt: ago(10 * MINUTE),
  until: ahead(30 * MINUTE),
  minutes: 40,
  by: "person",
  ...over
});

type Recommendation = {
  primary?: { action: { id: string } };
  stretchOffer?: { actionId: string };
  candidates: { action: { id: string }; eligible: boolean; exclusionReasons: string[] }[];
};
const recommendationOf = (response: ReturnType<typeof run>) => response.recommendation as unknown as Recommendation;
const unit = (response: ReturnType<typeof run>) =>
  recommendationOf(response).candidates.find((candidate) => candidate.action.id === "unit-3")!;

describe("stored stretch in the whole engine", () => {
  it("cuts the high-energy action at declared low energy and offers a stretch", () => {
    const response = run(undefined);
    expect(unit(response).eligible).toBe(false);
    expect(unit(response).exclusionReasons.join(" ")).toContain("Current energy is low");
    expect(recommendationOf(response).stretchOffer?.actionId).toBe("unit-3");
  });

  it("makes it eligible and leading while the stretch lasts, and cuts it again after", () => {
    const stretch = { accepted: [record()], declined: [] };
    const during = run(stretch);
    expect(unit(during).eligible).toBe(true);
    expect(recommendationOf(during).primary?.action.id).toBe("unit-3");
    expect(recommendationOf(during).stretchOffer).toBeUndefined();

    const after = run(stretch, new Date(now.getTime() + 30 * MINUTE));
    expect(unit(after).eligible).toBe(false);
  });

  it("ends the stretch when energy is declared again afterwards", () => {
    const stretch = { accepted: [record({ acceptedAt: ago(2 * HOUR), until: ahead(HOUR) })], declined: [] };
    expect(unit(run(stretch)).eligible).toBe(false);
  });

  it("offers nothing for a declined action or after declining all", () => {
    const declined = { accepted: [], declined: [{ actionId: "unit-3", at: ago(5 * MINUTE) }] };
    expect(recommendationOf(run(declined)).stretchOffer).toBeUndefined();
    const none = { accepted: [], declined: [], declinedAllAt: ago(5 * MINUTE) };
    expect(recommendationOf(run(none)).stretchOffer).toBeUndefined();
  });
});
