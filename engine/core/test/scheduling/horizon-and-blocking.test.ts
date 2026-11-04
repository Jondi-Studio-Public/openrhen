import { describe, expect, it } from "vitest";
import { planSchedule, recommend } from "../../src/index.js";
import { formatDate } from "../../src/recommendation/format.js";
import type { Action, CapacityWindow, Project } from "../../src/index.js";

const now = new Date("2026-08-07T07:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

function project(id: string, deadlineMinutes = 600, overrides: Partial<Project> = {}): Project {
  return {
    id,
    status: "active",
    uncertainty: "known",
    internalDeadlineAt: at(deadlineMinutes),
    value: 3,
    consequence: 3,
    outcomeActive: true,
    ...overrides
  };
}

function action(id: string, projectId: string, minutes = 60, overrides: Partial<Action> = {}): Action {
  return {
    id,
    projectId,
    title: id,
    status: "active",
    optimisticMinutes: minutes,
    expectedMinutes: minutes,
    remainingMinutes: minutes,
    pessimisticMinutes: minutes,
    energy: "high",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 240,
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

function window(id: string, start: number, end: number, energy: CapacityWindow["energy"] = "high"): CapacityWindow {
  return { id, startsAt: at(start), endsAt: at(end), energy, contexts: [], usableFraction: 1 };
}

function recommendWith(overrides: Partial<Parameters<typeof recommend>[0]> = {}) {
  const projects = (overrides.projects ?? [project("p")]) as Project[];
  const actions = (overrides.actions ?? [action("a", "p", 240)]) as Action[];
  const capacityWindows = (overrides.capacityWindows ?? [window("day", 0, 600)]) as CapacityWindow[];
  const schedule = planSchedule({ now, horizonEnd: at(600), projects, actions, capacityWindows, commitments: [] });
  return recommend({
    now,
    horizonEnd: at(600),
    projects,
    actions,
    planning: schedule,
    forecasts: schedule.forecasts,
    capacityWindows,
    commitments: [],
    currentEnergy: "high",
    ...overrides
  });
}

describe("daily planning horizon", () => {
  it("stops a recommended session at the daily horizon", () => {
    const unbounded = recommendWith();
    const bounded = recommendWith({ dailyHorizonEnd: at(90) });
    expect(unbounded.primary?.recommendedMinutes).toBe(240);
    expect(bounded.primary?.recommendedMinutes).toBe(90);
    expect(bounded.evidence.some((item) => item.includes(formatDate(at(90))))).toBe(true);
  });

  it("offers no session once the daily horizon has passed", () => {
    const result = recommendWith({ dailyHorizonEnd: at(-30) });
    expect(result.primary).toBeNull();
  });

  it("still excludes an action whose minimum session no longer fits the bounded window", () => {
    const result = recommendWith({
      actions: [action("a", "p", 240, { minimumSessionMinutes: 60 })],
      dailyHorizonEnd: at(30)
    });
    expect(result.primary).toBeNull();
    expect(result.candidates[0]?.exclusionReasons.some((reason) => reason.includes("30 compatible minutes"))).toBe(
      true
    );
  });
});

describe("partially blocked projects", () => {
  it("forecasts the resolvable work instead of discarding the whole project", () => {
    const schedule = planSchedule({
      now,
      horizonEnd: at(600),
      projects: [project("p")],
      actions: [action("ready", "p", 60), action("stuck", "p", 120, { status: "blocked" })],
      capacityWindows: [window("day", 0, 600)],
      commitments: []
    });
    const forecast = schedule.forecasts[0]!;
    expect(forecast.health).not.toBe("unknown");
    expect(forecast.protectedRemainingMinutes).toBe(69); // 60 padded by the known multiplier
    expect(forecast.blockedEffortMinutes).toBe(138); // 120 padded by the known multiplier
    expect(forecast.reasons.some((reason) => reason.includes("blocked or waiting"))).toBe(true);
    // Blocked work is excluded from allocation but its uncertainty lowers confidence.
    expect(schedule.allocations.every((block) => block.actionId === "ready")).toBe(true);
    expect(forecast.confidence).toBe("medium_high");
  });

  it("falls back to unknown only when nothing is estimable", () => {
    const schedule = planSchedule({
      now,
      horizonEnd: at(600),
      projects: [project("p")],
      actions: [action("stuck", "p", 120, { status: "waiting" })],
      capacityWindows: [window("day", 0, 600)],
      commitments: []
    });
    expect(schedule.forecasts[0]!.health).toBe("unknown");
    expect(schedule.forecasts[0]!.reasons[0]).toContain("no other action is estimable");
  });
});

describe("overdue visibility on unknown-health forecasts", () => {
  it("reports overdue when a past-deadline project has no actions to forecast", () => {
    const schedule = planSchedule({
      now,
      horizonEnd: at(600),
      projects: [project("p", -60)],
      actions: [],
      capacityWindows: [window("day", 0, 600)],
      commitments: []
    });
    const forecast = schedule.forecasts[0]!;
    expect(forecast.health).toBe("unknown");
    expect(forecast.overdue).toBe(true);
  });

  it("does not report overdue when the unknown project's deadline has not passed", () => {
    const schedule = planSchedule({
      now,
      horizonEnd: at(600),
      projects: [project("p", 300)],
      actions: [],
      capacityWindows: [window("day", 0, 600)],
      commitments: []
    });
    const forecast = schedule.forecasts[0]!;
    expect(forecast.health).toBe("unknown");
    expect(forecast.overdue).toBe(false);
  });

  it("stays not-overdue when an unknown project simply has no deadline set", () => {
    const { internalDeadlineAt: _unused, ...projectWithoutDeadline } = project("p", 600);
    const schedule = planSchedule({
      now,
      horizonEnd: at(600),
      projects: [projectWithoutDeadline as Project],
      actions: [],
      capacityWindows: [window("day", 0, 600)],
      commitments: []
    });
    const forecast = schedule.forecasts[0]!;
    expect(forecast.health).toBe("unknown");
    expect(forecast.overdue).toBe(false);
  });

  it("stays not-overdue for a paused project even with a past deadline", () => {
    const schedule = planSchedule({
      now,
      horizonEnd: at(600),
      projects: [project("p", -60, { status: "paused" })],
      actions: [],
      capacityWindows: [window("day", 0, 600)],
      commitments: []
    });
    const forecast = schedule.forecasts[0]!;
    expect(forecast.health).toBe("unknown");
    expect(forecast.overdue).toBe(false);
  });
});
