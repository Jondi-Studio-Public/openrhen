import { describe, expect, it } from "vitest";
import { forecastProject } from "../../src/index.js";
import type { Action, CapacityWindow, Project } from "../../src/index.js";

/**
 * before the pace baseline was derived, nothing ever set `actualCompletionRatio` /
 * `requiredCompletionRatio` on a real project, so `scheduleVariance` was always `null` and
 * `classifyHealth`'s "ahead" branch (`engine/core/src/scheduling/schedule.ts`) was dead code no test
 * could reach honestly. These pin it now that the database layer derives the two ratios
 * (`platform/database/src/planning/completion-ratios.ts`) and passes them through unchanged.
 */

const now = new Date("2026-08-07T07:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

const project: Project = {
  id: "project-pace",
  status: "active",
  uncertainty: "known",
  internalDeadlineAt: at(500),
  value: 5,
  consequence: 5
};

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: "action-pace",
    projectId: project.id,
    title: "Ample work with ample capacity",
    status: "active",
    expectedMinutes: 60,
    remainingMinutes: 60,
    pessimisticMinutes: 90,
    energy: "high",
    minimumSessionMinutes: 30,
    maximumSessionMinutes: 60,
    importance: 5,
    consequence: 5,
    contexts: ["laptop"],
    dependenciesComplete: true,
    ...overrides
  };
}

const capacityWindows: CapacityWindow[] = [
  { id: "window", startsAt: now, endsAt: at(500), energy: "high", usableFraction: 1 }
];

describe("schedule health from derived pace", () => {
  it("reaches ahead when margin is healthy and variance is comfortably positive", () => {
    const forecast = forecastProject({
      project: { ...project, actualCompletionRatio: 0.5, requiredCompletionRatio: 0.3 },
      actions: [action()],
      now,
      capacityWindows,
      commitments: []
    });
    expect(forecast.expectedMarginMinutes).toBeGreaterThan(0);
    expect(forecast.unallocatedExpectedMinutes).toBe(0);
    expect(forecast.scheduleVariance).toBeCloseTo(0.2, 5);
    expect(forecast.health).toBe("ahead");
    expect(forecast.reasons).toContain("Done 50% of the work with 30% of the time used.");
  });

  it("stays at_risk on a negative variance even though margin alone looks healthy", () => {
    const forecast = forecastProject({
      project: { ...project, actualCompletionRatio: 0.1, requiredCompletionRatio: 0.3 },
      actions: [action()],
      now,
      capacityWindows,
      commitments: []
    });
    expect(forecast.expectedMarginMinutes).toBeGreaterThan(0);
    expect(forecast.unallocatedExpectedMinutes).toBe(0);
    expect(forecast.scheduleVariance).toBeCloseTo(-0.2, 5);
    expect(forecast.health).toBe("at_risk");
    expect(forecast.reasons).toContain("Done 10% of the work with 30% of the time used.");
  });

  it("stays on_track — never ahead — when the ratios are not present at all", () => {
    const forecast = forecastProject({
      project,
      actions: [action()],
      now,
      capacityWindows,
      commitments: []
    });
    expect(forecast.scheduleVariance).toBeNull();
    expect(forecast.health).not.toBe("ahead");
    expect(forecast.reasons.some((reason) => reason.startsWith("Done "))).toBe(false);
  });

  it("a variance inside the ahead band but with thin margin still reads at_risk", () => {
    const forecast = forecastProject({
      project: { ...project, actualCompletionRatio: 0.9, requiredCompletionRatio: 0.1 },
      actions: [action({ remainingMinutes: 430, pessimisticMinutes: 460, maximumSessionMinutes: 430 })],
      now,
      capacityWindows,
      commitments: []
    });
    expect(forecast.marginRatio).toBeLessThan(0.5);
    expect(forecast.scheduleVariance).toBeCloseTo(0.8, 5);
    expect(forecast.health).not.toBe("ahead");
  });
});

describe("required weekly pace (F1-10)", () => {
  it("reports no pace for a project whose deadline has passed", () => {
    const forecast = forecastProject({
      project: { ...project, internalDeadlineAt: at(-24 * 60) },
      actions: [
        action({ expectedMinutes: 120, remainingMinutes: 120, pessimisticMinutes: 120, maximumSessionMinutes: 120 })
      ],
      now,
      capacityWindows,
      commitments: []
    });
    expect(forecast.overdue).toBe(true);
    expect(forecast.requiredPaceMinutesPerWeek).toBeNull();
    expect(forecast.reasons.some((reason) => reason.startsWith("Required pace is"))).toBe(false);
  });

  it("still reports a pace against a future deadline", () => {
    const forecast = forecastProject({ project, actions: [action()], now, capacityWindows, commitments: [] });
    expect(forecast.requiredPaceMinutesPerWeek).toBeGreaterThan(0);
  });
});
