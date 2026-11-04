import { describe, expect, it } from "vitest";
import {
  assessCritical,
  effectiveDeadline,
  planSchedule,
  recommend,
  resolvePlanningCapacity
} from "../../src/index.js";
import type { Action, CapacityWindow, Project } from "../../src/index.js";

// an undated once action is open work — it ranks in the ordinary tier with zero proximity,
// never appears in an overdue tier, and still inherits its project's date through `effectiveDeadline`
// when the project has one. See the open work design note.

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

function project(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    status: "active",
    uncertainty: "known",
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
    schedule,
    candidate: (id: string) => result.candidates.find((item) => item.action.id === id)!
  };
}

describe("open work: an undated once action", () => {
  it("ranks ordinary with no reason and zero capacity pressure, and is eligible when a window is free", () => {
    const undated = project("undated");
    const actions = [action("errand", "undated", 60)];
    const { result, candidate } = rank([undated], actions);
    const errand = candidate("errand");
    expect(errand.criticalTier).toBe("ordinary");
    expect(errand.criticalReason).toBeUndefined();
    // capacityPressure is urgency (proximity when unforecastable) rounded into the score weight — zero
    // when there is no deadline anywhere to be proximate to.
    expect(errand.scoreComponents.capacityPressure).toBe(0);
    expect(errand.eligible).toBe(true);
    expect(result.primary?.action.id).toBe("errand");
  });

  it("inherits a dated project's deadline through effectiveDeadline and can reach at_risk", () => {
    // Mirrors the "prefers an at-risk project" fixture in ranking.test.ts, but the action itself
    // carries no date at all — only the project does, and only as an externally committed one.
    const tight = project("tight", { externalDeadlineAt: days(2) });
    const actions = [action("errand", "tight", 1_400)];
    const { result, schedule, candidate } = rank([tight], actions);
    const forecast = schedule.forecasts.find((item) => item.projectId === "tight");
    // The action carries no date of its own, so effectiveDeadline falls through to the forecast the
    // project's external date produced — the project's promise, not an invented one.
    expect(forecast?.internalDeadlineAt).toBeDefined();
    expect(effectiveDeadline({ action: actions[0]!, project: tight, forecast })).toEqual(forecast!.internalDeadlineAt);
    expect(["behind", "at_risk"]).toContain(forecast!.health);
    expect(candidate("errand").criticalTier).not.toBe("ordinary");
    expect(result.primary?.action.id).toBe("errand");
  });

  it("never lands in an overdue tier, whatever now is", () => {
    const undated = project("undated");
    const errand = action("errand", "undated", 60);
    for (const at of [now, days(-3_650), days(3_650)]) {
      const assessment = assessCritical({ now: at, action: errand, project: undated, forecast: undefined });
      expect(assessment.tier).not.toBe("overdue_external");
      expect(assessment.tier).not.toBe("stale_date");
      expect(assessment.tier).toBe("ordinary");
    }
  });
});
