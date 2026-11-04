import { describe, expect, it } from "vitest";
import { calculateActionEffort, projectEffort } from "../../src/index.js";
import type { Action, Project } from "../../src/index.js";
import { deliverableForecastUnits } from "../../src/scheduling/deliverables.js";
import type { DeliverableProjection } from "@openrhen/contracts";

const project: Project = { id: "p", status: "active", uncertainty: "known", value: 3, consequence: 3 };

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: "a",
    projectId: "p",
    title: "a",
    status: "active",
    optimisticMinutes: 45,
    expectedMinutes: 60,
    pessimisticMinutes: 90,
    remainingMinutes: 60,
    energy: "high",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 60,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependenciesComplete: true,
    setupMinutes: 0,
    ...overrides
  };
}

describe("effort estimation", () => {
  it("scales a re-estimate linearly rather than quadratically", () => {
    // 45/60/90 gives a risk-adjusted total of 71 minutes.
    expect(calculateActionEffort(action({ remainingMinutes: 60 }), project).pessimisticRemainingMinutes).toBe(90);
    expect(calculateActionEffort(action({ remainingMinutes: 120 }), project).pessimisticRemainingMinutes).toBe(180);
    expect(calculateActionEffort(action({ remainingMinutes: 240 }), project).pessimisticRemainingMinutes).toBe(360);
  });

  it("keeps protected remaining effort proportional to the revised estimate", () => {
    // Unrounded risk-adjusted total is 70.3 minutes, so one unit ceils to 71 and four ceil to 282.
    const single = calculateActionEffort(action({ remainingMinutes: 60 }), project);
    const quadruple = calculateActionEffort(action({ remainingMinutes: 240 }), project);
    expect(single.riskAdjustedRemainingMinutes).toBe(71);
    expect(quadruple.riskAdjustedRemainingMinutes).toBe(282);
    expect(quadruple.pessimisticRemainingMinutes).toBeGreaterThanOrEqual(quadruple.riskAdjustedRemainingMinutes);
  });

  it("never reports pessimistic effort below the revised remaining estimate", () => {
    const effort = calculateActionEffort(
      action({ optimisticMinutes: 10, expectedMinutes: 20, pessimisticMinutes: 21, remainingMinutes: 200 }),
      project
    );
    expect(effort.pessimisticRemainingMinutes).toBeGreaterThanOrEqual(200);
  });

  it("flags a re-estimate that moves the baseline", () => {
    expect(calculateActionEffort(action({ remainingMinutes: 60 }), project).remainingExceedsBaseline).toBe(false);
    expect(calculateActionEffort(action({ remainingMinutes: 61 }), project).remainingExceedsBaseline).toBe(true);
  });

  it("keeps the estimation method fixed as remaining effort falls below optimistic", () => {
    const fresh = calculateActionEffort(action({ remainingMinutes: 60 }), project);
    const nearlyDone = calculateActionEffort(action({ remainingMinutes: 5 }), project);
    expect(fresh.method).toBe("pert");
    expect(nearlyDone.method).toBe("pert");
    expect(nearlyDone.expectedMinutes).toBe(fresh.expectedMinutes);
  });

  it("falls back to the uncertainty multiplier only when the three-point estimate is unusable", () => {
    const { optimisticMinutes: _omitted, ...withoutOptimistic } = action({
      pessimisticMinutes: 90,
      remainingMinutes: 60
    });
    const noRange = calculateActionEffort(withoutOptimistic, project);
    expect(noRange.method).toBe("uncertainty_multiplier");
    expect(noRange.riskAdjustedRemainingMinutes).toBe(69);
    const inverted = calculateActionEffort(
      action({ optimisticMinutes: 70, expectedMinutes: 60, pessimisticMinutes: 90 }),
      project
    );
    expect(inverted.method).toBe("uncertainty_multiplier");
  });

  it("adds setup minutes once and drops them when nothing remains", () => {
    expect(calculateActionEffort(action({ setupMinutes: 10 }), project).riskAdjustedRemainingMinutes).toBe(81);
    expect(
      calculateActionEffort(action({ setupMinutes: 10, remainingMinutes: 0 }), project).riskAdjustedRemainingMinutes
    ).toBe(0);
  });

  it("distributes a project override without exceeding it", () => {
    const totals = projectEffort(
      [action({ id: "one", remainingMinutes: 60 }), action({ id: "two", remainingMinutes: 30 })],
      { ...project, remainingEffortOverrideMinutes: 100 }
    );
    expect(totals.riskAdjustedMinutes).toBe(100);
    expect(
      totals.efforts.every((effort) => effort.pessimisticRemainingMinutes >= effort.riskAdjustedRemainingMinutes)
    ).toBe(true);
  });
});

describe("learned calibration", () => {
  const calibrated: Project = { ...project, estimateCalibration: { factor: 1.5, samples: 6, scope: "area" } };

  it("scales protected, expected and pessimistic effort by the learned factor once", () => {
    const plain = calculateActionEffort(action(), project);
    const scaled = calculateActionEffort(action(), calibrated);
    expect(scaled.calibrationFactor).toBe(1.5);
    expect(plain.calibrationFactor).toBe(1);
    expect(scaled.expectedMinutes).toBeCloseTo(plain.expectedMinutes * 1.5, 2);
    expect(scaled.pessimisticRemainingMinutes).toBe(135);
    // The factor scales the mean only (62.5 × 1.5) and the padding stays the PERT spread
    // (1.04 × 7.5), so the figure is 101.55, ceiled; it used to be 106 with the padding scaled too.
    expect(scaled.riskAdjustedRemainingMinutes).toBe(102);
    // The stored baseline still decides how much of it remains.
    expect(calculateActionEffort(action({ remainingMinutes: 30 }), calibrated).riskAdjustedRemainingMinutes).toBe(51);
  });
});

describe("single-figure estimates", () => {
  const single = (minutes: number) =>
    action({
      optimisticMinutes: minutes,
      expectedMinutes: minutes,
      pessimisticMinutes: minutes,
      remainingMinutes: minutes
    });

  it("pads a single-figure action by a high-uncertainty project's multiplier", () => {
    const effort = calculateActionEffort(single(100), { ...project, uncertainty: "high" });
    expect(effort.method).toBe("uncertainty_multiplier");
    expect(effort.riskAdjustedMinutes).toBe(160);
    expect(effort.riskAdjustedRemainingMinutes).toBe(160);
  });

  it("pads a single-figure action by a known-uncertainty project's smaller multiplier", () => {
    const effort = calculateActionEffort(single(100), project);
    expect(effort.method).toBe("uncertainty_multiplier");
    expect(effort.riskAdjustedMinutes).toBe(115);
  });

  it("still uses PERT for an action that states a real range", () => {
    const effort = calculateActionEffort(action(), { ...project, uncertainty: "high" });
    expect(effort.method).toBe("pert");
    expect(effort.riskAdjustedMinutes).toBe(71);
  });

  it("pads a deliverable's forecast unit the same way", () => {
    const projection = {
      id: "d",
      projectId: "p",
      title: "d",
      status: "in_progress",
      approved: true,
      remainingMinutes: 100,
      dependenciesSatisfied: true,
      executionOptions: [],
      importance: 3,
      consequence: 3
    } as unknown as DeliverableProjection;
    const [unit] = deliverableForecastUnits([projection]);
    const effort = calculateActionEffort(unit!, { ...project, uncertainty: "high" });
    expect(effort.method).toBe("uncertainty_multiplier");
    expect(effort.riskAdjustedRemainingMinutes).toBe(160);
  });
});
