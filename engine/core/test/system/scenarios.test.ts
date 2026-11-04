import { describe, expect, it } from "vitest";
import { planSchedule, recommend, simulateContinuation } from "../../src/index.js";
import type { Action, CapacityWindow, FixedCommitment, Project } from "../../src/index.js";

// Friday 07:00 UTC. Scenarios use explicit windows so each one states its own capacity.
const now = new Date("2026-08-07T07:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
const HOUR = 60;

function project(id: string, deadlineMinutes: number, overrides: Partial<Project> = {}): Project {
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

function action(id: string, projectId: string, minutes: number, overrides: Partial<Action> = {}): Action {
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

function window(id: string, start: number, end: number, energy: CapacityWindow["energy"] = "high"): CapacityWindow {
  return { id, startsAt: at(start), endsAt: at(end), energy, contexts: [], usableFraction: 1 };
}

function plan(
  projects: Project[],
  actions: Action[],
  capacityWindows: CapacityWindow[],
  commitments: FixedCommitment[] = [],
  horizonMinutes = 10 * 24 * HOUR
) {
  return planSchedule({ now, horizonEnd: at(horizonMinutes), projects, actions, capacityWindows, commitments });
}

function next(
  projects: Project[],
  actions: Action[],
  capacityWindows: CapacityWindow[],
  commitments: FixedCommitment[] = [],
  overrides: Partial<Parameters<typeof recommend>[0]> = {}
) {
  const horizonEnd = at(10 * 24 * HOUR);
  const schedule = planSchedule({ now, horizonEnd, projects, actions, capacityWindows, commitments });
  return recommend({
    now,
    horizonEnd,
    projects,
    actions,
    planning: schedule,
    forecasts: schedule.forecasts,
    capacityWindows,
    commitments,
    currentEnergy: "high",
    ...overrides
  });
}

describe("planning scenarios", () => {
  it("plans an assignment that comfortably fits the week", () => {
    const assignment = project("assignment", 7 * 24 * HOUR);
    const actions = [
      action("draft", "assignment", 120),
      action("review", "assignment", 60, { dependencyIds: ["draft"], dependenciesComplete: false })
    ];
    const forecast = plan([assignment], actions, [window("week", 0, 7 * 24 * HOUR)]).forecasts[0]!;
    expect(forecast.health).toBe("on_track");
    expect(forecast.expectedMarginMinutes).toBeGreaterThan(0);
  });

  it("turns at risk once remaining effort is revised upward", () => {
    const assignment = project("assignment", 8 * HOUR);
    const before = plan([assignment], [action("draft", "assignment", 240)], [window("day", 0, 8 * HOUR)]).forecasts[0]!;
    const after = plan(
      [assignment],
      [action("draft", "assignment", 240, { remainingMinutes: 460 })],
      [window("day", 0, 8 * HOUR)]
    ).forecasts[0]!;
    expect(before.health).toBe("on_track");
    expect(["at_risk", "behind"]).toContain(after.health);
    expect(after.protectedRemainingMinutes!).toBeGreaterThan(before.protectedRemainingMinutes!);
  });

  it("shortens an overrunning low-value session to protect urgent study", () => {
    // Cleaning is running now; study is due in five hours and needs 175 (padded to 202) of the 300 minutes left (a longer run would cost it its margin, not just its deadline).
    const cleaning = project("cleaning", 48 * HOUR, { consequence: 1, value: 1 });
    const study = project("study", 5 * HOUR, { consequence: 5, value: 5 });
    const clean = action("clean", "cleaning", 240, {
      energy: "low",
      maximumSessionMinutes: 240,
      remainingMinutes: 180
    });
    const actions = [clean, action("study-draft", "study", 175, { maximumSessionMinutes: 240 })];
    const shared = {
      now,
      horizonEnd: at(5 * HOUR),
      projects: [cleaning, study],
      capacityWindows: [window("evening", 0, 5 * HOUR)],
      commitments: [],
      actionId: "clean"
    };

    // The full 180 minutes would leave study short, so the largest safe timebox is offered instead.
    const reduced = simulateContinuation({ ...shared, actions, requestedMinutes: 180 });
    expect(reduced.safe).toBe(true);
    expect(reduced.recommendedMinutes).toBe(45);
    expect(reduced.recommendedMinutes).toBeLessThan(180);

    // When cleaning cannot be split below 180, there is no safe timebox and study is named.
    const indivisible = simulateContinuation({
      ...shared,
      actions: [{ ...clean, minimumSessionMinutes: 180 }, actions[1]!],
      requestedMinutes: 180
    });
    expect(indivisible.safe).toBe(false);
    expect(indivisible.displacedProjectIds).toContain("study");
    expect(indivisible.reason).toContain("more urgent");
  });

  it("offers no extension to an overrunning low-value session when study has little margin", () => {
    // Study needs 240 of the 300 minutes left (25% margin). Any extension drops it to at risk.
    const cleaning = project("cleaning", 48 * HOUR, { consequence: 1, value: 1 });
    const study = project("study", 5 * HOUR, { consequence: 5, value: 5 });
    const clean = action("clean", "cleaning", 240, {
      energy: "low",
      maximumSessionMinutes: 240,
      remainingMinutes: 180
    });
    const result = simulateContinuation({
      now,
      horizonEnd: at(5 * HOUR),
      projects: [cleaning, study],
      capacityWindows: [window("evening", 0, 5 * HOUR)],
      commitments: [],
      actions: [clean, action("study-draft", "study", 240, { maximumSessionMinutes: 240 })],
      actionId: "clean",
      requestedMinutes: 180
    });
    expect(result.safe).toBe(false);
    expect(result.recommendedMinutes).toBe(0);
    expect(result.displacedProjectIds).toContain("study");
    expect(result.reason).toContain("more urgent");
  });

  it("gives one high-focus window to the nearer deadline and leaves the other unallocated", () => {
    const early = project("early", 2 * HOUR);
    const late = project("late", 48 * HOUR);
    const schedule = plan(
      [late, early],
      [
        action("early-work", "early", 120, { maximumSessionMinutes: 120 }),
        action("late-work", "late", 120, { maximumSessionMinutes: 120 })
      ],
      [window("focus", 0, 2 * HOUR)]
    );
    const earlyMinutes = schedule.allocations
      .filter((block) => block.projectId === "early")
      .reduce((sum, block) => sum + block.minutes, 0);
    expect(earlyMinutes).toBe(120);
    // The single window is exhausted by the nearer deadline, so the later project reserves nothing in it.
    expect(
      schedule.allocations.filter((block) => block.projectId === "late" && block.startsAt < at(2 * HOUR))
    ).toHaveLength(0);
  });

  it("replans capacity when a fixed commitment appears", () => {
    const study = project("study", 4 * HOUR);
    const actions = [action("draft", "study", 150)];
    const free = plan([study], actions, [window("evening", 0, 4 * HOUR)]).forecasts[0]!;
    const booked = plan(
      [study],
      actions,
      [window("evening", 0, 4 * HOUR)],
      [{ id: "dinner", startsAt: at(60), endsAt: at(180) }]
    ).forecasts[0]!;
    expect(free.health).toBe("on_track");
    expect(booked.compatibleCapacityMinutes!).toBeLessThan(free.compatibleCapacityMinutes!);
    expect(booked.health).toBe("behind");
  });

  it("explains the constraint when nothing matches the current energy", () => {
    const study = project("study", 6 * HOUR);
    const result = next([study], [action("deep-work", "study", 120)], [window("evening", 0, 6 * HOUR, "low")], [], {
      currentEnergy: "low"
    });
    expect(result.primary).toBeNull();
    expect(result.evidence.some((item) => item.includes("Current energy is low"))).toBe(true);
  });

  it("does not recommend work whose dependency is still open, however urgent", () => {
    const study = project("study", 3 * HOUR, { consequence: 5, value: 5 });
    const actions = [
      action("prepare", "study", 60, { status: "blocked" }),
      action("write", "study", 60, { dependencyIds: ["prepare"], dependenciesComplete: false })
    ];
    const result = next([study], actions, [window("evening", 0, 3 * HOUR)]);
    expect(result.primary).toBeNull();
    expect(result.candidates.find((item) => item.action.id === "write")?.exclusionReasons).toContain(
      "A dependency is incomplete."
    );
  });

  it("recommends a session that ends before the next commitment", () => {
    const study = project("study", 6 * HOUR);
    const result = next(
      [study],
      [action("draft", "study", 120, { minimumSessionMinutes: 30, maximumSessionMinutes: 60 })],
      [window("evening", 0, 6 * HOUR)],
      [{ id: "class", startsAt: at(45), endsAt: at(90) }]
    );
    expect(result.primary?.recommendedMinutes).toBe(45);
  });
});
