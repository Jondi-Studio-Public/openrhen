import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * `resolvePlaces.workableAt` (engine.ts) used to scan only `state.actions` when deciding whether a
 * place is worth staying at between two located commitments — a deliverable step gated to a location
 * was invisible to it, so a location where only deliverable-step work was possible always read as
 * "nothing workable here", biasing `chooseAfterAnchorByUsableMinutes` toward staying rather than the
 * trip actually worth making. This proves the fix: threading `request.deliverables` through
 * `workableAt` the same way the rest of the engine already ranks deliverable steps.
 *
 * The signal is `derivedState.commitmentTimelines`: a `return_home` leg between "morning" and
 * "afternoon" attaches as a `homeAt` edge on "morning"'s timeline only when the chooser actually
 * picks "home" over "stay" (`withTravelLegs`, engine.ts). With nothing workable anywhere the chooser
 * ties at zero and stays, so no such leg exists (no `homeAt`); once a deliverable step is workable
 * only at home, home has usable minutes and work does not, so the chooser sends the day home in
 * between, and `homeAt` sits `HOME_TRAVEL_MINUTES` after `freeAt`.
 */

const now = new Date("2026-08-19T00:00:00.000Z");
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

const HOME_TRAVEL_MINUTES = 15;
const CAMPUS_TRAVEL_MINUTES = 35;
// A stored fallback carries the journey store's padding (the travel time model design note,
// "Variability"): `max(3, 0.15 × typical)` on top, rounded up, since nothing is sampled here.
const PADDED_HOME_TRAVEL_MINUTES = Math.ceil(HOME_TRAVEL_MINUTES + Math.max(3, 0.15 * HOME_TRAVEL_MINUTES));

function request(deliverables: Record<string, unknown>[]) {
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
      conditionCatalog: ["home", "work", "campus"],
      preferredBedtime: "23:59",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 18,
      homeLocationId: "home",
      arrivalMarginMinutes: 0,
      lastWokeAt: iso(-3 * HOUR)
    },
    areas: [{ id: "area-study", name: "Study", status: "active", sortOrder: 0 }],
    outcomes: [
      {
        id: "unit",
        areaId: "area-study",
        title: "Unit",
        definitionOfDone: "Unit complete",
        value: 3,
        status: "active"
      }
    ],
    projects: [
      {
        id: "project",
        title: "Project",
        area: "Study",
        outcomeId: "unit",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3
      }
    ],
    // Deliberately no candidate actions anywhere: nothing must be workable except whatever the
    // deliverable fixture below offers, so the comparison isolates the fix under test.
    actions: [],
    commitments: [
      // Away from home, mid-morning; nothing at the far end of the gap forces a home leg on its own
      // (no sleep anchor sits between these two, unlike `return-home-before-sleep.test.ts`).
      {
        id: "morning",
        title: "Morning class",
        status: "confirmed",
        startsAt: iso(2 * HOUR),
        endsAt: iso(3 * HOUR),
        locationId: "work",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      },
      // A four-hour gap, then a second located commitment elsewhere: long enough that going home and
      // back easily clears the minimum useful session, if anything at home is actually workable.
      {
        id: "afternoon",
        title: "Afternoon class",
        status: "confirmed",
        startsAt: iso(7 * HOUR),
        endsAt: iso(8 * HOUR),
        locationId: "campus",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    ],
    routineSteps: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: iso(30 * 24 * HOUR),
    activeSession: null,
    conditionDefinitions: [
      { id: "home", name: "Home", kind: "location", status: "active", travelMinutes: HOME_TRAVEL_MINUTES },
      { id: "work", name: "Work", kind: "location", status: "active", travelMinutes: 25 },
      { id: "campus", name: "Campus", kind: "location", status: "active", travelMinutes: CAMPUS_TRAVEL_MINUTES }
    ],
    currentSituation: {
      locationId: "home",
      locationSetAt: now.toISOString(),
      overrides: {},
      carrying: {},
      transportModes: ["car"],
      travel: {}
    }
  });
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-0000000000d4",
    inputVersion: "deliverable-stay-vs-home-fixture",
    calculatedAt: now.toISOString(),
    horizonEnd: iso(30 * 24 * HOUR),
    state,
    deliverables
  });
}

const homeOnlyStep = {
  id: "assessment",
  projectId: "project",
  title: "Home-only assessment step",
  status: "in_progress",
  approved: true,
  remainingMinutes: 60,
  minimumUsefulSessionMinutes: 20,
  uncertainty: "known",
  importance: 3,
  consequence: 3,
  executionOptions: [
    {
      id: "write-up",
      title: "Write it up",
      optimisticMinutes: 20,
      expectedMinutes: 30,
      pessimisticMinutes: 45,
      remainingMinutes: 30,
      energy: "medium",
      minimumSessionMinutes: 20,
      maximumSessionMinutes: 60,
      // The step this whole fix exists for: workable only at home, never at "work" or "campus".
      requirementPathways: [{ id: "at-home", contextIds: ["home"] }]
    }
  ]
};

function travelAfterFor(response: ReturnType<typeof calculatePlanAndForecast>, id: string) {
  const timelines = response.derivedState.commitmentTimelines as
    Array<{ id: string; freeAt: string; homeAt?: string }> | undefined;
  const timeline = timelines?.find((item) => item.id === id);
  if (!timeline?.homeAt) return undefined;
  return Math.round((new Date(timeline.homeAt).getTime() - new Date(timeline.freeAt).getTime()) / 60_000);
}

describe("deliverable-step workability in the stay-vs-home choice", () => {
  it("stays between two commitments when nothing, action or deliverable step, is workable anywhere", () => {
    const response = calculatePlanAndForecast(request([]));
    expect(travelAfterFor(response, "morning")).toBeUndefined();
  });

  it("sends the day home in the gap once a deliverable step is workable only there", () => {
    const response = calculatePlanAndForecast(request([homeOnlyStep]));
    expect(travelAfterFor(response, "morning")).toBe(PADDED_HOME_TRAVEL_MINUTES);
  });

  it("still stays when the only deliverable step is workable at the commitment's own place instead", () => {
    const workOnlyStep = {
      ...homeOnlyStep,
      executionOptions: [
        { ...homeOnlyStep.executionOptions[0], requirementPathways: [{ id: "at-work", contextIds: ["work"] }] }
      ]
    };
    const response = calculatePlanAndForecast(request([workOnlyStep]));
    expect(travelAfterFor(response, "morning")).toBeUndefined();
  });
});
