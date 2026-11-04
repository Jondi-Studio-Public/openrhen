import { describe, expect, it } from "vitest";
import { computeStayUpOffer } from "../../src/recurrence/stay-up-offer.js";
import type { Action, CapacityWindow, FixedCommitment, ProjectForecast, SleepPlan } from "../../src/index.js";

/**
 * The sleep placement design note "The stay-up offer": all five conditions must hold, and the
 * offer's five choices (30/60/90) are filtered by minimum sleep, the awake limit, minimum session
 * and evening admissibility. `computeStayUpOffer` is tested directly here, against `sleep.test.ts`'s
 * pattern of exercising `planSleep` directly rather than through the whole engine.
 */

const now = new Date("2026-01-01T00:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
const BEDTIME_ROUTINE_MINUTES = 15;

// Night 0: bedtime at +30 minutes, wake 480 minutes (8h) later. `routineStart` is `plannedStartAt`
// minus the routine (00:15), so the offer's window opens at 00:00 (routineStart - 15min) and closes
// at plannedStart (00:30) — `now` sits exactly at the open edge by default.
function night(overrides: Partial<SleepPlan> = {}): SleepPlan {
  return {
    id: "night-1",
    plannedStartAt: at(30),
    plannedWakeAt: at(30 + 480),
    desiredMinutes: 480,
    allowedMinutes: 480,
    sleepDeficitMinutes: 0,
    anchorDeviationMinutes: 0,
    hardErrors: [],
    explanation: "",
    ...overrides
  };
}

function forecast(overrides: Partial<ProjectForecast> = {}): ProjectForecast {
  return {
    projectId: "p1",
    health: "behind",
    overdue: false,
    protectedRemainingMinutes: null,
    pessimisticRemainingMinutes: null,
    compatibleCapacityMinutes: null,
    grossCompatibleCapacityMinutes: null,
    reservedByEarlierDeadlinesMinutes: 0,
    requiredPaceMinutesPerWeek: null,
    forecastBand: null,
    confidence: null,
    forecastThrough: at(7 * 24 * 60),
    expectedMarginMinutes: -30,
    pessimisticMarginMinutes: null,
    marginRatio: null,
    scheduleVariance: null,
    unallocatedExpectedMinutes: 0,
    blockedEffortMinutes: 0,
    schedulingBlocked: false,
    latestSafeStarts: { a1: at(-60) },
    reasons: [],
    ...overrides
  };
}

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: "a1",
    projectId: "p1",
    title: "Draft section 3",
    status: "active",
    optimisticMinutes: 60,
    expectedMinutes: 60,
    remainingMinutes: 60,
    pessimisticMinutes: 60,
    energy: "high",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 120,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependenciesComplete: true,
    ...overrides
  };
}

function window(
  id: string,
  startMinutes: number,
  endMinutes: number,
  energy: CapacityWindow["energy"] = "high"
): CapacityWindow {
  return { id, startsAt: at(startMinutes), endsAt: at(endMinutes), energy, contexts: [], usableFraction: 1 };
}

/** Every base call the offer's five conditions and its choice filters need, unless a test overrides one. */
function baseArgs(overrides: Partial<Parameters<typeof computeStayUpOffer>[0]> = {}) {
  return {
    now,
    night: night(),
    bedtimeRoutineMinutes: BEDTIME_ROUTINE_MINUTES,
    forecasts: [forecast()],
    projectTitles: new Map([["p1", "Report"]]),
    actions: [action()],
    capacityWindows: [window("w", 0, 180)],
    commitments: [] as FixedCommitment[],
    minimumSleepMinutes: 420,
    maxAwakeHours: 20,
    previousWakeAt: at(-10 * 60),
    arrivalMarginMinutes: 2,
    ...overrides
  };
}

describe("computeStayUpOffer", () => {
  it("offers 30 and 60 (90 falls below the minimum) when every condition holds", () => {
    const offer = computeStayUpOffer(baseArgs());
    expect(offer).toBeDefined();
    expect(offer?.nightId).toBe("night-1");
    expect(offer?.projectId).toBe("p1");
    expect(offer?.actionId).toBe("a1");
    expect(offer?.choices.map((choice) => choice.minutes)).toEqual([30, 60]);
  });

  // Condition 1: tonight's night must be planned (not overridden/missed) and unanswered.
  it("condition 1: no offer with no night at all", () => {
    expect(computeStayUpOffer(baseArgs({ night: undefined }))).toBeUndefined();
  });

  it("condition 1: no offer for a missed-start night", () => {
    expect(computeStayUpOffer(baseArgs({ night: night({ replannedFromMissedStart: true }) }))).toBeUndefined();
  });

  it("condition 1: no offer once the night has already been answered", () => {
    expect(computeStayUpOffer(baseArgs({ night: night({ stayUpAnswerMinutes: 0 }) }))).toBeUndefined();
    expect(computeStayUpOffer(baseArgs({ night: night({ stayUpAnswerMinutes: 30 }) }))).toBeUndefined();
  });

  // Condition 2: `now` must fall in [routineStart - 15min, plannedStart).
  it("condition 2: no offer before the window opens", () => {
    expect(computeStayUpOffer(baseArgs({ now: at(-1) }))).toBeUndefined();
  });

  it("condition 2: no offer once bedtime itself has arrived", () => {
    expect(computeStayUpOffer(baseArgs({ now: at(30) }))).toBeUndefined();
  });

  // Condition 3: some deadline-based (feasibility) project must be behind.
  it("condition 3: no offer when no project is behind", () => {
    expect(computeStayUpOffer(baseArgs({ forecasts: [forecast({ health: "on_track" })] }))).toBeUndefined();
  });

  it("condition 3: no offer when the only behind project is adherence-based, not deadline-based", () => {
    expect(computeStayUpOffer(baseArgs({ forecasts: [forecast({ healthBasis: "adherence" })] }))).toBeUndefined();
  });

  // Condition 4: that project's top work must be ready.
  it("condition 4: no offer when the behind project's only action is blocked", () => {
    expect(computeStayUpOffer(baseArgs({ actions: [action({ status: "blocked" })] }))).toBeUndefined();
  });

  it("condition 4: no offer when the behind project's only action has unmet dependencies", () => {
    expect(computeStayUpOffer(baseArgs({ actions: [action({ dependenciesComplete: false })] }))).toBeUndefined();
  });

  it("condition 4: no offer when the behind project has no action at all", () => {
    expect(computeStayUpOffer(baseArgs({ actions: [] }))).toBeUndefined();
  });

  // Condition 5: at least one of 30/60/90 must survive every filter.
  it("condition 5: no offer when no capacity window covers any extra time", () => {
    expect(computeStayUpOffer(baseArgs({ capacityWindows: [] }))).toBeUndefined();
  });

  it("condition 5: no offer when every choice would fall below the minimum", () => {
    expect(computeStayUpOffer(baseArgs({ minimumSleepMinutes: 460 }))).toBeUndefined();
  });

  it("condition 5: no offer when the action's own minimum session exceeds every choice", () => {
    expect(computeStayUpOffer(baseArgs({ actions: [action({ minimumSessionMinutes: 120 })] }))).toBeUndefined();
  });

  it("condition 5: no offer when the awake limit is already too tight for any choice", () => {
    // previousWakeAt only 10 minutes before the window opens: even 30 extra minutes pushes bedtime
    // past a 1-hour awake limit.
    expect(computeStayUpOffer(baseArgs({ previousWakeAt: at(-10), maxAwakeHours: 1 }))).toBeUndefined();
  });

  describe("choice filtering", () => {
    it("filters by minimum sleep: only the choices that still meet it survive", () => {
      // Loosen the session/awake-limit filters so minimum sleep is the only thing cutting choices:
      // 30 -> 450 min sleep, 60 -> 420 min, 90 -> 390 min. A 450-minute minimum keeps only 30.
      const offer = computeStayUpOffer(baseArgs({ minimumSleepMinutes: 450 }));
      expect(offer?.choices.map((choice) => choice.minutes)).toEqual([30]);
    });

    it("filters by the awake limit: a choice that would push bedtime past it is dropped", () => {
      // previousWakeAt 4.5 hours before `now`, a 5.5-hour awake limit: the limit falls exactly at
      // plannedStart + 30 (`at(60)`), so 30 just clears it and 60/90 do not.
      const offer = computeStayUpOffer(
        baseArgs({ previousWakeAt: at(-270), maxAwakeHours: 5.5, minimumSleepMinutes: 300 })
      );
      expect(offer?.choices.map((choice) => choice.minutes)).toEqual([30]);
    });

    it("filters by the action's minimum session: a choice shorter than it is dropped", () => {
      const offer = computeStayUpOffer(
        baseArgs({ actions: [action({ minimumSessionMinutes: 45 })], minimumSleepMinutes: 300 })
      );
      expect(offer?.choices.map((choice) => choice.minutes)).toEqual([60, 90]);
    });

    it("filters by evening admissibility: a choice the capacity windows don't fully cover is dropped", () => {
      // The window only covers 45 minutes past routineStart, so 30 (needing [00:15,00:45)) fits, but
      // 60 and 90 each reach past the window's end into an uncovered, "unavailable" stretch.
      const offer = computeStayUpOffer(baseArgs({ capacityWindows: [window("w", 15, 60)], minimumSleepMinutes: 300 }));
      expect(offer?.choices.map((choice) => choice.minutes)).toEqual([30]);
    });

    it("filters by evening admissibility: a commitment inside the extra window is dropped", () => {
      // A commitment sitting across the whole extra-time window (routineStart to +90) blocks every
      // choice, protected ranges included, exactly as an ordinary daytime commitment would.
      const blocking: FixedCommitment = {
        id: "meeting",
        startsAt: at(20),
        endsAt: at(25),
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      };
      expect(computeStayUpOffer(baseArgs({ commitments: [blocking], minimumSleepMinutes: 300 }))).toBeUndefined();
    });
  });

  it("accepting choices carry the resulting bedtime, wake and sleep length", () => {
    const offer = computeStayUpOffer(baseArgs());
    const thirty = offer?.choices.find((choice) => choice.minutes === 30);
    expect(thirty?.bedtimeAt.toISOString()).toBe(at(60).toISOString());
    expect(thirty?.wakeAt.toISOString()).toBe(at(30 + 480).toISOString());
    expect(thirty?.sleepMinutes).toBe(450);
  });
});
