import { describe, expect, it } from "vitest";
import {
  cadenceDaysOverdue,
  cadenceDueLocalDate,
  cadenceDueRatio,
  cadenceEligibleFrom,
  cadenceOccurrencesPerDay,
  cadencePeriodPressure,
  cadencePeriodStatus,
  cadencePressure,
  cadenceStepDueToday,
  localDate,
  planSchedule,
  recommend,
  resolvePlanningCapacity
} from "../../src/index.js";
import type { Action, ActionCadence, CapacityWindow, Project } from "../../src/index.js";
import { holding } from "../model/situation.js";

// 17:00 on Friday 7 August in the seed zone: mid-afternoon, plenty of day left.
const now = new Date("2026-08-07T07:00:00.000Z");
const DAY_MS = 86_400_000;
const days = (count: number) => new Date(now.getTime() + count * DAY_MS);
const horizonEnd = days(180);
const timezone = "Australia/Sydney";
const dayBounds = { timezone, dayStartTime: "07:00", dayEndTime: "22:00" };

const automatic = (): CapacityWindow[] =>
  resolvePlanningCapacity({
    now,
    horizonEnd,
    usableFraction: 0.85,
    ...dayBounds
  });

function project(id: string, deadlineDays: number | null, overrides: Partial<Project> = {}): Project {
  return {
    id,
    status: "active",
    uncertainty: "known",
    value: 3,
    consequence: 3,
    outcomeActive: true,
    ...(deadlineDays === null ? {} : { internalDeadlineAt: days(deadlineDays) }),
    ...overrides
  };
}

function action(id: string, projectId: string, minutes: number, overrides: Partial<Action> = {}): Action {
  return {
    id,
    projectId,
    title: id,
    status: "active",
    optimisticMinutes: Math.round(minutes * 0.8),
    expectedMinutes: minutes,
    pessimisticMinutes: Math.round(minutes * 1.4),
    remainingMinutes: minutes,
    energy: "medium",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 60,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependenciesComplete: true,
    dependencyIds: [],
    splittable: true,
    setupMinutes: 0,
    ...overrides
  };
}

function cadence(intervalDays: number, lastCompletedLocalDate?: string, startDate = "2026-07-01"): ActionCadence {
  return {
    intervalDays,
    timezone,
    startDate,
    ...(lastCompletedLocalDate ? { lastCompletedLocalDate } : {}),
    completionCount: lastCompletedLocalDate ? 1 : 0
  };
}

/** A cadence the way the engine sees it after hydration: the facts plus the derived gate. */
function cadenceAction(
  id: string,
  projectId: string,
  importance: number,
  rule: ActionCadence,
  overrides: Partial<Action> = {}
): Action {
  return action(id, projectId, 30, {
    importance,
    schedulingMode: "cadence",
    cadence: rule,
    availableFrom: cadenceEligibleFrom(rule, now),
    ...overrides
  });
}

/** A period/target cadence rule: `completionLocalDates` stands in for the completion log. */
function periodCadence(
  period: NonNullable<ActionCadence["period"]>,
  targetOccurrences: number,
  completionLocalDates: string[] = [],
  overrides: Partial<ActionCadence> = {}
): ActionCadence {
  return {
    intervalDays: 1,
    timezone,
    startDate: "2026-07-01",
    period,
    targetOccurrences,
    completionLocalDates,
    completionCount: completionLocalDates.length,
    ...(completionLocalDates.length
      ? { lastCompletedLocalDate: completionLocalDates[completionLocalDates.length - 1] }
      : {}),
    ...overrides
  };
}

/** Same as `cadenceAction`, but resolves `availableFrom` against the fixture `now` — required for a period
 *  rule, whose eligibility depends on which period "today" falls in. */
function periodCadenceAction(
  id: string,
  projectId: string,
  importance: number,
  rule: ActionCadence,
  overrides: Partial<Action> = {}
): Action {
  return action(id, projectId, 30, {
    importance,
    schedulingMode: "cadence",
    cadence: rule,
    availableFrom: cadenceEligibleFrom(rule, now),
    ...overrides
  });
}

function rank(projects: Project[], actions: Action[], overrides: Partial<Parameters<typeof recommend>[0]> = {}) {
  const capacityWindows = automatic();
  const schedule = planSchedule({
    now,
    horizonEnd,
    projects,
    actions,
    capacityWindows,
    commitments: [],
    projectedDailyProtectedMinutes: 30
  });
  const result = recommend({
    now,
    horizonEnd,
    projects,
    actions,
    planning: schedule,
    forecasts: schedule.forecasts,
    capacityWindows,
    commitments: [],
    currentEnergy: "medium",
    ...overrides
  });
  return {
    result,
    candidate: (id: string) => result.candidates.find((item) => item.action.id === id)!
  };
}

const maths = project("maths", null, { value: 3 });
const fitness = project("fitness", null, { value: 3 });

describe("cadence arithmetic", () => {
  it("is due the interval after it was last done, and a never-done series is due from its start", () => {
    expect(cadenceDueLocalDate(cadence(3, "2026-08-04"), now)).toBe("2026-08-07");
    expect(cadenceDueLocalDate(cadence(1, undefined, "2026-08-07"), now)).toBe("2026-08-07");
  });

  it("measures dueness in whole local days as a fraction of the interval", () => {
    expect(cadenceDueRatio(cadence(1, "2026-08-06"), now)).toBe(1);
    expect(cadenceDueRatio(cadence(3, "2026-08-06"), now)).toBeCloseTo(1 / 3);
    expect(cadenceDueRatio(cadence(3, "2026-08-01"), now)).toBe(2);
    expect(cadenceDueRatio(cadence(1, undefined, "2026-08-07"), now)).toBe(1);
    expect(cadenceDueRatio(cadence(1, undefined, "2026-08-10"), now)).toBeLessThan(1);
  });

  it("presses half on the due day and saturates one interval late", () => {
    expect(cadencePressure(0)).toBe(0);
    expect(cadencePressure(1)).toBe(0.5);
    expect(cadencePressure(2)).toBe(1);
    expect(cadencePressure(5)).toBe(1);
  });

  it("counts days overdue from the due date, never negative", () => {
    expect(cadenceDaysOverdue(cadence(3, "2026-08-01"), now)).toBe(3);
    expect(cadenceDaysOverdue(cadence(3, "2026-08-06"), now)).toBe(0);
  });

  it("is next eligible at local midnight after the day it was done, never before the series starts", () => {
    // Done today (seed-zone 7 August) → eligible from 8 August 00:00 local = 7 August 14:00Z.
    expect(cadenceEligibleFrom(cadence(1, "2026-08-07"), now).toISOString()).toBe("2026-08-07T14:00:00.000Z");
    expect(cadenceEligibleFrom(cadence(1, undefined, "2026-08-10"), now).toISOString()).toBe(
      "2026-08-09T14:00:00.000Z"
    );
    expect(cadenceEligibleFrom(cadence(1, "2026-08-01", "2026-08-10"), now).toISOString()).toBe(
      "2026-08-09T14:00:00.000Z"
    );
  });

  it("leaves a rule without a period byte-identical to the plain-interval math above", () => {
    // Same fixtures as the plain-interval tests, just re-asserted through the same call sites a period
    // rule would use, to pin that adding `period` support did not perturb the untouched path.
    const rule = cadence(3, "2026-08-01");
    expect(rule.period).toBeUndefined();
    expect(cadenceDueLocalDate(rule, now)).toBe("2026-08-04");
    expect(cadenceDaysOverdue(rule, now)).toBe(3);
  });
});

describe("cadenceStepDueToday", () => {
  it("is exactly cadenceEligibleFrom(...) <= now, for a plain-interval rule", () => {
    // now is 2026-08-07T07:00Z (seed-zone Friday afternoon). Done today → eligible only from tomorrow.
    expect(cadenceStepDueToday(cadence(1, "2026-08-07"), now)).toBe(false);
    // Done yesterday → the "not again today" gate has already lifted.
    expect(cadenceStepDueToday(cadence(1, "2026-08-06"), now)).toBe(true);
    // Never done, series already started → due immediately.
    expect(cadenceStepDueToday(cadence(1, undefined, "2026-08-01"), now)).toBe(true);
    // Never done, series starts in the future → not due yet.
    expect(cadenceStepDueToday(cadence(1, undefined, "2026-08-10"), now)).toBe(false);
  });

  it("agrees with the period rule's own eligibility", () => {
    // Blocks of 7 days from 2026-07-01 land "now" (2026-08-07) in the 2026-08-05..2026-08-11 block.
    const dueRule = cadence(1, undefined, "2026-07-01");
    dueRule.period = { unit: "days", length: 7 };
    dueRule.targetOccurrences = 2;
    dueRule.completionLocalDates = ["2026-08-06"]; // one done this block, one still wanted
    expect(cadenceStepDueToday(dueRule, now)).toBe(true);

    const metRule = cadence(1, undefined, "2026-07-01");
    metRule.period = { unit: "days", length: 7 };
    metRule.targetOccurrences = 2;
    metRule.completionLocalDates = ["2026-08-05", "2026-08-06"]; // target already met this block
    expect(cadenceStepDueToday(metRule, now)).toBe(false);
  });

  it("takes `now` from the caller, never the clock", () => {
    // A never-done series starting well before the supplied instant is due, and one starting after it is not.
    expect(cadenceStepDueToday(cadence(1, undefined, "2020-01-01"), now)).toBe(true);
    expect(cadenceStepDueToday(cadence(1, undefined, "2027-01-01"), now)).toBe(false);
  });
});

describe("cadence period arithmetic (days unit)", () => {
  // A period counts off in fixed `length`-day blocks from the rule's own `startDate`, the same way a
  // plain interval counts cycles — not a window sliding with "now" — so a target has a real "early in
  // the block" and "block nearly over" the way "twice this week" implies.
  it("counts completions within the current block and presses harder as the block's days run out", () => {
    const rule = periodCadence({ unit: "days", length: 7 }, 2, [], { startDate: "2026-07-01" });
    const status = cadencePeriodStatus(rule, now);
    expect(status).toMatchObject({ start: "2026-08-05", end: "2026-08-11", daysLeft: 5, done: 0, remaining: 2 });
    expect(cadencePeriodPressure(rule, now)).toBeCloseTo(0.4);
  });

  it("saturates at full pressure when the remaining count no longer fits the days left", () => {
    // Block [2026-08-02, 2026-08-08]: today is the 6th of 7 days, 2 days left, 2 still wanted.
    const rule = periodCadence({ unit: "days", length: 7 }, 2, [], { startDate: "2026-08-02" });
    expect(cadencePeriodStatus(rule, now).daysLeft).toBe(2);
    expect(cadencePeriodPressure(rule, now)).toBe(1);
  });

  it("drops pressure to zero once the target is met, however many days remain in the block", () => {
    const rule = periodCadence({ unit: "days", length: 7 }, 2, ["2026-08-05", "2026-08-06"], {
      startDate: "2026-07-01"
    });
    const status = cadencePeriodStatus(rule, now);
    expect(status.remaining).toBe(0);
    expect(status.nextEligibleLocalDate).toBe("2026-08-12");
    expect(cadencePeriodPressure(rule, now)).toBe(0);
  });

  it("is eligible again only once the target is short, not on the block's every day", () => {
    const met = periodCadence({ unit: "days", length: 7 }, 2, ["2026-08-05", "2026-08-06"], {
      startDate: "2026-07-01"
    });
    expect(localDate(cadenceEligibleFrom(met, now), timezone)).toBe("2026-08-12");
    const short = periodCadence({ unit: "days", length: 7 }, 2, ["2026-08-05"], { startDate: "2026-07-01" });
    expect(localDate(cadenceEligibleFrom(short, now), timezone)).toBe("2026-08-07");
  });

  it("never suggests it twice in one local day even mid-target", () => {
    const rule = periodCadence({ unit: "days", length: 7 }, 3, ["2026-08-07"], { startDate: "2026-07-01" });
    expect(cadencePeriodStatus(rule, now).remaining).toBe(2);
    expect(localDate(cadenceEligibleFrom(rule, now), timezone)).toBe("2026-08-08");
  });

  it("holds off until minSpacingDays after the last completion, even with days still wanted", () => {
    const rule = periodCadence({ unit: "days", length: 7 }, 2, ["2026-08-05"], {
      startDate: "2026-07-01",
      minSpacingDays: 3
    });
    expect(localDate(cadenceEligibleFrom(rule, now), timezone)).toBe("2026-08-08");
  });

  it("restricts suggestions to eligible weekdays, advancing past days it excludes", () => {
    // 7 August 2026 is a Friday; Monday/Wednesday only means the next allowed day is Monday 10th.
    const rule = periodCadence({ unit: "days", length: 7 }, 2, [], {
      startDate: "2026-07-01",
      eligibleWeekdays: [1, 3]
    });
    expect(localDate(cadenceEligibleFrom(rule, now), timezone)).toBe("2026-08-10");
  });

  it("spreads target occurrences across the block length for weekly demand estimates", () => {
    const rule = periodCadence({ unit: "days", length: 7 }, 2, [], { startDate: "2026-07-01" });
    expect(cadenceOccurrencesPerDay(rule, now)).toBeCloseTo(2 / 7);
  });
});

describe("cadence period arithmetic (calendar month)", () => {
  it("counts completions within the current calendar month, using its real day count", () => {
    const rule = periodCadence({ unit: "month" }, 1, [], { startDate: "2026-07-01" });
    const status = cadencePeriodStatus(rule, now);
    expect(status).toMatchObject({ start: "2026-08-01", end: "2026-08-31", daysLeft: 25, done: 0, remaining: 1 });
    expect(cadencePeriodPressure(rule, now)).toBeCloseTo(1 / 25);
  });

  it("is due again from the first of next month once this month's target is met", () => {
    const rule = periodCadence({ unit: "month" }, 1, ["2026-08-03"], { startDate: "2026-07-01" });
    const status = cadencePeriodStatus(rule, now);
    expect(status.remaining).toBe(0);
    expect(status.nextEligibleLocalDate).toBe("2026-09-01");
    expect(localDate(cadenceEligibleFrom(rule, now), timezone)).toBe("2026-09-01");
  });

  it("spreads a monthly target across that month's own day count", () => {
    const rule = periodCadence({ unit: "month" }, 1, [], { startDate: "2026-07-01" });
    expect(cadenceOccurrencesPerDay(rule, now)).toBeCloseTo(1 / 31);
  });
});

describe("cadence ranking", () => {
  it("chooses the more important cadence action when both are due, and keeps both in the ordinary tier", () => {
    const actions = [
      cadenceAction("maths-drill", "maths", 5, cadence(1, "2026-08-06")),
      cadenceAction("run", "fitness", 2, cadence(3, "2026-08-04"))
    ];
    const { result, candidate } = rank([maths, fitness], actions);
    expect(result.primary?.action.id).toBe("maths-drill");
    expect(candidate("maths-drill").criticalTier).toBe("ordinary");
    expect(candidate("run").criticalTier).toBe("ordinary");
    expect(candidate("maths-drill").scoreComponents.cadenceDue).toBe(20);
    expect(candidate("run").scoreComponents.cadenceDue).toBe(8);
  });

  it("does not offer a cadence action again on the day it was done, so the next one leads", () => {
    const actions = [
      cadenceAction("maths-drill", "maths", 5, cadence(1, "2026-08-07")),
      cadenceAction("run", "fitness", 2, cadence(3, "2026-08-04"))
    ];
    const { result, candidate } = rank([maths, fitness], actions);
    expect(candidate("maths-drill").eligible).toBe(false);
    expect(candidate("maths-drill").exclusionReasons[0]).toMatch(/becomes available at/);
    expect(result.primary?.action.id).toBe("run");
  });

  it("lets a badly overdue low-importance cadence action press harder without overtaking a due important one", () => {
    const actions = [
      cadenceAction("maths-drill", "maths", 5, cadence(1, "2026-08-06")),
      cadenceAction("run", "fitness", 2, cadence(3, "2026-08-01"))
    ];
    const { result, candidate } = rank([maths, fitness], actions);
    expect(candidate("run").scoreComponents.cadenceDue).toBe(16);
    expect(result.primary?.action.id).toBe("maths-drill");
  });

  it("offers a not-yet-due cadence action at low pressure rather than hiding it", () => {
    const actions = [cadenceAction("maths-drill", "maths", 5, cadence(3, "2026-08-06"))];
    const { result, candidate } = rank([maths], actions);
    expect(candidate("maths-drill").eligible).toBe(true);
    expect(candidate("maths-drill").scoreComponents.cadenceDue).toBe(7);
    expect(result.primary?.action.id).toBe("maths-drill");
  });

  it("treats a never-done series as due from its start date", () => {
    const actions = [cadenceAction("maths-drill", "maths", 5, cadence(1, undefined, "2026-08-07"))];
    const { candidate } = rank([maths], actions);
    expect(candidate("maths-drill").scoreComponents.cadenceDue).toBe(20);
  });

  it("applies the ordinary context rules: a run needs outdoors, maths needs only a phone", () => {
    const actions = [
      cadenceAction("maths-drill", "maths", 5, cadence(1, "2026-08-06"), { contexts: ["phone"] }),
      cadenceAction("run", "fitness", 5, cadence(3, "2026-08-04"), { contexts: ["outdoors"] })
    ];
    const { result, candidate } = rank([maths, fitness], actions, holding("phone"));
    expect(candidate("run").eligible).toBe(false);
    expect(candidate("run").exclusionReasons.join(" ")).toMatch(/Missing context: outdoors/);
    expect(result.primary?.action.id).toBe("maths-drill");
  });

  it("lets a measured self-set deadline this week outweigh a due cadence action by score, not by tier", () => {
    // Since due-this-week self-set deadlines moved from a tier into a score bonus
    // this no longer pre-empts by rank: both candidates rank
    // `ordinary`, and the measured bonus (45) still outweighs the largest cadence pressure (40).
    const assignment = project("assignment", 3, { value: 3, consequence: 3 });
    const actions = [
      cadenceAction("maths-drill", "maths", 5, cadence(1, "2026-07-20")),
      action("assignment-draft", "assignment", 600)
    ];
    const { result, candidate } = rank([maths, assignment], actions);
    expect(candidate("maths-drill").scoreComponents.cadenceDue).toBe(40);
    expect(candidate("assignment-draft").criticalTier).toBe("ordinary");
    expect(candidate("assignment-draft").scoreComponents.selfSetDeadline).toBe(45);
    expect(result.primary?.action.id).toBe("assignment-draft");
  });

  it("carries no cadence pressure on any other scheduling mode", () => {
    const actions = [action("one-off", "maths", 60)];
    const { candidate } = rank([maths], actions);
    expect(candidate("one-off").scoreComponents.cadenceDue).toBe(0);
  });
});

describe("period cadence ranking", () => {
  it("scores a period rule through cadenceDue the same way a plain interval does, via the period pressure", () => {
    const rule = periodCadence({ unit: "days", length: 7 }, 2, [], { startDate: "2026-07-01" });
    const actions = [periodCadenceAction("stretch", "fitness", 5, rule)];
    const { candidate } = rank([fitness], actions);
    // Pressure 0.4 (see the arithmetic tests above) at importance 5: round(0.4 * 40).
    expect(candidate("stretch").scoreComponents.cadenceDue).toBe(16);
  });

  it("is not eligible once the period's target is already met, so a still-short cadence action leads", () => {
    const met = periodCadence({ unit: "days", length: 7 }, 2, ["2026-08-05", "2026-08-06"], {
      startDate: "2026-07-01"
    });
    const short = periodCadence({ unit: "days", length: 7 }, 2, [], { startDate: "2026-08-02" });
    const actions = [
      periodCadenceAction("stretch", "fitness", 5, met),
      periodCadenceAction("run", "fitness", 2, short)
    ];
    const { result, candidate } = rank([fitness], actions);
    expect(candidate("stretch").eligible).toBe(false);
    expect(candidate("stretch").exclusionReasons[0]).toMatch(/becomes available at/);
    expect(result.primary?.action.id).toBe("run");
  });

  it("carries no pressure once a calendar-month target is met, and full pressure while short late in the month", () => {
    const monthMet = periodCadence({ unit: "month" }, 1, ["2026-08-03"], { startDate: "2026-07-01" });
    const actions = [periodCadenceAction("journal", "fitness", 5, monthMet)];
    const { candidate } = rank([fitness], actions);
    expect(candidate("journal").scoreComponents.cadenceDue).toBe(0);
  });
});
