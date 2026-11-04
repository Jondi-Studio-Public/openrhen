import { describe, expect, it } from "vitest";
import { planSchedule, resolvePlanningCapacity } from "../../src/index.js";
import type { Action, CapacityWindow, Project } from "../../src/index.js";

// a live project that does not fit carries its smallest useful interventions, smallest first.
const now = new Date("2026-08-07T07:00:00.000Z");
const DAY_MS = 86_400_000;
const days = (count: number) => new Date(now.getTime() + count * DAY_MS);
const horizonEnd = days(180);
const capacityWindows = resolvePlanningCapacity({
  now,
  horizonEnd,
  usableFraction: 0.75,
  timezone: "Australia/Sydney",
  dayStartTime: "07:00",
  dayEndTime: "22:00"
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
    optimisticMinutes: minutes,
    expectedMinutes: minutes,
    pessimisticMinutes: minutes,
    remainingMinutes: minutes,
    energy: "high",
    minimumSessionMinutes: 30,
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

function forecast(projects: Project[], actions: Action[], projectId: string, windows = capacityWindows) {
  const schedule = planSchedule({
    now,
    horizonEnd,
    projects,
    actions,
    capacityWindows: windows,
    commitments: [],
    projectedDailyProtectedMinutes: 30
  });
  return schedule.forecasts.find((item) => item.projectId === projectId)!;
}

describe("corrective interventions", () => {
  it("offers added time, then the earliest self-set date the shortfall fits", () => {
    const result = forecast([project("short", 2)], [action("big", "short", 3_000)], "short");
    expect(result.health).toBe("behind");
    expect(result.interventions?.map((item) => item.kind)).toEqual(["add_time", "move_deadline"]);
    const [addTime, move] = result.interventions!;
    expect(addTime!.minutes).toBeGreaterThan(0);
    expect(move!.minutes).toBe(addTime!.minutes);
    expect(move!.proposedDeadlineAt!.getTime()).toBeGreaterThan(days(2).getTime());
    expect(move!.reason).toContain("Move the self-set date to");
    expect(result.proposal).toBeUndefined();
  });

  it("never counts leftover fragments before the deadline toward the proposed date", () => {
    const HOUR_MS = 3_600_000;
    const window = (id: string, startsAt: Date, minutes: number): CapacityWindow => ({
      id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + minutes * 60_000),
      energy: "high",
      usableFraction: 1
    });
    // Eight 45-minute fragments before the deadline: 360 free minutes, none long enough for a
    // 60-minute minimum session, so the whole padded 575 minutes (500 plus the known multiplier) are short. Counted from now, the fragments
    // would pull the proposed date 360 minutes too early.
    const fragments = Array.from({ length: 8 }, (_, index) =>
      window(`fragment-${index}`, new Date(now.getTime() + (index * 4 + 1) * HOUR_MS), 45)
    );
    const after = window("after", days(3), 600);
    const result = forecast(
      [project("fragmented", 2)],
      [action("chunky", "fragmented", 500, { minimumSessionMinutes: 60, maximumSessionMinutes: 120 })],
      "fragmented",
      [...fragments, after]
    );
    const move = result.interventions?.find((item) => item.kind === "move_deadline");
    expect(move?.minutes).toBe(575); // the 500 padded by the known multiplier
    // Only the post-deadline window counts, so the date lands inside it, past its first `minutes`.
    expect(move!.proposedDeadlineAt!.getTime()).toBeGreaterThan(days(2).getTime());
    expect(move!.proposedDeadlineAt!.getTime()).toBeGreaterThanOrEqual(
      after.startsAt.getTime() + move!.minutes * 60_000
    );
    expect(move!.proposedDeadlineAt!.getTime()).toBeLessThanOrEqual(after.endsAt.getTime());
  });

  it("asks for an extension or help when the date is someone else's", () => {
    const result = forecast(
      [project("committed", null, { externalDeadlineAt: days(2) })],
      [action("big", "committed", 3_000)],
      "committed"
    );
    const extension = result.interventions?.find((item) => item.kind === "request_extension");
    expect(extension?.proposedDeadlineAt).toBeInstanceOf(Date);
    expect(extension?.reason).toContain("hand");
    expect(result.interventions?.some((item) => item.kind === "move_deadline")).toBe(false);
  });

  it("proposes moving a self-set target that sits before a later external date", () => {
    // Health is measured against the 2-day target, which is the person's own: moving it is the remedy, not
    // asking whoever holds the 30-day date for an extension.
    const result = forecast(
      [project("target-first", 2, { externalDeadlineAt: days(30) })],
      [action("big", "target-first", 3_000)],
      "target-first"
    );
    expect(result.health).toBe("behind");
    expect(result.interventions?.some((item) => item.kind === "move_deadline")).toBe(true);
    expect(result.interventions?.some((item) => item.kind === "request_extension")).toBe(false);
  });

  it("proposes no date when the shortfall never fits inside the horizon", () => {
    const result = forecast([project("huge", 2)], [action("endless", "huge", 400_000)], "huge");
    const move = result.interventions?.find((item) => item.kind === "move_deadline");
    expect(move?.proposedDeadlineAt).toBeNull();
    expect(move?.reason).toContain("does not fit inside the forecast horizon");
  });

  it("asks to split work that has the minutes but no window long enough to hold it whole", () => {
    const result = forecast(
      [project("shape", 6)],
      [action("marathon", "shape", 900, { splittable: false, minimumSessionMinutes: 900, maximumSessionMinutes: 900 })],
      "shape"
    );
    expect(result.schedulingBlocked).toBe(true);
    const split = result.interventions?.find((item) => item.kind === "split_work");
    expect(split?.actionIds).toEqual(["marathon"]);
    expect(split?.reason).toContain("Allow it to be split");
    expect(result.interventions?.some((item) => item.kind === "add_time")).toBe(false);
  });

  it("asks to narrow an uncertain estimate first when only its risk buffer is short", () => {
    const result = forecast(
      [project("fuzzy", 2)],
      [action("fuzzy", "fuzzy", 600, { optimisticMinutes: 500, pessimisticMinutes: 2_000 })],
      "fuzzy"
    );
    expect(result.health).toBe("at_risk");
    expect(result.interventions).toHaveLength(1);
    expect(result.interventions?.[0]?.kind).toBe("clarify_estimate");
    expect(result.interventions?.[0]?.actionIds).toEqual(["fuzzy"]);
    expect(result.interventions?.[0]?.minutes).toBeGreaterThan(0);
  });

  it("asks to narrow the widest estimate when the work fits but not at its pessimistic estimate", () => {
    const result = forecast(
      [project("wide", 2)],
      [action("wide", "wide", 600, { optimisticMinutes: 580, pessimisticMinutes: 1_500 }), action("tight", "wide", 60)],
      "wide"
    );
    expect(result.unallocatedExpectedMinutes).toBe(0);
    expect(result.pessimisticMarginMinutes).toBeLessThan(0);
    expect(result.interventions?.map((item) => item.kind)).toEqual(["clarify_estimate"]);
    expect(result.interventions?.[0]?.actionIds).toEqual(["wide"]);
    expect(result.interventions?.[0]?.reason).toContain("pessimistic estimate");
  });

  it("leaves a project that fits, and an overdue one, without interventions", () => {
    const projects = [project("fine", 30), project("late", -1)];
    const actions = [action("small", "fine", 60), action("slipped", "late", 60)];
    expect(forecast(projects, actions, "fine").interventions).toBeUndefined();
    const late = forecast(projects, actions, "late");
    expect(late.interventions).toBeUndefined();
    expect(late.proposal?.kind).toBe("move_deadline");
  });
});
