import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";
import { compactDayPlan } from "../model/day-plan-harness.js";

/**
 * A sibling bug: a before-phase routine step chained back only from
 * `startsAt − setupBeforeMinutes`, ignorant of the journey ahead of it, so the tail of the chain
 * landed inside the travel/arrival margin the commitment itself protects — "pack the bag" scheduled
 * while the plan says you're already in the car. The `!protectedFixedCommitment` directive guard
 * then swallowed it: the live directive read "Preparing for X" / "Travel to X" and the step just sat
 * pending, never directed. The after phase was the mirror bug, chaining forward from `endsAt` alone
 * through the return leg.
 *
 * `computeRoutineStepSchedule` (platform/database) now chains the before phase back from
 * `startsAt − (setupBeforeMinutes + travelBeforeMinutes + ARRIVAL_MARGIN_MINUTES)` when there is a
 * leg, and the after phase forward from `endsAt + transitionAfterMinutes + travelAfterMinutes`
 * — see that file's own unit tests for the anchor arithmetic in isolation. This file is the other
 * half: the engine never computes a step's own schedule (it only ever consumes
 * `scheduledStartAt`/`scheduledEndAt` as already-decided facts), so what it can prove is that a step
 * scheduled per the corrected anchor is *directable* — sitting fully outside the commitment's own
 * protected window rather than swallowed by it. `routineSteps` below carries times computed by that
 * same corrected formula, standing in for what a real forecast persist would have written.
 */

const now = new Date("2026-08-19T00:00:00.000Z");
const HOUR = 3_600_000;
const MIN = 60_000;
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

// One journey each way: a 25-minute stored fallback, which the journey store pads to 29 minutes
// (the travel time model design note, "Variability": `max(3, 0.15 × typical)`, rounded up, since
// nothing about it is sampled) — the padded figure is what the plan actually schedules around.
const TRAVEL_MINUTES = 25;
const PADDED_TRAVEL_MINUTES = Math.ceil(TRAVEL_MINUTES + Math.max(3, 0.15 * TRAVEL_MINUTES));
const ARRIVAL_MARGIN_MINUTES = 2;
const SETUP_MINUTES = 10;
const TRANSITION_MINUTES = 5;
const START_OFFSET = 4 * HOUR;
const END_OFFSET = 5 * HOUR;
// setup + travel + arrival margin ahead of start; a 10-minute step ends exactly there.
const BEFORE_LEAD_MS = (SETUP_MINUTES + PADDED_TRAVEL_MINUTES + ARRIVAL_MARGIN_MINUTES) * MIN;
// transition + the return leg behind end (no arrival margin on the way back); a 10-minute step
// starts exactly there.
const AFTER_LAG_MS = (TRANSITION_MINUTES + PADDED_TRAVEL_MINUTES) * MIN;

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
      // Sleep is only planned once the engine knows when today started; it also gives the after-work
      // anchor a reason to choose "home" over "stay", which is what puts a return leg on the
      // commitment in the first place (§ situation-projection.ts's after-anchor chooser).
      lastWokeAt: iso(-3 * HOUR)
    },
    areas: [{ id: "area", name: "Everything", status: "active", sortOrder: 0 }],
    outcomes: [
      { id: "outcome", areaId: "area", title: "Outcome", definitionOfDone: "Done.", value: 3, status: "active" }
    ],
    projects: [
      {
        id: "proj",
        title: "proj",
        area: "Everything",
        outcomeId: "outcome",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3,
        internalDeadlineAt: iso(60 * 24 * HOUR)
      }
    ],
    // Workable everywhere (empty contexts): the after-anchor chooser treats a place nothing can be
    // done at as worth nothing, so a candidate action has to exist for "go home" to ever beat
    // "stay" on the merits rather than by the empty-set default.
    actions: [
      {
        id: "write",
        projectId: "proj",
        title: "write",
        status: "active",
        optimisticMinutes: 240,
        expectedMinutes: 240,
        pessimisticMinutes: 240,
        remainingMinutes: 240,
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
    commitments: [
      {
        id: "work",
        title: "Work",
        status: "confirmed",
        startsAt: iso(START_OFFSET),
        endsAt: iso(END_OFFSET),
        locationId: "work",
        setupBeforeMinutes: SETUP_MINUTES,
        transitionAfterMinutes: TRANSITION_MINUTES
      }
    ],
    routineSteps: [
      {
        id: "pack",
        commitmentId: "work",
        title: "Pack bag",
        durationMinutes: 10,
        sequence: 0,
        timingRule: "contiguous",
        energy: "medium",
        contexts: [],
        phase: "before",
        status: "pending",
        scheduledStartAt: iso(START_OFFSET - BEFORE_LEAD_MS - 10 * MIN),
        scheduledEndAt: iso(START_OFFSET - BEFORE_LEAD_MS)
      },
      {
        id: "unpack",
        commitmentId: "work",
        title: "Unpack bag",
        durationMinutes: 10,
        sequence: 1,
        timingRule: "contiguous",
        energy: "medium",
        contexts: [],
        phase: "after",
        status: "pending",
        scheduledStartAt: iso(END_OFFSET + AFTER_LAG_MS),
        scheduledEndAt: iso(END_OFFSET + AFTER_LAG_MS + 10 * MIN)
      }
    ],
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
    requestId: "00000000-0000-4000-8000-00000000fe11",
    inputVersion: "routine-step-travel-fixture",
    calculatedAt: now.toISOString(),
    horizonEnd: iso(30 * 24 * HOUR),
    state
  });
}

describe("a routine step's corrected schedule sits outside its commitment's travel window", () => {
  it("computes a leg each way, and the day plan directs both steps in the gaps that fixes them into", () => {
    const response = calculatePlanAndForecast(request());

    // Sanity check on the fixture itself: both legs are really there, so the step windows below are
    // being checked against a commitment that actually has a journey each way, not a coincidence of a
    // zero-travel anchor.
    const timelines = response.derivedState.commitmentTimelines as Array<{
      id: string;
      leaveBy?: string;
      arriveBy: string;
      freeAt: string;
      homeAt?: string;
    }>;
    const work = timelines.find((item) => item.id === "work")!;
    expect(Math.round((new Date(work.arriveBy).getTime() - new Date(work.leaveBy!).getTime()) / 60_000)).toBe(
      PADDED_TRAVEL_MINUTES
    );
    expect(Math.round((new Date(work.homeAt!).getTime() - new Date(work.freeAt).getTime()) / 60_000)).toBe(
      PADDED_TRAVEL_MINUTES
    );

    expect(compactDayPlan(response.dayPlan!)).toEqual([
      // Each 60-minute session reaches `write`'s own maximum, so it owes its maximum-session break
      // (ranking-consistency) before it is offered again; with nothing else to work, that is a gap.
      "00:00-01:00 action write 60/60 ordinary",
      "01:00-01:15 gap 0/15 none",
      "01:15-02:15 action write 60/60 ordinary",
      "02:15-02:30 gap 0/15 none",
      "02:30-03:09 action write 39/39 ordinary",
      "03:09-03:19 routine_step pack 0/10",
      "03:19-03:29 commitment work 0/10",
      "03:29-03:58 travel→work work 0/29",
      "03:58-05:05 commitment work 0/67",
      "05:05-05:34 travel→home 0/29",
      "05:34-05:44 routine_step unpack 0/10",
      "05:44-06:44 action write 60/60 ordinary",
      "06:44-06:59 gap 0/15 none",
      "06:59-07:24 action write 25/25 ordinary",
      "07:24-10:00 gap 0/156 none"
    ]);

    const blocks = response.dayPlan!.blocks;
    const pack = blocks.find((block) => block.kind === "routine_step" && block.targetId === "pack")!;
    const unpack = blocks.find((block) => block.kind === "routine_step" && block.targetId === "unpack")!;
    const approach = blocks.find((block) => block.kind === "travel" && block.toLocationId === "work")!;
    const returnHome = blocks.find((block) => block.kind === "travel" && block.toLocationId === "home")!;

    // Before phase: the step ends exactly where the journey's own lead begins (setup + travel +
    // arrival margin ahead of startsAt) — immediately abutting the commitment's own setup block, with
    // the journey itself (`approach`) still a whole setup block further on, not overlapping the step.
    const packIndex = blocks.indexOf(pack);
    expect(pack.endsAt).toBe(new Date(now.getTime() + START_OFFSET - BEFORE_LEAD_MS).toISOString());
    expect(blocks[packIndex + 1]!.startsAt).toBe(pack.endsAt);
    expect(new Date(pack.endsAt).getTime()).toBeLessThan(new Date(approach.startsAt).getTime());

    // After phase: the step starts exactly where the return leg ends (transition + the leg itself, no
    // arrival margin on the way back) — immediately abutting it, not inside it.
    expect(unpack.startsAt).toBe(returnHome.endsAt);
    expect(unpack.startsAt).toBe(new Date(now.getTime() + END_OFFSET + AFTER_LAG_MS).toISOString());

    // The point of both: `pack` and `unpack` are directed at all (kind `routine_step`, not swallowed
    // into the commitment's own `Preparing for Work` / `Travel to Work` / `Travel to Home` phases) —
    // block 0 of a day plan is always the live directive computed the same way
    // (day-plan.ts), so this is exactly the check a real "what should I do right now" call makes at
    // each of those instants.
    expect(pack.kind).toBe("routine_step");
    expect(unpack.kind).toBe("routine_step");
  });
});
