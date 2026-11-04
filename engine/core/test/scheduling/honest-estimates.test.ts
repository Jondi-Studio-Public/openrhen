import { describe, expect, it } from "vitest";
import { calculateActionEffort, forecastProject, planSchedule, projectEffort } from "../../src/index.js";
import type { Action, CapacityWindow, Project } from "../../src/index.js";

const now = new Date("2026-08-07T07:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
const project: Project = {
  id: "p",
  status: "active",
  uncertainty: "known",
  internalDeadlineAt: at(30 * 24 * 60),
  value: 3,
  consequence: 3
};

function action(id: string, overrides: Partial<Action> = {}): Action {
  return {
    id,
    projectId: "p",
    title: id,
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

/** No optimistic figure, so the three-point range is unusable and the uncertainty multiplier applies. */
function plain(id: string, overrides: Partial<Action> = {}): Action {
  const { optimisticMinutes: _optimistic, ...rest } = action(id, overrides);
  return rest;
}

function window(minutes: number, from = 0): CapacityWindow {
  return {
    id: `w-${from}-${minutes}`,
    startsAt: at(from),
    endsAt: at(from + minutes),
    energy: "high",
    usableFraction: 1
  };
}

describe("project effort adds in quadrature", () => {
  const twelve = Array.from({ length: 12 }, (_, index) => action(`a${index}`));

  it("is not the sum of each action's own p85", () => {
    const total = projectEffort(twelve, project);
    const single = calculateActionEffort(twelve[0]!, project);
    const linear = twelve.length * single.riskAdjustedRemainingMinutes;
    // Mean 62.5, sd 7.5 each: 12 × 62.5 + 1.04 × 7.5 × sqrt(12).
    expect(total.riskAdjustedMinutes).toBe(Math.ceil(12 * 62.5 + 1.04 * 7.5 * Math.sqrt(12)));
    expect(total.riskAdjustedMinutes).toBeLessThan(linear);
    expect(total.meanMinutes).toBeCloseTo(750, 5);
    expect(total.deviationMinutes).toBeCloseTo(7.5 * Math.sqrt(12), 5);
    expect(total.pessimisticMinutes).toBeGreaterThanOrEqual(total.riskAdjustedMinutes);
  });

  it("leaves a single action exactly as it was", () => {
    const only = projectEffort([action("only")], project);
    expect(only.riskAdjustedMinutes).toBe(calculateActionEffort(action("only"), project).riskAdjustedRemainingMinutes);
    expect(only.pessimisticMinutes).toBe(90);
  });

  it("derives a single-figure estimate's spread from its padding so it composes", () => {
    const effort = calculateActionEffort(plain("x"), project);
    // known × 1.15 or similar: mean 60, padded figure above it, sd = (padded - mean) / 1.04.
    expect(effort.remainingDeviationMinutes).toBeCloseTo((effort.riskAdjustedRemainingMinutes - 60) / 1.04, 0);
    const total = projectEffort([plain("x"), plain("y"), plain("z"), plain("w")], project);
    expect(total.riskAdjustedMinutes).toBeLessThan(4 * effort.riskAdjustedRemainingMinutes);
    expect(total.riskAdjustedMinutes).toBeGreaterThan(240);
  });

  it("keeps a project override authoritative", () => {
    const total = projectEffort(twelve, { ...project, remainingEffortOverrideMinutes: 900 });
    expect(total.riskAdjustedMinutes).toBe(900);
    expect(total.efforts.reduce((sum, effort) => sum + effort.riskAdjustedRemainingMinutes, 0)).toBe(900);
  });

  it("puts the mean and sd on the forecast and measures feasibility against the quadrature total", () => {
    const forecast = forecastProject({
      project,
      actions: twelve,
      now,
      capacityWindows: [window(2000)],
      commitments: []
    });
    const expected = projectEffort(twelve, project).riskAdjustedMinutes;
    expect(forecast.protectedRemainingMinutes).toBe(expected);
    expect(forecast.expectedRemainingMinutes).toBeCloseTo(750, 1);
    expect(forecast.remainingDeviationMinutes).toBeCloseTo(7.5 * Math.sqrt(12), 1);
    expect(forecast.expectedMarginMinutes).toBe(forecast.compatibleCapacityMinutes! - expected);
  });
});

describe("calibration scales the mean, not the padding", () => {
  const calibrated: Project = { ...project, estimateCalibration: { factor: 1.5, samples: 8, scope: "area" } };
  const single = (id: string) => plain(id);

  it("does not multiply the uncertainty padding by the factor", () => {
    const plain = calculateActionEffort(single("x"), project);
    const scaled = calculateActionEffort(single("x"), calibrated);
    const padding = plain.riskAdjustedRemainingMinutes / 60;
    // factor × mean × multiplier: the padding is the multiplier once, not stacked on the factor twice.
    expect(scaled.riskAdjustedRemainingMinutes).toBe(Math.ceil(1.5 * 60 * padding));
    expect(scaled.expectedMinutes).toBe(90);
  });

  it("uses a learned spread instead of the multiplier, never on top of it", () => {
    const learned: Project = {
      ...project,
      estimateCalibration: { factor: 1.5, samples: 8, scope: "area", spread: 1.2 }
    };
    expect(calculateActionEffort(single("x"), learned).riskAdjustedRemainingMinutes).toBe(Math.ceil(1.5 * 60 * 1.2));
    // A PERT action keeps its own stated range.
    expect(calculateActionEffort(action("x"), learned).riskAdjustedRemainingMinutes).toBe(
      calculateActionEffort(action("x"), calibrated).riskAdjustedRemainingMinutes
    );
  });
});

describe("a project with no deadline", () => {
  it("says so rather than reporting on track, and estimates a finish", () => {
    const { internalDeadlineAt: _removed, ...undated } = project;
    const forecast = planSchedule({
      now,
      horizonEnd: at(60 * 24 * 60),
      projects: [undated],
      actions: [action("a")],
      capacityWindows: [window(60 * 24 * 60)],
      commitments: [],
      focusedProjectIds: ["p"]
    }).forecasts[0]!;
    expect(forecast.deadlineSource).toBe("none");
    expect(forecast.health).toBe("unknown");
    expect(forecast.estimatedFinishAt).toBeInstanceOf(Date);
    expect(forecast.estimatedFinishAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(forecast.reasons[0]).toContain("No deadline is set");
  });

  it("names whose date a dated project is measured against", () => {
    const internal = forecastProject({
      project,
      actions: [action("a")],
      now,
      capacityWindows: [window(3000)],
      commitments: []
    });
    expect(internal.deadlineSource).toBe("internal");
    const { internalDeadlineAt: _removed, ...rest } = project;
    const external = forecastProject({
      project: { ...rest, externalDeadlineAt: at(30 * 24 * 60) },
      actions: [action("a")],
      now,
      capacityWindows: [window(3000)],
      commitments: []
    });
    expect(external.deadlineSource).toBe("external");
    const undated = forecastProject({
      project: rest,
      actions: [action("a")],
      now,
      capacityWindows: [window(3000)],
      commitments: []
    });
    expect(undated.deadlineSource).toBe("none");
    expect(undated.health).not.toBe("on_track");
  });
});

describe("setup is paid once per run", () => {
  const work = (setupMinutes: number) =>
    plain("big", {
      expectedMinutes: 240,
      remainingMinutes: 240,
      maximumSessionMinutes: 60,
      setupMinutes
    });
  // Four separate hours, so the work has to split into four runs.
  const windows = [0, 1, 2, 3, 4, 5].map((day) => window(60, day * 24 * 60 + 60));

  it("charges each run beyond the first", () => {
    const without = forecastProject({ project, actions: [work(0)], now, capacityWindows: windows, commitments: [] });
    const withSetup = forecastProject({ project, actions: [work(20)], now, capacityWindows: windows, commitments: [] });
    const once = projectEffort([work(20)], project).riskAdjustedMinutes;
    expect(withSetup.protectedRemainingMinutes!).toBeGreaterThan(once);
    expect((withSetup.protectedRemainingMinutes! - once) % 20).toBe(0);
    expect(withSetup.protectedRemainingMinutes! - without.protectedRemainingMinutes!).toBeGreaterThan(20);
  });

  it("charges nothing extra when the work fits one run", () => {
    const long = { ...work(20), maximumSessionMinutes: 400 };
    const one = forecastProject({
      project,
      actions: [long],
      now,
      capacityWindows: [window(2000, 60)],
      commitments: []
    });
    expect(one.protectedRemainingMinutes).toBe(projectEffort([long], project).riskAdjustedMinutes);
  });
});

describe("review fixes", () => {
  const day = 24 * 60;
  const dailyWindows = (days: number, from = 0) =>
    Array.from({ length: days }, (_, d) => window(180, (from + d) * day + 60));
  const big = (setupMinutes: number) =>
    plain("big", { expectedMinutes: 600, remainingMinutes: 600, maximumSessionMinutes: 60, setupMinutes });

  it("charges per-run setup for work placed in the aggregate bands too", () => {
    const horizonFor = (days: number) => ({ ...project, internalDeadlineAt: at(days * day) });
    const near = forecastProject({
      project: horizonFor(7),
      actions: [big(20)],
      now,
      capacityWindows: dailyWindows(7),
      commitments: []
    });
    const far = forecastProject({
      project: horizonFor(90),
      actions: [big(20)],
      now,
      capacityWindows: dailyWindows(90),
      commitments: []
    });
    const once = projectEffort([big(20)], project).riskAdjustedMinutes;
    expect(near.protectedRemainingMinutes!).toBeGreaterThan(once + 100);
    // Ten sessions of at most 60 minutes is the least a 600-minute action can be: nine more setups.
    expect(far.protectedRemainingMinutes!).toBeGreaterThanOrEqual(once + 9 * 20);
  });

  it("reads the same number in the reasons, the field and the pace", () => {
    const f = forecastProject({ project, actions: [big(20)], now, capacityWindows: dailyWindows(20), commitments: [] });
    expect(f.reasons[0]).toBe(`${f.protectedRemainingMinutes} risk-adjusted minutes remain.`);
  });

  it("estimates the finish from when capacity exists, not an even spread", () => {
    const { internalDeadlineAt: _removed, ...undated } = project;
    const forecast = planSchedule({
      now,
      horizonEnd: at(60 * day),
      projects: [undated],
      actions: [plain("a", { expectedMinutes: 600, remainingMinutes: 600 })],
      capacityWindows: dailyWindows(10, 50),
      commitments: [],
      focusedProjectIds: ["p"]
    }).forecasts[0]!;
    expect(forecast.estimatedFinishAt!.getTime()).toBeGreaterThanOrEqual(at(50 * day).getTime());
  });

  it("never gives an undated project a verdict or deadline interventions", () => {
    const { internalDeadlineAt: _removed, ...undated } = project;
    const forecast = planSchedule({
      now,
      horizonEnd: at(60 * day),
      projects: [undated],
      actions: [plain("a", { expectedMinutes: 6000, remainingMinutes: 6000 })],
      capacityWindows: dailyWindows(3),
      commitments: [],
      focusedProjectIds: ["p"]
    }).forecasts[0]!;
    expect(forecast.deadlineSource).toBe("none");
    expect(forecast.health).toBe("unknown");
    expect(forecast.interventions).toBeUndefined();
    expect(forecast.proposal).toBeUndefined();
  });

  it("does not shrink an override's pessimistic total by splitting the work into more actions", () => {
    const five = Array.from({ length: 5 }, (_, i) => action(`f${i}`));
    const ten = Array.from({ length: 10 }, (_, i) => action(`t${i}`));
    const overridden = { ...project, remainingEffortOverrideMinutes: 4200 };
    const a = projectEffort(five, overridden);
    const b = projectEffort(ten, overridden);
    expect(a.riskAdjustedMinutes).toBe(4200);
    expect(Math.abs(a.pessimisticMinutes - b.pessimisticMinutes)).toBeLessThanOrEqual(10);
    expect(a.pessimisticMinutes).toBeGreaterThan(4200 * 1.25);
  });

  it("never lets a learned spread erase the project's own padding", () => {
    const high: Project = { ...project, uncertainty: "high" };
    const bare = calculateActionEffort(plain("x"), high).riskAdjustedRemainingMinutes;
    const learned: Project = { ...high, estimateCalibration: { factor: 1, samples: 8, scope: "area", spread: 1 } };
    expect(calculateActionEffort(plain("x"), learned).riskAdjustedRemainingMinutes).toBe(bare);
  });

  it("reads the deadline source from the date actually used", () => {
    const clamped = forecastProject({
      project: { ...project, internalDeadlineAt: at(40 * day), externalDeadlineAt: at(20 * day) },
      actions: [action("a")],
      now,
      capacityWindows: dailyWindows(30),
      commitments: []
    });
    expect(clamped.deadlineSource).toBe("external");
  });
});

describe("setup, ledger and finish: codex fixes", () => {
  const day = 24 * 60;
  const rank = { ahead: 3, on_track: 2, at_risk: 1, behind: 0, unknown: -1 } as const;
  const sessions = (count: number) => Array.from({ length: count }, (_, d) => window(60, d * day + 60));

  it("reserves repeated setup so two projects cannot both claim the same minutes", () => {
    const a: Project = { ...project, id: "pa", internalDeadlineAt: at(10 * day) };
    const b: Project = { ...project, id: "pb", internalDeadlineAt: at(10 * day) };
    const job = (id: string, projectId: string) =>
      plain(id, {
        projectId,
        expectedMinutes: 120,
        remainingMinutes: 120,
        maximumSessionMinutes: 60,
        setupMinutes: 20
      });
    // Each needs 2 runs of 60 plus a second setup (about 20) on top of its padded 120; six sessions of
    // 60 minutes are not enough for both.
    const plan = (windows: CapacityWindow[]) =>
      planSchedule({
        now,
        horizonEnd: at(10 * day),
        projects: [a, b],
        actions: [job("ja", "pa"), job("jb", "pb")],
        capacityWindows: windows,
        commitments: []
      }).forecasts;
    const forecasts = plan(sessions(6));
    const needed = forecasts.reduce((sum, f) => sum + f.protectedRemainingMinutes!, 0);
    expect(needed).toBeGreaterThan(360);
    expect(forecasts.every((f) => f.health === "on_track" || f.health === "ahead")).toBe(false);
    // What the first project owes, setup included, is gone from the ledger before the second looks.
    const [first, second] = forecasts;
    expect(second!.compatibleCapacityMinutes!).toBeLessThanOrEqual(360 - first!.protectedRemainingMinutes! + 1);
  });

  it("never improves health by losing a window when an action is only partly placed", () => {
    const deadlineProject: Project = { ...project, internalDeadlineAt: at(8 * day) };
    const job = plain("job", {
      expectedMinutes: 180,
      remainingMinutes: 180,
      maximumSessionMinutes: 60,
      setupMinutes: 20
    });
    let previous = Infinity;
    for (let count = 6; count >= 1; count -= 1) {
      const f = forecastProject({
        project: deadlineProject,
        actions: [job],
        now,
        capacityWindows: sessions(count),
        commitments: []
      });
      const value = rank[f.health];
      expect(value, `${count} windows`).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it("estimates the undated finish per action against the capacity it can use", () => {
    const { internalDeadlineAt: _removed, ...undated } = project;
    const home: CapacityWindow = { ...window(180, 60), id: "home", contexts: ["home"] };
    const office: CapacityWindow = { ...window(180, 5 * day + 60), id: "office", contexts: ["office"] };
    const forecast = planSchedule({
      now,
      horizonEnd: at(30 * day),
      projects: [undated],
      actions: [
        plain("at-home", { expectedMinutes: 60, remainingMinutes: 60, contexts: ["home"] }),
        plain("at-office", { expectedMinutes: 60, remainingMinutes: 60, contexts: ["office"] })
      ],
      capacityWindows: [home, office],
      commitments: [],
      focusedProjectIds: ["p"]
    }).forecasts[0]!;
    expect(forecast.estimatedFinishAt!.getTime()).toBeGreaterThanOrEqual(at(5 * day).getTime());
  });
});

describe("setup across a later-recurring overflow", () => {
  const day = 24 * 60;
  const dated: Project = { ...project, internalDeadlineAt: at(60 * day) };
  const weekly = plain("weekly", {
    schedulingMode: "recurring",
    expectedMinutes: 300,
    remainingMinutes: 300,
    maximumSessionMinutes: 60,
    setupMinutes: 20,
    availableFrom: at(14 * day),
    deadlineAt: at(30 * day)
  });
  const extraSetup = (windows: CapacityWindow[]) => {
    const forecast = planSchedule({
      now,
      horizonEnd: at(120 * day),
      projects: [dated],
      actions: [weekly],
      capacityWindows: windows,
      commitments: []
    }).forecasts[0]!;
    return forecast.protectedRemainingMinutes! - projectEffort([weekly], dated).riskAdjustedMinutes;
  };

  it("owes one more setup for the boundary between the in-band part and the spill, only when both placed", () => {
    // Everything fits in the series' own band: one placement.
    const whole = extraSetup([window(40 * day, 0)]);
    // Only 100 minutes in the band, the rest spills to later capacity: two placements.
    const spilled = extraSetup([window(100, 14 * day), window(10 * day, 40 * day)]);
    expect(spilled).toBeGreaterThanOrEqual(whole + 20);
    // Spill that finds nothing places only one part and owes no join.
    const unspilled = extraSetup([window(100, 14 * day)]);
    expect(unspilled).toBeLessThan(spilled);
  });
});
