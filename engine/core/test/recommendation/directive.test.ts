import { describe, expect, it } from "vitest";
import { portalStateSchema } from "@openrhen/contracts";
import { ORDINARY_RANK, resolveProtectedCommitment, selectCurrentDirective } from "../../src/index.js";
import type {
  DirectiveTravel,
  FixedCommitment,
  PlanningResult,
  Recommendation,
  RecommendationCandidate,
  RoutineStepStatus,
  SleepPlan
} from "../../src/index.js";

/**
 * The sleep-directive floor: a wake-adjacent replan can truncate a
 * night to a sliver — observed live as "Time to sleep (5 min)" at 4:43 am and a zero-minute block 32
 * seconds wide — and nothing downstream refused it. A planned sleep block of zero minutes is never
 * directable; one under the floor that already fails its own minimum falls through to whatever comes
 * next instead of demanding a pointless rest.
 */

const MINUTE = 60_000;
const now = new Date("2026-08-27T18:43:00.000Z"); // 28 Aug 4:43am local

const emptyRecommendation: Recommendation = {
  primary: null,
  alternatives: [],
  candidates: [],
  needsAnswer: [],
  reachable: [],
  headline: "Nothing fits",
  explanation: "Nothing fits.",
  evidence: [],
  why: { because: null, whyNot: null, wouldChangeIf: [] },
  noFit: { kind: "none" }
};
const schedule: PlanningResult = {
  slots: [],
  allocations: [],
  capacityEnvelopes: [],
  projectEnvelopes: [],
  forecasts: [],
  dependencyOrder: [],
  dependencyErrors: []
};
const state = portalStateSchema.parse({
  settings: {
    timezone: "Australia/Sydney",
    planningHorizonEnd: "22:00",
    defaultUsableFraction: 1,
    defaultSetupBufferMinutes: 0,
    defaultTransitionBufferMinutes: 0,
    submissionBufferMinutes: 0,
    submissionBufferPercent: 0,
    energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
    estimateBucketsMinutes: [15, 30, 60],
    conditionCatalog: ["home"],
    preferredBedtime: "21:15",
    preferredWakeTime: "06:00",
    desiredSleepMinutes: 540,
    minimumSleepMinutes: 300,
    maxAwakeHours: 20
  },
  areas: [],
  outcomes: [],
  projects: [],
  actions: [],
  commitments: [],
  routineSteps: [],
  sleepPlans: [],
  captures: [],
  completedToday: [],
  assertedConditions: [],
  currentEnergy: "medium",
  horizonEnd: new Date(now.getTime() + 24 * 60 * MINUTE).toISOString(),
  activeSession: null
});

const sliver = (overrides: Partial<SleepPlan> = {}): SleepPlan => ({
  id: "sleep:2026-08-28",
  plannedStartAt: new Date(now.getTime() - 1 * MINUTE),
  plannedWakeAt: new Date(now.getTime() + 4 * MINUTE),
  desiredMinutes: 540,
  targetMinutes: 540,
  allowedMinutes: 5,
  sleepDeficitMinutes: 535,
  minimumShortfallMinutes: 295,
  anchorDeviationMinutes: 92,
  replannedFromMissedStart: true,
  hardErrors: ["Minimum sleep cannot be met for Eat Breakfast: 295 minutes short."],
  explanation: "test fixture",
  ...overrides
});

const directiveFor = (plan: SleepPlan) =>
  selectCurrentDirective({
    state,
    commitments: [],
    now,
    sleepPlans: [plan],
    recommendation: emptyRecommendation,
    schedule
  });

describe("the sleep-directive floor", () => {
  it("never directs a zero-minute sleep block", () => {
    const directive = directiveFor(
      sliver({ allowedMinutes: 0, plannedWakeAt: new Date(now.getTime() + 32_000), minimumShortfallMinutes: 300 })
    );
    expect(directive.kind).not.toBe("sleep");
  });
  it("refuses a sliver below the floor when the plan already fails its minimum", () => {
    expect(directiveFor(sliver()).kind).not.toBe("sleep");
    // The same refusal when only a hard error, not a shortfall, marks the plan as failing.
    expect(
      directiveFor(sliver({ minimumShortfallMinutes: 0, hardErrors: ["Sleep starts after the 20-hour awake limit."] }))
        .kind
    ).not.toBe("sleep");
  });
  it("still directs a short but healthy rest, and any block at or above the floor", () => {
    // A deliberate 20-minute rest with no shortfall and no hard error is a real thing to do.
    const rest = directiveFor(
      sliver({
        allowedMinutes: 20,
        plannedWakeAt: new Date(now.getTime() + 19 * MINUTE),
        minimumShortfallMinutes: 0,
        sleepDeficitMinutes: 0,
        hardErrors: []
      })
    );
    expect(rest).toMatchObject({ kind: "sleep", recommendedMinutes: 20 });
    // A truncated night at the floor is still directed even though it falls short of the minimum:
    // the floor only filters slivers, never a substantial (if constrained) night.
    const constrained = directiveFor(
      sliver({
        allowedMinutes: 240,
        plannedWakeAt: new Date(now.getTime() + 239 * MINUTE),
        minimumShortfallMinutes: 60
      })
    );
    expect(constrained).toMatchObject({ kind: "sleep", recommendedMinutes: 240 });
  });
  it("keeps an in-progress sleep authoritative whatever its stored numbers say", () => {
    const sleepingState = portalStateSchema.parse({
      ...state,
      sleepPlans: [
        {
          id: "sleep:2026-08-28",
          plannedStartAt: new Date(now.getTime() - 60 * MINUTE).toISOString(),
          plannedWakeAt: new Date(now.getTime() + 4 * MINUTE).toISOString(),
          desiredMinutes: 540,
          allowedMinutes: 0,
          sleepDeficitMinutes: 540,
          anchorDeviationMinutes: 0,
          hardErrors: [],
          explanation: "test fixture",
          status: "sleeping",
          actualStartAt: new Date(now.getTime() - 60 * MINUTE).toISOString()
        }
      ]
    });
    const directive = selectCurrentDirective({
      state: sleepingState,
      commitments: [],
      now,
      sleepPlans: [sliver({ allowedMinutes: 0 })],
      recommendation: emptyRecommendation,
      schedule
    });
    expect(directive.kind).toBe("sleep");
  });
});

/**
 * Finding 18: `selectCurrentDirective` used to build its per-step commitment lookups
 * (`commitmentEndsAtById`, `commitmentLocationById`, `commitmentStartsAtById`) straight from
 * `state.commitments`, which carries only literal commitments — a recurring commitment's materialized
 * occurrence never appears there. A routine step whose `commitmentId` names such an occurrence then
 * found nothing in any of the three maps. These tests build exactly that shape (a step naming a
 * commitment id absent from `state.commitments`) and show the `commitments` parameter — supplying the
 * occurrence, the way `protectedCommitments()` now does — changes the actual directive returned, not
 * merely the size of a list.
 */
describe("selectCurrentDirective reads the materialized commitments parameter, not state.commitments", () => {
  const occurrenceId = "commitment-occurrence:2026-08-28";
  const baseState = (routineSteps: Record<string, unknown>[]) =>
    portalStateSchema.parse({
      settings: {
        timezone: "Australia/Sydney",
        planningHorizonEnd: "22:00",
        defaultUsableFraction: 1,
        defaultSetupBufferMinutes: 0,
        defaultTransitionBufferMinutes: 0,
        submissionBufferMinutes: 0,
        submissionBufferPercent: 0,
        energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
        estimateBucketsMinutes: [15, 30, 60],
        conditionCatalog: ["home"],
        preferredBedtime: "21:15",
        preferredWakeTime: "06:00",
        desiredSleepMinutes: 540,
        minimumSleepMinutes: 300,
        maxAwakeHours: 20
      },
      areas: [],
      outcomes: [],
      projects: [],
      actions: [],
      // The literal commitments list never carries the recurring occurrence — only `commitments`
      // (the accessor parameter) does, exactly as `protectedCommitments()` would supply it.
      commitments: [],
      routineSteps,
      sleepPlans: [],
      captures: [],
      completedToday: [],
      assertedConditions: [],
      currentEnergy: "medium",
      horizonEnd: new Date(now.getTime() + 24 * 60 * MINUTE).toISOString(),
      activeSession: null
    });

  it("extends a step's directability past its own window while its recurring commitment is still running", () => {
    // The step's own scheduled window already closed 40 minutes ago; only the fact that its
    // commitment (the recurring occurrence) is still running for another hour keeps it directable.
    const state = baseState([
      {
        id: "step-1",
        commitmentId: occurrenceId,
        title: "Pack bag",
        durationMinutes: 5,
        sequence: 0,
        timingRule: "contiguous",
        energy: "low",
        contexts: [],
        dependencyIds: [],
        phase: "before",
        status: "pending",
        scheduledStartAt: new Date(now.getTime() - 50 * MINUTE).toISOString(),
        scheduledEndAt: new Date(now.getTime() - 40 * MINUTE).toISOString()
      }
    ]);
    const occurrence = {
      id: occurrenceId,
      title: "Recurring class",
      status: "confirmed" as const,
      startsAt: new Date(now.getTime() - 60 * MINUTE),
      endsAt: new Date(now.getTime() + 60 * MINUTE)
    };
    // Without the occurrence (reproducing the pre-fix lookup against state.commitments alone): the
    // commitment's end is unknown, so "commitment still running" can never be true, and the step's own
    // elapsed window makes it undirectable — the directive falls through to nothing at all.
    const withoutOccurrence = selectCurrentDirective({
      state,
      commitments: [],
      now,
      sleepPlans: [],
      recommendation: emptyRecommendation,
      schedule
    });
    expect(withoutOccurrence.kind).toBe("none");
    // With the occurrence supplied, the still-running commitment extends the step's directability and
    // it becomes the current directive — the behaviour the recurring commitment is actually entitled to.
    const withOccurrence = selectCurrentDirective({
      state,
      commitments: [occurrence],
      now,
      sleepPlans: [],
      recommendation: emptyRecommendation,
      schedule
    });
    expect(withOccurrence).toMatchObject({ kind: "routine_step", targetId: "step-1" });
  });

  it("retires a before-phase step early on arrival at a recurring commitment's location", () => {
    // The step's own window is still open, so absent the arrival check it would be directed either way.
    const state = baseState([
      {
        id: "step-2",
        commitmentId: occurrenceId,
        title: "Pack bag",
        durationMinutes: 5,
        sequence: 0,
        timingRule: "contiguous",
        energy: "low",
        contexts: [],
        dependencyIds: [],
        phase: "before",
        status: "pending",
        scheduledStartAt: new Date(now.getTime() - 5 * MINUTE).toISOString(),
        scheduledEndAt: new Date(now.getTime() + 5 * MINUTE).toISOString()
      }
    ]);
    const occurrence = {
      id: occurrenceId,
      title: "Recurring class",
      status: "confirmed" as const,
      locationId: "campus",
      startsAt: new Date(now.getTime() - 10 * MINUTE),
      endsAt: new Date(now.getTime() + 50 * MINUTE)
    };
    const travel = {
      currentLocationId: "campus",
      travelBetween: () => undefined,
      locationName: (id: string) => id
    };
    // Without the occurrence: the commitment's location and end are both unknown, so arrival can never
    // be recognised as "already there" and the (otherwise moot) step is still directed.
    const withoutOccurrence = selectCurrentDirective({
      state,
      commitments: [],
      now,
      sleepPlans: [],
      recommendation: emptyRecommendation,
      schedule,
      travel
    });
    expect(withoutOccurrence).toMatchObject({ kind: "routine_step", targetId: "step-2" });
    // With the occurrence: arrival at the commitment's own location retires the step early, and the
    // directive falls through past it (to "none", since nothing else is on offer in this fixture).
    const withOccurrence = selectCurrentDirective({
      state,
      commitments: [occurrence],
      now,
      sleepPlans: [],
      recommendation: emptyRecommendation,
      schedule,
      travel
    });
    expect(withOccurrence.kind).toBe("none");
  });
});

/**
 * A shift tracked 38 minutes past its scheduled end left an after-phase routine
 * step's own window closed (still computed against the stale scheduled `endsAt`) and the commitment
 * itself reading as long finished, so `directableStep`'s "commitment still running" fallback — keyed
 * by `commitmentEndsAtById` — could never rescue it either. `trackedEndedAt` on the `FixedCommitment`
 * (populated from a finished session, or the live instant of one still open) is read through
 * `effectiveCommitmentEnd` there now; these tests isolate exactly that map, independent of whatever
 * window the platform layer itself recomputed for the step (covered separately in
 * `platform/database/src/planning/routine-inheritance.test.ts`).
 */
describe("directableStep's commitment-still-running fallback follows tracked overtime, not the stale scheduled endsAt", () => {
  const baseState = (routineSteps: Record<string, unknown>[]) =>
    portalStateSchema.parse({
      settings: {
        timezone: "Australia/Sydney",
        planningHorizonEnd: "22:00",
        defaultUsableFraction: 1,
        defaultSetupBufferMinutes: 0,
        defaultTransitionBufferMinutes: 0,
        submissionBufferMinutes: 0,
        submissionBufferPercent: 0,
        energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
        estimateBucketsMinutes: [15, 30, 60],
        conditionCatalog: ["home"],
        preferredBedtime: "21:15",
        preferredWakeTime: "06:00",
        desiredSleepMinutes: 540,
        minimumSleepMinutes: 300,
        maxAwakeHours: 20
      },
      areas: [],
      outcomes: [],
      projects: [],
      actions: [],
      commitments: [],
      routineSteps,
      sleepPlans: [],
      captures: [],
      completedToday: [],
      assertedConditions: [],
      currentEnergy: "medium",
      horizonEnd: new Date(now.getTime() + 24 * 60 * MINUTE).toISOString(),
      activeSession: null
    });
  const afterStep = {
    id: "eat-a-meal",
    commitmentId: "work",
    title: "Eat an extra meal",
    durationMinutes: 15,
    sequence: 0,
    timingRule: "contiguous",
    energy: "low",
    contexts: [],
    dependencyIds: [],
    phase: "after",
    status: "pending",
    // The step's own window closed 5 minutes ago — anchored, as it would be before the platform-side
    // fix, against the commitment's scheduled endsAt rather than when the person actually finished.
    scheduledStartAt: new Date(now.getTime() - 20 * MINUTE).toISOString(),
    scheduledEndAt: new Date(now.getTime() - 5 * MINUTE).toISOString()
  };
  const state = baseState([afterStep]);
  const commitment = (overrides: Partial<FixedCommitment> = {}): FixedCommitment => ({
    id: "work",
    title: "Work",
    status: "confirmed",
    // Scheduled to have ended 40 minutes ago.
    startsAt: new Date(now.getTime() - 4 * 60 * MINUTE),
    endsAt: new Date(now.getTime() - 40 * MINUTE),
    ...overrides
  });

  it("stays undirectable with no tracked end at all — both the step's own window and the commitment have closed", () => {
    const directive = selectCurrentDirective({
      state,
      commitments: [commitment()],
      now,
      sleepPlans: [],
      recommendation: emptyRecommendation,
      schedule
    });
    expect(directive.kind).toBe("none");
  });

  it("stays undirectable when the tracked end is at or before the scheduled endsAt (finished on time)", () => {
    const onTime = commitment({ trackedEndedAt: new Date(now.getTime() - 40 * MINUTE) });
    const directive = selectCurrentDirective({
      state,
      commitments: [onTime],
      now,
      sleepPlans: [],
      recommendation: emptyRecommendation,
      schedule
    });
    expect(directive.kind).toBe("none");
  });

  it("becomes directable once tracked overtime keeps the commitment 'still running' past the step's own closed window", () => {
    // Still running for another 10 minutes from "now" — mirrors `engine.ts` resolving `trackedEndedAt`
    // to the live instant while a session against this commitment is still open past its scheduled end.
    const overtime = commitment({ trackedEndedAt: new Date(now.getTime() + 10 * MINUTE) });
    const directive = selectCurrentDirective({
      state,
      commitments: [overtime],
      now,
      sleepPlans: [],
      recommendation: emptyRecommendation,
      schedule
    });
    expect(directive).toMatchObject({ kind: "routine_step", targetId: "eat-a-meal" });
  });
});

/**
 * a late commitment must not be weaker than an on-time one. `resolveProtectedCommitment`
 * builds a real `ProtectedCommitment` with `late: true` here (rather than a hand-built literal) so
 * each case exercises the same object `recommend()` actually produces. One test per row of the
 * issue's agreed four-point fix.
 */
describe("late precedence: a late commitment beats sleep, the journey home and recovery", () => {
  const ARRIVAL_MARGIN = 10;
  const settings = {
    timezone: "Australia/Sydney",
    planningHorizonEnd: "22:00",
    defaultUsableFraction: 1,
    defaultSetupBufferMinutes: 0,
    defaultTransitionBufferMinutes: 0,
    submissionBufferMinutes: 0,
    submissionBufferPercent: 0,
    energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
    estimateBucketsMinutes: [15, 30, 60],
    conditionCatalog: ["home"],
    preferredBedtime: "21:15",
    preferredWakeTime: "06:00",
    desiredSleepMinutes: 540,
    minimumSleepMinutes: 300,
    maxAwakeHours: 20
  };
  const lateState = (overrides: { routineSteps?: Record<string, unknown>[]; sleepPlans?: Record<string, unknown>[] }) =>
    portalStateSchema.parse({
      settings,
      areas: [],
      outcomes: [],
      projects: [],
      actions: [],
      commitments: [],
      routineSteps: overrides.routineSteps ?? [],
      sleepPlans: overrides.sleepPlans ?? [],
      captures: [],
      completedToday: [],
      assertedConditions: [],
      currentEnergy: "medium",
      horizonEnd: new Date(now.getTime() + 24 * 60 * MINUTE).toISOString(),
      activeSession: null
    });
  // Place-less (no `locationId`): late is driven by its own before-phase steps alone, and
  // `plannedLeg` never routes a travel/return leg for it, isolating the branch under test.
  const workCommitment = (overridesToCommitment: Partial<FixedCommitment> = {}): FixedCommitment => ({
    id: "work",
    title: "Work",
    status: "confirmed",
    startsAt: new Date(now.getTime() - 30 * MINUTE),
    endsAt: new Date(now.getTime() + 30 * MINUTE),
    ...overridesToCommitment
  });
  // A pending, unfinished before-phase step (issue-independent of the wire routine steps below) is
  // enough to keep `isRunningLate`/`resolveProtectedCommitment` reporting `late: true` for the whole
  // window, whatever `state.routineSteps` itself does or doesn't contain.
  const incompleteBeforeStep: RoutineStepStatus[] = [{ commitmentId: "work", phase: "before", status: "pending" }];
  const lateRecommendation = (
    commitment: FixedCommitment,
    routineSteps: RoutineStepStatus[] = incompleteBeforeStep
  ) => {
    const protectedCommitment = resolveProtectedCommitment(now, [commitment], ARRIVAL_MARGIN, routineSteps, null)!;
    expect(protectedCommitment.late).toBe(true);
    return {
      ...emptyRecommendation,
      headline: `Running late for ${commitment.title}`,
      protectedCommitment
    } as Recommendation;
  };
  const beforeStep = (overridesToStep: Record<string, unknown>) => ({
    id: "pack",
    commitmentId: "work",
    title: "Pack Bag",
    durationMinutes: 10,
    sequence: 0,
    timingRule: "flexible" as const,
    energy: "medium" as const,
    contexts: [],
    dependencyIds: [],
    phase: "before" as const,
    status: "pending" as const,
    ...overridesToStep
  });

  it("open sleep window: 'Running late for X', not 'Time to sleep'", () => {
    const commitment = workCommitment();
    const recommendation = lateRecommendation(commitment);
    const state = lateState({});
    const directive = selectCurrentDirective({
      state,
      commitments: [commitment],
      now,
      sleepPlans: [
        {
          id: "sleep:tonight",
          plannedStartAt: new Date(now.getTime() - 10 * MINUTE),
          plannedWakeAt: new Date(now.getTime() + 6 * 60 * MINUTE),
          desiredMinutes: 540,
          targetMinutes: 540,
          allowedMinutes: 540,
          sleepDeficitMinutes: 0,
          minimumShortfallMinutes: 0,
          anchorDeviationMinutes: 0,
          hardErrors: [],
          explanation: "test fixture"
        }
      ],
      recommendation,
      schedule
    });
    expect(directive).toEqual({ kind: "none", title: "Running late for Work", recommendedMinutes: 0 });
  });

  it("stored 'sleeping' status: 'Running late for X', not sleep (lateness beats a stored sleeping status)", () => {
    const commitment = workCommitment();
    const recommendation = lateRecommendation(commitment);
    const state = lateState({
      sleepPlans: [
        {
          id: "sleep:tonight",
          plannedStartAt: new Date(now.getTime() - 60 * MINUTE).toISOString(),
          plannedWakeAt: new Date(now.getTime() + 60 * MINUTE).toISOString(),
          desiredMinutes: 540,
          allowedMinutes: 0,
          sleepDeficitMinutes: 540,
          anchorDeviationMinutes: 0,
          hardErrors: [],
          explanation: "test fixture",
          status: "sleeping",
          actualStartAt: new Date(now.getTime() - 60 * MINUTE).toISOString()
        }
      ]
    });
    const directive = selectCurrentDirective({
      state,
      commitments: [commitment],
      now,
      sleepPlans: [
        {
          id: "sleep:tonight",
          plannedStartAt: new Date(now.getTime() - 60 * MINUTE),
          plannedWakeAt: new Date(now.getTime() + 60 * MINUTE),
          desiredMinutes: 540,
          targetMinutes: 540,
          allowedMinutes: 0,
          sleepDeficitMinutes: 540,
          minimumShortfallMinutes: 0,
          anchorDeviationMinutes: 0,
          hardErrors: [],
          explanation: "test fixture"
        }
      ],
      recommendation,
      schedule
    });
    expect(directive).toEqual({ kind: "none", title: "Running late for Work", recommendedMinutes: 0 });
  });

  it("away from home with bedtime a journey away: 'Running late for X', not a journey home", () => {
    const commitment = workCommitment();
    const recommendation = lateRecommendation(commitment);
    const state = lateState({});
    const travel: DirectiveTravel = {
      currentLocationId: "away",
      homeLocationId: "home",
      travelBetween: () => ({
        fromLocationId: "away",
        toLocationId: "home",
        minutes: 10,
        typicalMinutes: 10,
        sampleCount: 0,
        mode: "car",
        source: "fallback"
      }),
      locationName: (id: string) => id
    };
    const directive = selectCurrentDirective({
      state,
      commitments: [commitment],
      now,
      sleepPlans: [
        {
          id: "sleep:tonight",
          plannedStartAt: new Date(now.getTime() + 5 * MINUTE),
          plannedWakeAt: new Date(now.getTime() + 6 * 60 * MINUTE),
          desiredMinutes: 540,
          targetMinutes: 540,
          allowedMinutes: 540,
          sleepDeficitMinutes: 0,
          minimumShortfallMinutes: 0,
          anchorDeviationMinutes: 0,
          hardErrors: [],
          explanation: "test fixture"
        }
      ],
      recommendation,
      schedule,
      travel
    });
    expect(directive).toEqual({ kind: "none", title: "Running late for Work", recommendedMinutes: 0 });
  });

  it("a due bedtime step or another commitment's step does not out-rank X's own headline", () => {
    const commitment = workCommitment();
    const recommendation = lateRecommendation(commitment);
    const state = lateState({
      routineSteps: [
        // Another commitment's own due before-phase step.
        {
          id: "other-step",
          commitmentId: "other-commitment",
          title: "Someone else's step",
          durationMinutes: 5,
          sequence: 0,
          timingRule: "contiguous",
          energy: "low",
          contexts: [],
          dependencyIds: [],
          phase: "before",
          status: "pending",
          scheduledStartAt: new Date(now.getTime() - 5 * MINUTE).toISOString(),
          scheduledEndAt: new Date(now.getTime() + 5 * MINUTE).toISOString()
        },
        // A bedtime step (sleep-anchored, no commitmentId), also due.
        {
          id: "bedtime-step",
          anchorType: "sleep_plan",
          anchorId: "sleep:tonight",
          purpose: "bedtime",
          title: "Wind down",
          durationMinutes: 5,
          sequence: 0,
          timingRule: "contiguous",
          energy: "low",
          contexts: [],
          dependencyIds: [],
          phase: "before",
          status: "pending",
          scheduledStartAt: new Date(now.getTime() - 5 * MINUTE).toISOString(),
          scheduledEndAt: new Date(now.getTime() + 5 * MINUTE).toISOString()
        }
      ]
    });
    const directive = selectCurrentDirective({
      state,
      commitments: [commitment],
      now,
      sleepPlans: [],
      recommendation,
      schedule
    });
    expect(directive).toEqual({ kind: "none", title: "Running late for Work", recommendedMinutes: 0 });
  });

  it("X's own pending before-step is directed (the regression)", () => {
    const commitment = workCommitment();
    const recommendation = lateRecommendation(commitment);
    const state = lateState({
      routineSteps: [
        beforeStep({
          scheduledStartAt: new Date(now.getTime() - 5 * MINUTE).toISOString(),
          scheduledEndAt: new Date(now.getTime() + 5 * MINUTE).toISOString()
        })
      ]
    });
    const directive = selectCurrentDirective({
      state,
      commitments: [commitment],
      now,
      sleepPlans: [],
      recommendation,
      schedule
    });
    expect(directive).toMatchObject({ kind: "routine_step", targetId: "pack" });
  });

  it("X's own step gated by an overdue prerequisite directs the prerequisite instead", () => {
    const commitment = workCommitment();
    const recommendation = lateRecommendation(commitment);
    const state = lateState({
      routineSteps: [
        // "pack" is X's prerequisite: its own window already elapsed and it is not passed as a
        // commitment here, so `directableStep`'s "commitment still running" fallback cannot rescue it
        // either — it drops out of the in-window filter entirely.
        beforeStep({
          scheduledStartAt: new Date(now.getTime() - 20 * MINUTE).toISOString(),
          scheduledEndAt: new Date(now.getTime() - 10 * MINUTE).toISOString()
        }),
        {
          id: "shower",
          commitmentId: "work",
          title: "Shower",
          durationMinutes: 10,
          sequence: 1,
          timingRule: "flexible",
          energy: "medium",
          contexts: [],
          dependencyIds: ["pack"],
          phase: "before",
          status: "pending",
          scheduledStartAt: new Date(now.getTime() - 5 * MINUTE).toISOString(),
          scheduledEndAt: new Date(now.getTime() + 5 * MINUTE).toISOString()
        }
      ]
    });
    // No commitments passed here (deliberately, per the comment above), so `directableStep`'s
    // fallback bound cannot make the elapsed-window prerequisite directable on its own; only the
    // walk-back from the in-window dependent surfaces it.
    const directive = selectCurrentDirective({ state, commitments: [], now, sleepPlans: [], recommendation, schedule });
    expect(directive).toMatchObject({ kind: "routine_step", targetId: "pack" });
  });

  it("does not direct a dependent step while its completed prerequisite's own wait is still running", () => {
    const commitment = workCommitment();
    const recommendation = lateRecommendation(commitment);
    const state = lateState({
      routineSteps: [
        beforeStep({
          id: "wash",
          title: "Wash",
          status: "completed",
          waitAfterMinutes: 90,
          // Completed a minute ago: the 90-minute wait has 89 minutes left to run.
          completedAt: new Date(now.getTime() - 1 * MINUTE).toISOString()
        }),
        {
          id: "dry",
          commitmentId: "work",
          title: "Hang out to dry",
          durationMinutes: 5,
          sequence: 1,
          timingRule: "flexible",
          energy: "medium",
          contexts: [],
          dependencyIds: ["wash"],
          phase: "before",
          status: "pending",
          // "dry"'s own window is open — nothing but the running wait keeps it from being directed.
          scheduledStartAt: new Date(now.getTime() - 5 * MINUTE).toISOString(),
          scheduledEndAt: new Date(now.getTime() + 5 * MINUTE).toISOString()
        }
      ]
    });
    const directive = selectCurrentDirective({
      state,
      commitments: [commitment],
      now,
      sleepPlans: [],
      recommendation,
      schedule
    });
    // "dry" is not directable, and nothing else of X's own is due either, so the headline itself
    // is what's returned — not "dry", and not a routine_step at all.
    expect(directive).toEqual({ kind: "none", title: "Running late for Work", recommendedMinutes: 0 });
  });

  it("walking back past a completed prerequisite with a running wait still surfaces the pending step immediately behind it", () => {
    const commitment = workCommitment();
    const recommendation = lateRecommendation(commitment);
    const state = lateState({
      routineSteps: [
        beforeStep({
          id: "wash",
          title: "Wash",
          status: "completed",
          waitAfterMinutes: 90,
          completedAt: new Date(now.getTime() - 1 * MINUTE).toISOString()
        }),
        {
          // "dry"'s own window has already elapsed, so it never appears in the in-window filter
          // itself — only walking back from "fold" (below) can surface it.
          id: "dry",
          commitmentId: "work",
          title: "Hang out to dry",
          durationMinutes: 5,
          sequence: 1,
          timingRule: "flexible",
          energy: "medium",
          contexts: [],
          dependencyIds: ["wash"],
          phase: "before",
          status: "pending",
          scheduledStartAt: new Date(now.getTime() - 20 * MINUTE).toISOString(),
          scheduledEndAt: new Date(now.getTime() - 10 * MINUTE).toISOString()
        },
        {
          id: "fold",
          commitmentId: "work",
          title: "Fold washing",
          durationMinutes: 5,
          sequence: 2,
          timingRule: "flexible",
          energy: "medium",
          contexts: [],
          dependencyIds: ["dry"],
          phase: "before",
          status: "pending",
          scheduledStartAt: new Date(now.getTime() - 5 * MINUTE).toISOString(),
          scheduledEndAt: new Date(now.getTime() + 5 * MINUTE).toISOString()
        }
      ]
    });
    // No commitments passed (as the elapsed-window test above), so only the walk-back can surface
    // "dry" at all. It does, unaffected by "wash"'s own still-running wait: a completed prerequisite
    // is satisfied for walking back regardless of its wait, and the walk stops there rather than
    // continuing past it.
    const directive = selectCurrentDirective({ state, commitments: [], now, sleepPlans: [], recommendation, schedule });
    expect(directive).toMatchObject({ kind: "routine_step", targetId: "dry" });
  });

  it("recovery-capacity window before X's start does not out-rank X's own headline", () => {
    const commitment = workCommitment();
    const recommendation = lateRecommendation(commitment);
    const state = lateState({});
    const recoverySchedule: PlanningResult = {
      ...schedule,
      slots: [
        {
          startsAt: new Date(now.getTime() - 30 * MINUTE),
          endsAt: new Date(now.getTime() + 30 * MINUTE),
          availability: "protected",
          energy: "recovery"
        }
      ]
    } as PlanningResult;
    // Sanity: recovery would otherwise be offered here (an on-time protected commitment falls to
    // "none" before reaching it, but there is none in this fixture).
    expect(
      selectCurrentDirective({
        state: { ...state, commitments: [] },
        commitments: [],
        now,
        sleepPlans: [],
        recommendation: emptyRecommendation,
        schedule: recoverySchedule
      }).kind
    ).toBe("recovery");
    const directive = selectCurrentDirective({
      state,
      commitments: [commitment],
      now,
      sleepPlans: [],
      recommendation,
      schedule: recoverySchedule
    });
    expect(directive).toEqual({ kind: "none", title: "Running late for Work", recommendedMinutes: 0 });
  });

  it("a located commitment whose steps are done but arrival is unasserted still directs the travel leg (unchanged)", () => {
    const commitment = workCommitment({
      id: "college-class",
      title: "College Class",
      locationId: "college",
      travelBeforeMinutes: 8,
      travelBefore: {
        fromLocationId: "home",
        toLocationId: "college",
        minutes: 8,
        typicalMinutes: 8,
        sampleCount: 0,
        mode: "car",
        source: "fallback"
      }
    });
    const protectedCommitment = resolveProtectedCommitment(now, [commitment], ARRIVAL_MARGIN, [], null)!;
    expect(protectedCommitment).toMatchObject({ phase: "travel", late: true });
    const recommendation: Recommendation = {
      ...emptyRecommendation,
      headline: "Running late for College Class",
      protectedCommitment
    };
    const state = lateState({});
    const travel: DirectiveTravel = {
      currentLocationId: "home",
      homeLocationId: "home",
      travelBetween: () => ({
        fromLocationId: "home",
        toLocationId: "college",
        minutes: 8,
        typicalMinutes: 8,
        sampleCount: 0,
        mode: "car",
        source: "fallback"
      }),
      locationName: (id: string) => id
    };
    const directive = selectCurrentDirective({
      state,
      commitments: [commitment],
      now,
      sleepPlans: [],
      recommendation,
      schedule,
      travel
    });
    expect(directive).toMatchObject({ kind: "travel", toLocationId: "college" });
  });
});

/**
 * The routine step timing design note, "Flexible steps offered early": `recommendation.earlyStep`
 * (built by `recommend()`) is directed as a `routine_step` in `primary`'s own place, at the point
 * `primary` would otherwise be directed.
 */
describe("flexible steps offered early", () => {
  const ordinaryCandidate = (overrides: Partial<RecommendationCandidate> = {}): RecommendationCandidate => ({
    action: {
      id: "action-1",
      projectId: "project-1",
      title: "Ordinary action",
      status: "planned",
      expectedMinutes: 30,
      remainingMinutes: 30,
      pessimisticMinutes: 30,
      energy: "medium",
      minimumSessionMinutes: 10,
      maximumSessionMinutes: 30,
      importance: 3,
      consequence: 3,
      contexts: [],
      dependenciesComplete: true
    },
    eligible: true,
    exclusionReasons: [],
    windowBound: false,
    recommendedMinutes: 30,
    recommendedWallClockMinutes: 30,
    usableFraction: 1,
    sessionBoundary: new Date(now.getTime() + 60 * MINUTE),
    totalScore: 30,
    scoreComponents: {},
    criticalRank: ORDINARY_RANK,
    criticalTier: "ordinary",
    conditionMatch: { status: "yes", missing: [], unknowns: [], unmetPreferences: [] },
    ...overrides
  });
  const earlyStepRow = (overrides: Record<string, unknown> = {}) => ({
    id: "early-step",
    commitmentId: "work",
    title: "Wash",
    durationMinutes: 5,
    sequence: 0,
    timingRule: "flexible" as const,
    energy: "low" as const,
    contexts: [],
    dependencyIds: [],
    phase: "before" as const,
    status: "pending" as const,
    ...overrides
  });
  const stateWithStep = (row: Record<string, unknown>) => portalStateSchema.parse({ ...state, routineSteps: [row] });
  const directiveFor = (recommendation: Recommendation) =>
    selectCurrentDirective({
      state: stateWithStep(earlyStepRow()),
      commitments: [],
      now,
      sleepPlans: [],
      recommendation,
      schedule
    });

  it("directs it as a routine_step when there is no primary", () => {
    const directive = directiveFor({ ...emptyRecommendation, earlyStep: { stepId: "early-step", totalScore: 40 } });
    expect(directive).toMatchObject({
      kind: "routine_step",
      targetId: "early-step",
      title: "Wash",
      recommendedMinutes: 5
    });
  });

  it("directs it over an ordinary-tier primary it outscores", () => {
    const directive = directiveFor({
      ...emptyRecommendation,
      primary: ordinaryCandidate({ totalScore: 30 }),
      earlyStep: { stepId: "early-step", totalScore: 40 }
    });
    expect(directive).toMatchObject({ kind: "routine_step", targetId: "early-step" });
  });

  it("loses to an ordinary-tier primary it does not outscore", () => {
    const directive = directiveFor({
      ...emptyRecommendation,
      primary: ordinaryCandidate({ totalScore: 40 }),
      earlyStep: { stepId: "early-step", totalScore: 30 }
    });
    expect(directive.kind).not.toBe("routine_step");
    expect(directive).toMatchObject({ kind: "action", targetId: "action-1" });
  });

  it("never beats deadline-critical work, whatever the score", () => {
    const directive = directiveFor({
      ...emptyRecommendation,
      primary: ordinaryCandidate({ totalScore: 1, criticalRank: 0, criticalTier: "overdue_external" }),
      earlyStep: { stepId: "early-step", totalScore: 1000 }
    });
    expect(directive.kind).not.toBe("routine_step");
  });

  it("is never offered while a protected commitment is in force", () => {
    const commitment: FixedCommitment = {
      id: "protecting",
      title: "Protecting commitment",
      startsAt: new Date(now.getTime() - 10 * MINUTE),
      endsAt: new Date(now.getTime() + 10 * MINUTE)
    };
    const protectedCommitment = resolveProtectedCommitment(now, [commitment], 0, [], null)!;
    expect(protectedCommitment.phase).toBe("active");
    const directive = directiveFor({
      ...emptyRecommendation,
      protectedCommitment,
      earlyStep: { stepId: "early-step", totalScore: 1000 }
    });
    expect(directive.kind).not.toBe("routine_step");
  });
});
