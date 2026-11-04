import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

// 14:00 on Friday 14 August in the seed zone. The carnival runs 13:30–16:30, so `now` sits inside it with
// its setup buffer already behind and its transition buffer still ahead.
const now = new Date("2026-08-14T04:00:00.000Z");
const HOUR = 60 * 60_000;

const carnival = (presence: "blocking" | "anchor") => ({
  id: "carnival",
  title: "Swimming carnival",
  status: "confirmed",
  startsAt: new Date(now.getTime() - 0.5 * HOUR).toISOString(),
  endsAt: new Date(now.getTime() + 2.5 * HOUR).toISOString(),
  setupBeforeMinutes: 15,
  transitionAfterMinutes: 15,
  presence
});

// Automatic capacity spans the whole local day; these reproduce the old manual window (now-4h to
// now+6h) by blocking its complement across the planning horizon — local midnight up to the window's
// start, and the window's end well past every horizon these tests request. Always present alongside
// whatever `commitments` override a test supplies (see `state()` below), since every test's carnival
// sits inside the old window's span.
const blockingCommitments = [
  {
    id: "before-window",
    title: "Blocked (before window)",
    status: "confirmed",
    startsAt: new Date(now.getTime() - 14 * HOUR).toISOString(),
    endsAt: new Date(now.getTime() - 4 * HOUR).toISOString(),
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0
  },
  {
    id: "after-window",
    title: "Blocked (after window)",
    status: "confirmed",
    startsAt: new Date(now.getTime() + 6 * HOUR).toISOString(),
    endsAt: new Date(now.getTime() + 20 * 24 * HOUR).toISOString(),
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0
  }
];

function state(overrides: Record<string, unknown> = {}) {
  // Pulled out rather than left inside the object spread below, so a test's own `commitments`
  // override adds to the blocking commitments instead of silently discarding them.
  const { commitments: commitmentOverrides, ...restOverrides } = overrides as {
    commitments?: unknown[];
  } & Record<string, unknown>;
  return portalStateSchema.parse({
    settings: {
      timezone: "Australia/Sydney",
      locale: "en-AU",
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
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16
    },
    areas: [{ id: "area-1", name: "Study", status: "active", sortOrder: 0 }],
    outcomes: [
      {
        id: "outcome-1",
        areaId: "area-1",
        title: "Finish the unit",
        definitionOfDone: "Submitted",
        value: 3,
        status: "active"
      }
    ],
    projects: [
      {
        id: "project-1",
        title: "Assignment",
        area: "area-1",
        outcomeId: "outcome-1",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3
      }
    ],
    actions: [
      {
        id: "reading",
        projectId: "project-1",
        title: "Read the set chapter",
        status: "active",
        optimisticMinutes: 20,
        expectedMinutes: 30,
        remainingMinutes: 30,
        pessimisticMinutes: 45,
        energy: "medium",
        minimumSessionMinutes: 15,
        maximumSessionMinutes: 45,
        importance: 3,
        consequence: 3,
        contexts: [],
        dependencyIds: [],
        splittable: true,
        setupMinutes: 0
      }
    ],
    commitments: [...blockingCommitments, ...(commitmentOverrides ?? [])],
    routineSteps: [],
    routinePresets: [],
    occurrences: [],
    locationProfiles: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: new Date(now.getTime() + 14 * 24 * HOUR).toISOString(),
    activeSession: null,
    ...restOverrides
  });
}

/** The slice of the wire recommendation these tests read; the response carries it as plain JSON. */
interface WireRecommendation {
  primary: { action: { id: string } } | null;
  headline: string;
  protectedCommitment?: { id: string; phase: string };
  openAnchor?: { id: string; phase: string; title: string };
}

function run(overrides: Record<string, unknown> = {}, at: Date = now) {
  const response = calculatePlanAndForecast(
    planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-000000000004",
      inputVersion: "commitment-presence-fixture",
      calculatedAt: at.toISOString(),
      horizonEnd: new Date(at.getTime() + 14 * 24 * HOUR).toISOString(),
      state: state(overrides)
    })
  );
  return {
    recommendation: response.recommendation as unknown as WireRecommendation,
    currentDirective: response.currentDirective,
    dayPlan: response.dayPlan,
    schedule: response.schedule
  };
}

/**
 * The whole plan, as the wire carries it: every slot, allocation, envelope and forecast, plus the
 * projected day. Comparing the serialised forms means "an anchor plans identically" is checked
 * rather than asserted about the handful of fields a test author happened to think of.
 */
const planShape = (result: ReturnType<typeof run>) => ({
  schedule: JSON.stringify(result.schedule),
  dayPlan: JSON.stringify(result.dayPlan)
});

describe("an anchor commitment plans exactly like a blocking one", () => {
  it("produces the same schedule and the same day plan", () => {
    // Read from a moment before either commitment starts, so both runs are pure planning: nothing is
    // live, and the only thing that could differ is what the schedule made of the window.
    const before = new Date(now.getTime() - 3 * HOUR);
    const blocking = run({ commitments: [carnival("blocking")] }, before);
    const anchored = run({ commitments: [carnival("anchor")] }, before);
    expect(planShape(anchored)).toEqual(planShape(blocking));
  });

  it("keeps subtracting its window from capacity even while that window is live and open", () => {
    // The sharp case. At this instant the anchor's own hour is being offered to the ranking, and the
    // schedule must be untouched by that: capacity, allocations and forecasts still count the whole
    // window as gone, because a plan cannot know which obligations will leave gaps.
    const blocking = run({ commitments: [carnival("blocking")] });
    const anchored = run({ commitments: [carnival("anchor")] });
    expect(anchored.recommendation.primary).not.toBeNull();
    expect(blocking.recommendation.primary).toBeNull();
    expect(planShape(anchored).schedule).toEqual(planShape(blocking).schedule);
  });

  it("holds the clock during its setup buffer, where an anchor frees nothing", () => {
    // Twenty minutes before it starts: inside the setup buffer, which is the time spent getting
    // there rather than the time spent there. Both presences lock out identically.
    const gettingReady = new Date(now.getTime() - 0.5 * HOUR - 10 * 60_000);
    for (const presence of ["blocking", "anchor"] as const) {
      const result = run({ commitments: [carnival(presence)] }, gettingReady);
      expect(result.recommendation.primary).toBeNull();
      expect(result.recommendation.protectedCommitment).toMatchObject({ id: "carnival", phase: "setup" });
      expect(result.recommendation.openAnchor).toBeUndefined();
    }
  });
});

describe("an anchor commitment live", () => {
  it("locks the page out when it is blocking", () => {
    const result = run({ commitments: [carnival("blocking")] });
    expect(result.recommendation.primary).toBeNull();
    expect(result.recommendation.headline).toBe("Swimming carnival is in progress");
    expect(result.recommendation.protectedCommitment).toMatchObject({ id: "carnival", phase: "active" });
    expect(result.recommendation.openAnchor).toBeUndefined();
  });

  it("offers work in its own window, and names the anchor alongside it", () => {
    const result = run({ commitments: [carnival("anchor")] });
    expect(result.recommendation.primary?.action.id).toBe("reading");
    // Not `protectedCommitment`: everything downstream reads that as "the clock is held", and this
    // is the one case where the commitment is present and the clock is not.
    expect(result.recommendation.protectedCommitment).toBeUndefined();
    expect(result.recommendation.openAnchor).toMatchObject({
      id: "carnival",
      phase: "active",
      title: "Swimming carnival"
    });
    expect(result.currentDirective.kind).toBe("action");
  });

  it("locks out again once a session records the engagement", () => {
    const engaged = run({
      commitments: [carnival("anchor")],
      activeSession: {
        id: "session-1",
        actionId: "carnival",
        targetType: "fixed_commitment",
        targetId: "carnival",
        startedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
        plannedEndAt: new Date(now.getTime() + 50 * 60_000).toISOString(),
        plannedMinutes: 60,
        remainingBeforeMinutes: 0,
        activeElapsedSeconds: 600,
        status: "running"
      }
    });
    expect(engaged.recommendation.primary).toBeNull();
    expect(engaged.recommendation.protectedCommitment).toMatchObject({ id: "carnival", phase: "active" });
    expect(engaged.recommendation.openAnchor).toBeUndefined();
  });

  it("keeps block 0 as the live work directive at an open anchor, with the commitment as the next block (invariant 8)", () => {
    const result = run({ commitments: [carnival("anchor")] });
    expect(result.currentDirective.kind).toBe("action");
    const blocks = result.dayPlan!.blocks;
    expect(blocks[0]!.kind).toBe("action");
    expect(blocks[0]!.targetId).toBe("reading");
    const commitmentBlock = blocks
      .slice(1)
      .find((block) => block.kind === "commitment" && block.targetId === "carnival");
    expect(commitmentBlock).toBeDefined();
  });

  it("carries the rule's presence through a recurring series", () => {
    const result = run({
      commitmentRecurrenceRules: [
        {
          id: "weekly-carnival",
          title: "Swim squad",
          timezone: "Australia/Sydney",
          startDate: "2026-08-01",
          repeat: { unit: "days", intervalDays: 1 },
          localStartTime: "13:30",
          localEndTime: "16:30",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          presence: "anchor",
          status: "active"
        }
      ]
    });
    expect(result.recommendation.openAnchor).toMatchObject({ title: "Swim squad", phase: "active" });
    expect(result.recommendation.primary?.action.id).toBe("reading");
  });
});

describe("the explanation while a commitment is in progress", () => {
  it("names the same protected end as the Now card, transition included", () => {
    // The carnival ends 16:30 with a 15-minute transition, so the card says "Protected until 4:45 pm".
    const result = run({ commitments: [carnival("blocking")] });
    expect(result.recommendation.protectedCommitment).toMatchObject({ id: "carnival", phase: "active" });
    expect((result.recommendation as unknown as { explanation: string }).explanation).toBe(
      "Runs until 4:30 pm, then the transition after it keeps the time protected until 4:45 pm."
    );
  });
});
