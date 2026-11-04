import { describe, expect, it } from "vitest";
import { planSchedule, simulateContinuation } from "../../src/index.js";
import type { Action, CapacityWindow, Project, ProjectForecast } from "../../src/index.js";
import { gotWorse } from "../../src/recommendation/continuation.js";

// Friday 07:00 UTC. Explicit windows so each case states its own capacity.
const now = new Date("2026-08-07T07:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
const HOUR = 60;

function project(id: string, overrides: Partial<Project> = {}): Project {
  return { id, status: "active", uncertainty: "known", value: 3, consequence: 3, outcomeActive: true, ...overrides };
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

const window = (): CapacityWindow => ({
  id: "day",
  startsAt: at(0),
  endsAt: at(8 * HOUR),
  energy: "high",
  contexts: [],
  usableFraction: 1
});

function simulate(studyMinutes: number, study: Project) {
  const cleaning = project("cleaning", { internalDeadlineAt: at(48 * HOUR), consequence: 1, value: 1 });
  const actions = [
    action("clean", "cleaning", 240, { energy: "low", remainingMinutes: 180 }),
    action("study-draft", "study", studyMinutes)
  ];
  const shared = {
    now,
    horizonEnd: at(8 * HOUR),
    projects: [cleaning, study],
    capacityWindows: [window()],
    commitments: [],
    actions
  };
  const baseline = planSchedule(shared).forecasts.find((forecast) => forecast.projectId === "study")!;
  return { baseline, result: simulateContinuation({ ...shared, actionId: "clean", requestedMinutes: 180 }) };
}

/**
 * Keeping going is judged against the same ordering as the main ranking: a project is protected from
 * the moment its health gets worse (on track to at risk, not only to behind), and its effective
 * deadline is its internal date, falling back to its external one.
 */
describe("continuation displacement", () => {
  it("stops at the largest timebox that keeps an urgent project from slipping to at risk", () => {
    const { baseline, result } = simulate(300, project("study", { internalDeadlineAt: at(8 * HOUR), consequence: 5 }));
    expect(baseline.health).toBe("on_track");
    expect(result.safe).toBe(true);
    expect(result.recommendedMinutes).toBe(60);
  });

  it("protects a project whose only deadline is external", () => {
    const { baseline, result } = simulate(300, project("study", { externalDeadlineAt: at(8 * HOUR), consequence: 5 }));
    expect(baseline.health).toBe("on_track");
    expect(result.safe).toBe(false);
    expect(result.displacedProjectIds).toContain("study");
  });

  it("counts only a drop into at risk or behind, not ahead easing to on track", () => {
    const health = (value: ProjectForecast["health"]) => ({ health: value }) as ProjectForecast;
    expect(gotWorse(health("ahead"), health("on_track"))).toBe(false);
    expect(gotWorse(health("on_track"), health("on_track"))).toBe(false);
    expect(gotWorse(health("on_track"), health("at_risk"))).toBe(true);
    expect(gotWorse(health("ahead"), health("at_risk"))).toBe(true);
    expect(gotWorse(health("at_risk"), health("behind"))).toBe(true);
    expect(gotWorse(undefined, health("behind"))).toBe(false);
  });
});
