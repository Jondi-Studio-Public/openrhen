import { describe, expect, it } from "vitest";
import { planSchedule } from "../../src/index.js";
import type { Action, CapacityWindow, Project } from "../../src/index.js";

/** Regression cases for the estimate maths in `schedule.ts` (undated finish, setup top-ups). */

const now = new Date("2026-08-07T07:00:00.000Z");
const DAY = 24 * 60;
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p",
    status: "active",
    uncertainty: "known",
    value: 3,
    consequence: 3,
    outcomeActive: true,
    ...overrides
  };
}

function action(id: string, minutes: number, overrides: Partial<Action> = {}): Action {
  return {
    id,
    projectId: "p",
    title: id,
    status: "active",
    optimisticMinutes: minutes,
    expectedMinutes: minutes,
    remainingMinutes: minutes,
    pessimisticMinutes: minutes,
    energy: "high",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 480,
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

function window(id: string, from: number, to: number): CapacityWindow {
  return { id, startsAt: at(from), endsAt: at(to), energy: "high", usableFraction: 1 };
}

/** Minutes held on the ledger for the project: placed blocks plus aggregate band reservations. */
function reservedMinutes(result: ReturnType<typeof planSchedule>) {
  return (
    result.allocations.reduce((sum, block) => sum + block.minutes, 0) +
    result.projectEnvelopes.reduce((sum, envelope) => sum + envelope.reservedMinutes, 0)
  );
}

describe("undated finish shares one capacity ledger across actions", () => {
  it("does not count the same window minutes for two actions", () => {
    const result = planSchedule({
      now,
      horizonEnd: at(30 * DAY),
      projects: [project()],
      actions: [action("a", 60), action("b", 60)],
      capacityWindows: [window("w", 0, 180)],
      commitments: [],
      focusedProjectIds: ["p"]
    });
    const forecast = result.forecasts[0]!;
    // Each 60-minute single figure is padded to 69; the project total is 133, finishing at 150 minutes once the shared slots are filled in whole sessions.
    expect(forecast.protectedRemainingMinutes).toBe(133);
    expect(forecast.estimatedFinishAt).toEqual(at(150));
  });
});

describe("setup top-ups keep the run and break state", () => {
  const job = action("job", 120, {
    setupMinutes: 20,
    maximumSessionMinutes: 60
  });

  it("does not tile a top-up against the first placement into one over-long run", () => {
    const result = planSchedule({
      now,
      horizonEnd: at(2 * DAY),
      projects: [project({ internalDeadlineAt: at(240) })],
      actions: [job],
      capacityWindows: [window("w", 0, 240)],
      commitments: []
    });
    const blocks = result.allocations
      .filter((block) => block.actionId === "job")
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    // Walk the blocks: back-to-back ones are a run, and no run may pass the 60-minute session maximum.
    let run = 0;
    let previousEnd = -Infinity;
    for (const block of blocks) {
      run = block.startsAt.getTime() <= previousEnd ? run + block.minutes : block.minutes;
      previousEnd = block.endsAt.getTime();
      expect(run).toBeLessThanOrEqual(60);
    }
  });
});

describe("setup reservation converges", () => {
  it("reserves every setup owed by a long action split into many runs", () => {
    const job = action("job", 1200, {
      setupMinutes: 20,
      maximumSessionMinutes: 60
    });
    const result = planSchedule({
      now,
      horizonEnd: at(100 * DAY),
      projects: [project({ internalDeadlineAt: at(80 * DAY) })],
      actions: [job],
      capacityWindows: [window("w", 20 * DAY, 80 * DAY)],
      commitments: []
    });
    const forecast = result.forecasts[0]!;
    // The single-figure 1200 is padded to 1380; setup is real work on top of that padding, so
    // the ledger holds the padded figure plus every setup owed, which is the forecast's protected
    // effort.
    expect(reservedMinutes(result)).toBe(forecast.protectedRemainingMinutes);
  });
});

describe("padded setup is protected and reserved alike", () => {
  it("holds exactly the protected effort for a padded action with setup", () => {
    const job = action("job", 300, {
      optimisticMinutes: 240,
      pessimisticMinutes: 420,
      setupMinutes: 15,
      maximumSessionMinutes: 60
    });
    const result = planSchedule({
      now,
      horizonEnd: at(100 * DAY),
      projects: [project({ internalDeadlineAt: at(80 * DAY) })],
      actions: [job],
      capacityWindows: [window("w", 20 * DAY, 80 * DAY)],
      commitments: []
    });
    const forecast = result.forecasts[0]!;
    // The padding is above the mean and setup is owed on top of it, so protected exceeds the
    // expected figure and the ledger must hold all of it.
    expect(forecast.protectedRemainingMinutes!).toBeGreaterThan(forecast.expectedRemainingMinutes!);
    expect(reservedMinutes(result)).toBe(forecast.protectedRemainingMinutes);
  });
});

describe("recurring overflow keeps the first part's setup top-up", () => {
  it("requests the unfilled top-up from the overflow call", () => {
    const series = action("series", 120, {
      schedulingMode: "recurring",
      setupMinutes: 10,
      maximumSessionMinutes: 60,
      availableFrom: at(20 * DAY),
      deadlineAt: at(20 * DAY + 89)
    });
    const result = planSchedule({
      now,
      horizonEnd: at(120 * DAY),
      projects: [project({ internalDeadlineAt: at(60 * DAY) })],
      actions: [series],
      capacityWindows: [window("band", 20 * DAY, 20 * DAY + 89), window("later", 30 * DAY, 50 * DAY)],
      commitments: []
    });
    const forecast = result.forecasts[0]!;
    // The join between the two parts is margin-only (10 minutes); nothing else may go unreserved.
    expect(forecast.protectedRemainingMinutes! - reservedMinutes(result)).toBeLessThanOrEqual(10);
  });
});

describe("recurring overflow asks only for work not yet placed", () => {
  it("holds the protected effort less at most the join setup when the first part runs short", () => {
    // Guards the overflow's `stillNeeded`: a setup top-up must never pass for placed work. Planning
    // cannot yet reach a first part with both a shortfall and a top-up, so this holds with or without
    // the subtraction; it pins the bookkeeping if capacity shaping ever makes that state reachable.
    const series = action("series", 129, {
      schedulingMode: "recurring",
      setupMinutes: 8,
      maximumSessionMinutes: 54,
      availableFrom: at(20 * DAY),
      deadlineAt: at(20 * DAY + 329)
    });
    const result = planSchedule({
      now,
      horizonEnd: at(120 * DAY),
      projects: [project({ internalDeadlineAt: at(60 * DAY) })],
      actions: [series],
      capacityWindows: [
        { ...window("band", 20 * DAY, 20 * DAY + 184), usableFraction: 0.8 },
        window("later", 30 * DAY, 50 * DAY),
        window("band2", 20 * DAY + 234, 20 * DAY + 279)
      ],
      commitments: []
    });
    const forecast = result.forecasts[0]!;
    expect(forecast.protectedRemainingMinutes! - reservedMinutes(result)).toBeLessThanOrEqual(8 + 1e-6);
  });
});
