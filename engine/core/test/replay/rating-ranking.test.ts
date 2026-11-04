import { describe, expect, it } from "vitest";
import { planSchedule, recommend, resolvePlanningCapacity, scoreWeights } from "../../src/index.js";
import type { Action, CapacityWindow, Project } from "../../src/index.js";

/**
 * an action's own `importance` and `consequence` must discriminate within a project without
 * ever letting `importance` reorder two actions in different projects. These are the three tests the
 * design note requires before any weight is chosen: the
 * default-inert test first, then the within-project ordering test, then the cross-project bound.
 */

const now = new Date("2026-08-07T07:00:00.000Z");
const DAY_MS = 86_400_000;
const days = (count: number) => new Date(now.getTime() + count * DAY_MS);
const horizonEnd = days(180);
const dayBounds = { timezone: "Australia/Sydney", dayStartTime: "07:00", dayEndTime: "22:00" };

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
    currentEnergy: "high",
    ...overrides
  });
  return {
    result,
    candidateOf: (id: string) => result.candidates.find((item) => item.action.id === id)!
  };
}

describe("action ratings rank within a project without reordering projects", () => {
  it("scores a fully unrated action/project identically to the earlier formula (default-inert)", () => {
    // Every column is at its schema default of 3 (project.value, project.consequence,
    // action.importance, action.consequence). Pre-this action scored consequence =
    // normalizeFive(max(3, 3)) * 15 = 8, outcomeValue = normalizeFive(3) * 15 = 8, and carried no
    // importance component at all. If this fails, the arithmetic is wrong regardless of any weight.
    const projects = [project("solo", 60)];
    const actions = [action("solo-work", "solo", 60)];
    const { candidateOf } = rank(projects, actions);
    const candidate = candidateOf("solo-work");
    expect(candidate.scoreComponents.consequence).toBe(8);
    expect(candidate.scoreComponents.outcomeValue).toBe(8);
    expect(candidate.scoreComponents.importance).toBe(0);
  });

  it("stays byte-identical across a whole unrated plan, several projects at once", () => {
    const projects = [project("a", 20), project("b", 45), project("c", null)];
    const actions = [action("a-work", "a", 60), action("b-work", "b", 90), action("c-work", "c", 30)];
    const { result } = rank(projects, actions);
    for (const candidate of result.candidates) {
      expect(candidate.scoreComponents.consequence, candidate.action.id).toBe(8);
      expect(candidate.scoreComponents.outcomeValue, candidate.action.id).toBe(8);
      expect(candidate.scoreComponents.importance, candidate.action.id).toBe(0);
    }
  });

  it("lets a highly-rated action outrank a barely-rated sibling in the same project", () => {
    // Property 1: project 5 / action 5 ranks above project 5 / action 2, same everything else.
    const projects = [project("shared", 60, { value: 5, consequence: 5 })];
    const actions = [
      action("fragile", "shared", 60, { importance: 5, consequence: 5, lastWorkedAt: now }),
      action("safe", "shared", 60, { importance: 2, consequence: 2, lastWorkedAt: now })
    ];
    const { candidateOf } = rank(projects, actions);
    const fragile = candidateOf("fragile");
    const safe = candidateOf("safe");
    expect(fragile.totalScore).toBeGreaterThan(safe.totalScore);
    // The action's own consequence rating must be doing some of that work, not just importance.
    expect(fragile.scoreComponents.consequence!).toBeGreaterThan(safe.scoreComponents.consequence!);
    expect(fragile.scoreComponents.importance!).toBeGreaterThan(safe.scoreComponents.importance!);
  });

  it("never lets importance alone flip the order between two differently-valued projects", () => {
    // Property 2, made executable: the tightest adjacent gap in the rounded outcomeValue ladder
    // (value 3 -> 8, value 4 -> 11) is 3 points. Importance is set to fight the ordering as hard as
    // it can: the lower-value project's action rated 5, the higher-value project's action rated 1.
    // Everything else — consequence, deadline, neglect, energy — is held equal so only the two new
    // terms can move the total.
    const projects = [
      project("low-value", 60, { value: 3, consequence: 3 }),
      project("high-value", 60, { value: 4, consequence: 3 })
    ];
    const actions = [
      action("low-value-work", "low-value", 60, { importance: 5, consequence: 3 }),
      action("high-value-work", "high-value", 60, { importance: 1, consequence: 3 })
    ];
    const { candidateOf } = rank(projects, actions);
    const low = candidateOf("low-value-work");
    const high = candidateOf("high-value-work");
    expect(high.totalScore).toBeGreaterThan(low.totalScore);
    expect(high.scoreComponents.outcomeValue!).toBeGreaterThan(low.scoreComponents.outcomeValue!);
  });

  it("bounds the importance weight: the current weight preserves the gap, one point higher does not", () => {
    // Executable version of the bound without touching scoreWeights at runtime: the same rounding
    // rule score.ts uses for the importance component, checked against the tightest adjacent gap in
    // the rounded outcomeValue ladder (0, 4, 8, 11, 15 -> minimum gap 3, between value 3 and 4).
    const normalizeFive = (value: number) => (Math.min(5, Math.max(1, value)) - 1) / 4;
    const importanceTerm = (importance: number, weight: number) =>
      Math.round((normalizeFive(importance) - 0.5) * weight);
    const outcomeValueLadder = [1, 2, 3, 4, 5].map((v) => Math.round(normalizeFive(v) * scoreWeights.outcomeValue));
    const minAdjacentGap = Math.min(...outcomeValueLadder.slice(1).map((v, i) => v - outcomeValueLadder[i]!));
    const swingAt = (weight: number) => {
      const terms = [1, 2, 3, 4, 5].map((i) => importanceTerm(i, weight));
      return Math.max(...terms) - Math.min(...terms);
    };

    expect(scoreWeights.importance).toBe(2);
    expect(swingAt(scoreWeights.importance)).toBeLessThan(minAdjacentGap);
    // One point higher and the worst-case pair (value 3/importance 5 vs value 4/importance 1) ties
    // instead of value strictly winning — the bound this plan's property 2 asked to be demonstrated,
    // not assumed.
    expect(swingAt(scoreWeights.importance + 1)).toBeGreaterThanOrEqual(minAdjacentGap);
  });

  it("does not double-count importance for cadence, which already reads it via cadenceDue", () => {
    const projects = [project("habit", null, { value: 3, consequence: 3 })];
    const actions = [
      action("cadence-action", "habit", 30, {
        importance: 5,
        minimumSessionMinutes: 15,
        schedulingMode: "cadence",
        cadence: {
          intervalDays: 1,
          timezone: "Australia/Sydney",
          startDate: "2026-08-01",
          lastCompletedLocalDate: "2026-08-06",
          completionCount: 1
        },
        availableFrom: now
      })
    ];
    const { candidateOf } = rank(projects, actions);
    expect(candidateOf("cadence-action").scoreComponents.importance).toBe(0);
  });
});
