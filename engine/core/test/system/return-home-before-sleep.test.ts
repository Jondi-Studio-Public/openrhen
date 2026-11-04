import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * Report (CLI reviewer): a work commitment away from home that is the last located anchor before
 * sleep never got a return-home leg, so its `derivedState.commitmentTimelines` entry carried no
 * `homeAt` for it and every after-phase routine step landed right at the commitment's own end time —
 * "Get changed after arriving home" scheduled at the office, 15 minutes after a 09:00 finish, instead
 * of after the drive home.
 *
 * The root cause: `projectSituation` (situation-projection.ts) only ever put a `return_home` leg
 * between two anchors via `chooseAfterAnchor`, the usable-minutes trade-off between staying and
 * going home. With no workable action anywhere — the exact shape of an evening with nothing left to
 * do — that chooser always reads both options as zero minutes and defaults to "stay" (its own
 * documented tie-break), so a commitment whose only "next" anchor was the night's sleep never went
 * home at all. Sleep is not a trade-off: you cannot do it anywhere else. The fix forces the leg
 * whenever the next anchor's reason is "sleep", bypassing the chooser entirely for that one case.
 *
 * The engine placer (`engine/core/src/scheduling/routine-placement.ts`) and the day-plan directing of
 * a step it places are covered by `routine-step-travel.test.ts` and `routine-inheritance.test.ts`;
 * this file is the layer beneath that: proving the engine actually produces the homeward-leg edge
 * those placements are chained from, for exactly the "nothing left to do tonight" shape that used to
 * lose it.
 */

const now = new Date("2026-08-19T00:00:00.000Z");
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

const TRAVEL_MINUTES = 25;
// A stored fallback carries the journey store's padding (the travel time model design note,
// "Variability"): `max(3, 0.15 × typical)` on top, rounded up, since nothing is sampled here.
const PADDED_TRAVEL_MINUTES = Math.ceil(TRAVEL_MINUTES + Math.max(3, 0.15 * TRAVEL_MINUTES));
const TRANSITION_MINUTES = 20;
const START_OFFSET = 4 * HOUR;
const END_OFFSET = 5 * HOUR;

function request() {
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
      conditionCatalog: ["home", "work"],
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16,
      homeLocationId: "home",
      lastWokeAt: iso(-3 * HOUR)
    },
    areas: [],
    outcomes: [],
    projects: [],
    // Deliberately no candidate actions anywhere: this is what used to defeat the after-anchor
    // chooser — with nothing workable at either place, `chooseAfterAnchorByUsableMinutes` reads both
    // "stay" and "home" as zero usable minutes and ties to "stay", so the old code never went home
    // before sleep no matter how many idle hours were actually ahead of it.
    actions: [],
    commitments: [
      // At home already, and well before "work" — must never pick up a return leg of its own; the
      // early "already home" guard in situation-projection.ts is what this checks. Placed *before*
      // "work" rather than between it and sleep, so it does not itself become "work"'s next anchor —
      // that would let its own approach leg (a real journey, just carrying the *next* commitment's
      // id, not "work"'s) stand in for the fix under test instead of proving it.
      {
        id: "chores",
        title: "Chores",
        status: "confirmed",
        startsAt: iso(30 * 60_000),
        endsAt: iso(60 * 60_000),
        locationId: "home",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      },
      // The last located anchor of the day: nothing else stands between it and tonight's sleep.
      {
        id: "work",
        title: "Work",
        status: "confirmed",
        startsAt: iso(START_OFFSET),
        endsAt: iso(END_OFFSET),
        locationId: "work",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: TRANSITION_MINUTES
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
      { id: "home", name: "Home", kind: "location", status: "active" },
      { id: "work", name: "Work", kind: "location", status: "active", travelMinutes: TRAVEL_MINUTES }
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
    requestId: "00000000-0000-4000-8000-00000000fe12",
    inputVersion: "return-home-before-sleep-fixture",
    calculatedAt: now.toISOString(),
    horizonEnd: iso(30 * 24 * HOUR),
    state
  });
}

describe("a commitment away from home before sleep always gets its journey home", () => {
  it("carries a homeward leg for the last away-from-home commitment even with nothing to stay for, and none for one already at home", () => {
    const response = calculatePlanAndForecast(request());
    const timelines = response.derivedState.commitmentTimelines as Array<{
      id: string;
      freeAt: string;
      homeAt?: string;
    }>;

    const work = timelines.find((item) => item.id === "work");
    expect(work?.homeAt).toBeDefined();
    expect(Math.round((new Date(work!.homeAt!).getTime() - new Date(work!.freeAt).getTime()) / 60_000)).toBe(
      PADDED_TRAVEL_MINUTES
    );

    const chores = timelines.find((item) => item.id === "chores");
    expect(chores?.homeAt).toBeUndefined();
  });
});
