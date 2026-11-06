import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * "I'm free": `freedFrom` on a commitment (`commitments.freed_from`) releases the rest of that
 * occurrence to the live ranking. The commitment is neither ended nor finished, so the day plan still
 * draws it and forecasts stay pessimistic; what changes is that the Now card stops saying it is in
 * progress and the next task is offered at once, whatever the presence, an open tracking session or
 * an unasserted arrival.
 */

const now = new Date("2026-08-19T00:00:00.000Z");
const HOUR = 3_600_000;
const MIN = 60_000;
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

const TRAVEL_MINUTES = 8;

function request(
  overrides: {
    routineSteps?: unknown[];
    currentLocationId?: string;
    startsAtOffset?: number;
    endsAtOffset?: number;
    setupBeforeMinutes?: number;
    presence?: "blocking" | "anchor";
    freedFrom?: string;
    activeSession?: unknown;
    transitionAfterMinutes?: number;
  } = {}
) {
  const startsAtOffset = overrides.startsAtOffset ?? -10 * MIN;
  const endsAtOffset = overrides.endsAtOffset ?? 3 * HOUR;
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
      conditionCatalog: ["home", "college"],
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16,
      homeLocationId: "home",
      arrivalMarginMinutes: 2
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
    // Workable everywhere (empty contexts), so ordinary ranking has something real to offer once —
    // and only once — the anchor's window actually opens.
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
    // Automatic capacity spans the whole local day; these reproduce the old manual window (now-4h
    // to now+6h) by blocking its complement across the planning horizon — local midnight up to the
    // window's start, and the window's end well past the 30-day horizon every request here asks for.
    commitments: [
      {
        id: "college-class",
        title: "College Class",
        status: "confirmed",
        startsAt: iso(startsAtOffset),
        endsAt: iso(endsAtOffset),
        locationId: "college",
        presence: overrides.presence ?? "blocking",
        ...(overrides.freedFrom !== undefined ? { freedFrom: overrides.freedFrom } : {}),
        setupBeforeMinutes: overrides.setupBeforeMinutes ?? 0,
        transitionAfterMinutes: overrides.transitionAfterMinutes ?? 0
      },
      {
        id: "before-window",
        title: "Blocked (before window)",
        status: "confirmed",
        startsAt: iso(-10 * HOUR),
        endsAt: iso(-4 * HOUR),
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      },
      {
        id: "after-window",
        title: "Blocked (after window)",
        status: "confirmed",
        startsAt: iso(6 * HOUR),
        endsAt: iso(35 * 24 * HOUR),
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    ],
    routineSteps: overrides.routineSteps ?? [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: iso(30 * 24 * HOUR),
    activeSession: overrides.activeSession ?? null,
    conditionDefinitions: [
      { id: "home", name: "Home", kind: "location", status: "active" },
      { id: "college", name: "College", kind: "location", status: "active", travelMinutes: TRAVEL_MINUTES }
    ],
    currentSituation: {
      locationId: overrides.currentLocationId ?? "home",
      locationSetAt: now.toISOString(),
      overrides: {},
      carrying: {},
      transportModes: ["car"],
      travel: {}
    }
  });
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-00000000fe23",
    inputVersion: "commitment-freed-fixture",
    calculatedAt: now.toISOString(),
    horizonEnd: iso(30 * 24 * HOUR),
    state
  });
}

const packStep = (overrides: Record<string, unknown> = {}) => ({
  id: "pack",
  commitmentId: "college-class",
  title: "Pack Bag",
  durationMinutes: 10,
  sequence: 0,
  timingRule: "flexible" as const,
  energy: "medium" as const,
  contexts: [],
  dependencyIds: [],
  phase: "before" as const,
  status: "pending" as const,
  scheduledStartAt: iso(-40 * MIN),
  scheduledEndAt: iso(-30 * MIN),
  ...overrides
});

const openSession = {
  id: "session-1",
  actionId: "college-class",
  targetType: "fixed_commitment",
  targetId: "college-class",
  startedAt: iso(-10 * MIN),
  plannedEndAt: iso(50 * MIN),
  plannedMinutes: 60,
  remainingBeforeMinutes: 0,
  activeElapsedSeconds: 600,
  status: "running"
};

interface WireRecommendation {
  primary: { action: { id: string } } | null;
  headline: string;
  protectedCommitment?: { id: string; phase: string };
  openAnchor?: { id: string; phase: string; title: string };
}
const recommendationOf = (response: ReturnType<typeof calculatePlanAndForecast>) =>
  response.recommendation as unknown as WireRecommendation;

describe("a freed commitment", () => {
  it("is in progress and offers nothing before the person says they are free (baseline)", () => {
    const response = calculatePlanAndForecast(request({ routineSteps: [packStep()], activeSession: openSession }));
    expect(recommendationOf(response).primary).toBeNull();
    expect(recommendationOf(response).protectedCommitment).toMatchObject({ id: "college-class" });
  });

  it("offers the next task at once, with an open session, no arrival and a pending before-step", () => {
    const response = calculatePlanAndForecast(
      request({ routineSteps: [packStep()], activeSession: openSession, freedFrom: iso(-MIN) })
    );
    const recommendation = recommendationOf(response);
    expect(recommendation.primary?.action.id).toBe("write");
    expect(recommendation.protectedCommitment).toBeUndefined();
    expect(recommendation.openAnchor).toMatchObject({ id: "college-class" });
    expect(recommendation.headline).not.toMatch(/in progress|running late/i);
    // Its prep steps are not directed (the person is not preparing for what they have left).
    expect(response.currentDirective.kind).not.toBe("routine_step");
    expect(response.currentDirective.kind).not.toBe("none");
    expect(response.currentDirective).toMatchObject({ kind: "action", targetId: "write" });
  });

  it("works for a blocking and an anchor commitment alike, and leaves the plan's forecasts pessimistic", () => {
    const blocking = calculatePlanAndForecast(request({ freedFrom: iso(-MIN) }));
    const anchor = calculatePlanAndForecast(request({ freedFrom: iso(-MIN), presence: "anchor" }));
    expect(recommendationOf(blocking).primary?.action.id).toBe("write");
    expect(recommendationOf(anchor).primary?.action.id).toBe("write");
    const unfreed = calculatePlanAndForecast(request({}));
    expect(JSON.stringify(blocking.schedule)).toEqual(JSON.stringify(unfreed.schedule));
  });

  it("keeps the commitment on the day plan", () => {
    const response = calculatePlanAndForecast(request({ freedFrom: iso(-MIN) }));
    const blocks = response.dayPlan!.blocks;
    expect(blocks.some((block) => block.kind === "commitment" && block.targetId === "college-class")).toBe(true);
  });

  it("still protects the setup buffer, because freed_from only ever follows a start", () => {
    const response = calculatePlanAndForecast(
      request({ startsAtOffset: 10 * MIN, setupBeforeMinutes: 30, freedFrom: iso(-MIN) })
    );
    expect(recommendationOf(response).primary).toBeNull();
    expect(recommendationOf(response).protectedCommitment).toMatchObject({ id: "college-class" });
    expect(recommendationOf(response).protectedCommitment?.phase).not.toBe("active");
  });

  it("lapses at the effective end: the transition after it stays protected, then nothing is freed", () => {
    const inTransition = calculatePlanAndForecast(
      request({
        endsAtOffset: -5 * MIN,
        startsAtOffset: -2 * HOUR,
        transitionAfterMinutes: 30,
        freedFrom: iso(-MIN - HOUR)
      })
    );
    expect(recommendationOf(inTransition).primary).toBeNull();
    expect(recommendationOf(inTransition).protectedCommitment).toMatchObject({ id: "college-class" });
  });

  it("is released again by an open session's overtime only until the effective end", () => {
    // Scheduled end passed, the session keeps it running: the effective end is now, so it is still freed.
    const response = calculatePlanAndForecast(
      request({
        startsAtOffset: -2 * HOUR,
        endsAtOffset: -10 * MIN,
        freedFrom: iso(-30 * MIN),
        activeSession: { ...openSession, startedAt: iso(-2 * HOUR) }
      })
    );
    expect(recommendationOf(response).primary?.action.id).toBe("write");
  });
});

describe("a freed occurrence of a recurring commitment", () => {
  const rule = {
    id: "33333333-3333-4333-8333-333333333333",
    title: "Soccer",
    timezone: "Australia/Sydney",
    startDate: "2026-08-01",
    repeat: { unit: "days" as const, intervalDays: 1 },
    // `now` is 10:00 Sydney on 19 August.
    localStartTime: "09:00",
    localEndTime: "20:30",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0,
    presence: "blocking" as const,
    status: "active" as const
  };

  const requestWith = (rows: unknown[]) => {
    const base = request({});
    const state = {
      ...base.state,
      commitmentRecurrenceRules: [rule],
      commitments: [...base.state.commitments.filter((item) => item.id !== "college-class"), ...rows]
    };
    return planForecastRequestSchema.parse({ ...base, state });
  };

  it("carries freedFrom from a non-custom stored row, so the rule's own occurrence is released", () => {
    const first = calculatePlanAndForecast(requestWith([]));
    expect(recommendationOf(first).protectedCommitment).toMatchObject({ title: "Soccer", phase: "active" });
    const occurrence = first.derivedState.commitmentRepeats?.find(
      (item) =>
        (item as { title?: string }).title === "Soccer" && (item as { startsAt: string }).startsAt <= now.toISOString()
    ) as { id: string; startsAt: string; endsAt: string; localDate: string };
    expect(occurrence).toBeDefined();
    const second = calculatePlanAndForecast(
      requestWith([
        {
          id: occurrence.id,
          title: "Soccer",
          startsAt: occurrence.startsAt,
          endsAt: occurrence.endsAt,
          status: "confirmed",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          recurrenceRuleId: rule.id,
          localDate: occurrence.localDate,
          freedFrom: iso(-MIN)
        }
      ])
    );
    expect(recommendationOf(second).primary?.action.id).toBe("write");
    expect(recommendationOf(second).protectedCommitment).toBeUndefined();
    expect(recommendationOf(second).openAnchor).toMatchObject({ title: "Soccer" });
  });
});
