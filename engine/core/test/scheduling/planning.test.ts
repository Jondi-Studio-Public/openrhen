import { describe, expect, it } from "vitest";
import { compatibleCapacityMinutes, forecastProject, recommend } from "../../src/index.js";
import type { Action, CapacityWindow, Project } from "../../src/index.js";
import { holding } from "../model/situation.js";

const now = new Date("2026-08-07T07:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

const project: Project = {
  id: "project-study",
  status: "active",
  uncertainty: "known",
  internalDeadlineAt: at(7 * 24 * 60),
  value: 5,
  consequence: 5
};

function action(overrides: Partial<Action> = {}): Action {
  // Effort's baseline is `expectedMinutes`, so a case that overrides `remainingMinutes` alone (to
  // exercise the PERT/uncertainty math against a different remaining figure) must move the estimate
  // with it, exactly as the pre-#19 `expectedMinutes ?? remainingMinutes` fallback used to.
  const remainingMinutes = overrides.remainingMinutes ?? 60;
  return {
    id: "action-study",
    projectId: project.id,
    title: "Draft networking section one",
    status: "active",
    expectedMinutes: remainingMinutes,
    remainingMinutes,
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

function window(minutes: number, energy: CapacityWindow["energy"] = "high", usableFraction = 1): CapacityWindow {
  return { id: `window-${minutes}-${energy}`, startsAt: now, endsAt: at(minutes), energy, usableFraction };
}

describe("capacity", () => {
  it("subtracts overlapping commitments once", () => {
    const capacity = compatibleCapacityMinutes({
      from: now,
      until: at(180),
      requiredEnergy: "high",
      capacityWindows: [window(180)],
      commitments: [
        { id: "one", startsAt: at(30), endsAt: at(90) },
        { id: "two", startsAt: at(60), endsAt: at(120) }
      ]
    });
    expect(capacity).toBe(90);
  });
});

describe("forecasting", () => {
  it("marks a project behind when protected work exceeds compatible capacity", () => {
    const forecast = forecastProject({
      project: { ...project, uncertainty: "known", internalDeadlineAt: at(300) },
      actions: [action({ remainingMinutes: 313, pessimisticMinutes: 360 })],
      now,
      capacityWindows: [window(300)],
      commitments: []
    });
    expect(forecast.protectedRemainingMinutes).toBe(360);
    expect(forecast.expectedMarginMinutes).toBe(-60);
    expect(forecast.health).toBe("behind");
  });

  it("marks a project at risk when expected work fits but pessimistic work does not", () => {
    const forecast = forecastProject({
      project: { ...project, uncertainty: "known", internalDeadlineAt: at(340) },
      actions: [action({ remainingMinutes: 260, pessimisticMinutes: 420 })],
      now,
      capacityWindows: [window(340)],
      commitments: []
    });
    expect(forecast.protectedRemainingMinutes).toBe(299);
    expect(forecast.expectedMarginMinutes).toBe(41);
    expect(forecast.pessimisticMarginMinutes).toBe(-80);
    expect(forecast.health).toBe("at_risk");
  });
});

describe("recommendations", () => {
  it("fits a session before a commitment", () => {
    const forecast = forecastProject({
      project,
      actions: [action()],
      now,
      capacityWindows: [window(180)],
      commitments: []
    });
    const result = recommend({
      now,
      horizonEnd: at(180),
      actions: [action()],
      projects: [project],
      forecasts: [forecast],
      capacityWindows: [window(180)],
      commitments: [{ id: "class", startsAt: at(45), endsAt: at(90) }],
      ...holding("laptop")
    });
    expect(result.primary?.recommendedMinutes).toBe(45);
  });

  it("rejects an action when the minimum useful session does not fit", () => {
    const forecast = forecastProject({
      project,
      actions: [action()],
      now,
      capacityWindows: [window(20)],
      commitments: []
    });
    const result = recommend({
      now,
      horizonEnd: at(20),
      actions: [action()],
      projects: [project],
      forecasts: [forecast],
      capacityWindows: [window(20)],
      commitments: [],
      ...holding("laptop")
    });
    expect(result.primary).toBeNull();
    expect(result.candidates[0]?.exclusionReasons[0]).toContain("20 compatible minutes");
  });

  it("does not spend low-energy capacity on high-focus work", () => {
    const forecast = forecastProject({
      project,
      actions: [action()],
      now,
      capacityWindows: [window(120, "low")],
      commitments: []
    });
    const result = recommend({
      now,
      horizonEnd: at(120),
      actions: [action()],
      projects: [project],
      forecasts: [forecast],
      capacityWindows: [window(120, "low")],
      commitments: [],
      ...holding("laptop")
    });
    expect(result.primary).toBeNull();
  });

  it("is deterministic for identical inputs", () => {
    const second = action({ id: "action-clean", title: "Clear the desk", energy: "low", contexts: ["home"] });
    const lowWindow = window(120, "high");
    const forecast = forecastProject({
      project,
      actions: [action(), second],
      now,
      capacityWindows: [lowWindow],
      commitments: []
    });
    const input = {
      now,
      horizonEnd: at(120),
      actions: [second, action()],
      projects: [project],
      forecasts: [forecast],
      capacityWindows: [lowWindow],
      commitments: [],
      ...holding("home", "laptop")
    };
    expect(recommend(input)).toEqual(recommend(input));
  });
});
