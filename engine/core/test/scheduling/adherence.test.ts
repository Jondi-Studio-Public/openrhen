import { describe, expect, it } from "vitest";
import { computeProjectAdherence, isMaintenanceProject, planSchedule } from "../../src/index.js";
import type { Action, ActionCadence, ActionOccurrence, ActionRecurrenceRule, Project } from "../../src/index.js";

const now = new Date("2026-09-05T09:00:00.000Z");

function action(id: string, overrides: Partial<Action> = {}): Action {
  return {
    id,
    projectId: "p",
    title: id,
    status: "active",
    optimisticMinutes: 20,
    expectedMinutes: 20,
    remainingMinutes: 20,
    pessimisticMinutes: 30,
    energy: "medium",
    minimumSessionMinutes: 10,
    maximumSessionMinutes: 30,
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

function periodCadence(overrides: Partial<ActionCadence> = {}): ActionCadence {
  return {
    intervalDays: 1,
    timezone: "UTC",
    startDate: "2026-09-01",
    completionCount: 0,
    period: { unit: "days", length: 10 },
    targetOccurrences: 10,
    completionLocalDates: [],
    ...overrides
  };
}

function legacyCadence(overrides: Partial<ActionCadence> = {}): ActionCadence {
  return {
    intervalDays: 4,
    timezone: "UTC",
    startDate: "2026-09-01",
    completionCount: 0,
    ...overrides
  };
}

function recurrenceRule(overrides: Partial<ActionRecurrenceRule> = {}): ActionRecurrenceRule {
  return {
    id: "rule-a",
    actionId: "a",
    timezone: "UTC",
    startDate: "2026-09-01",
    intervalDays: 7,
    windows: [
      { id: "w1", name: "morning", anchor: "local_time", localStartTime: "07:00", localEndTime: "09:00" },
      { id: "w2", name: "evening", anchor: "local_time", localStartTime: "18:00", localEndTime: "20:00" }
    ],
    ...overrides
  };
}

function occurrence(overrides: Partial<ActionOccurrence> = {}): ActionOccurrence {
  return {
    id: "occ-1",
    actionId: "a",
    recurrenceRuleId: "rule-a",
    windowId: "w1",
    windowName: "morning",
    localDate: "2026-09-02",
    windowStartsAt: new Date("2026-09-02T07:00:00.000Z"),
    windowEndsAt: new Date("2026-09-02T09:00:00.000Z"),
    status: "pending",
    anchorSource: "local_time",
    ...overrides
  };
}

describe("isMaintenanceProject", () => {
  it("is false for an empty action list", () => {
    expect(isMaintenanceProject([])).toBe(false);
  });

  it("is true when every live action is recurring or cadence", () => {
    expect(
      isMaintenanceProject([
        action("a", { schedulingMode: "cadence", cadence: legacyCadence() }),
        action("b", { schedulingMode: "recurring", recurrenceRule: recurrenceRule() })
      ])
    ).toBe(true);
  });

  it("is false when any live action is one-off or missing a mode", () => {
    expect(
      isMaintenanceProject([action("a", { schedulingMode: "cadence", cadence: legacyCadence() }), action("b")])
    ).toBe(false);
  });
});

describe("computeProjectAdherence: cadence with a period", () => {
  // Period 2026-09-01..2026-09-10 (length 10); `now` sits on day 5, so 5 of 10 days have elapsed.
  const target10 = (completionLocalDates: string[]) =>
    action("a", { schedulingMode: "cadence", cadence: periodCadence({ completionLocalDates }) });

  it("is behind when the ratio is under 0.5", () => {
    const result = computeProjectAdherence([target10(["2026-09-01", "2026-09-02"])], [], now);
    expect(result.actions[0]).toMatchObject({
      done: 2,
      expectedSoFar: 5,
      target: 10,
      periodLabel: "this 10-day period"
    });
    expect(result.ratio).toBeCloseTo(0.4);
    expect(result.health).toBe("behind");
  });

  it("is at_risk between 0.5 and 0.8", () => {
    const result = computeProjectAdherence([target10(["2026-09-01", "2026-09-02", "2026-09-03"])], [], now);
    expect(result.ratio).toBeCloseTo(0.6);
    expect(result.health).toBe("at_risk");
  });

  it("is on_track once the ratio reaches 0.8", () => {
    const result = computeProjectAdherence(
      [target10(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"])],
      [],
      now
    );
    expect(result.ratio).toBeCloseTo(0.8);
    expect(result.health).toBe("on_track");
  });

  it("is ahead once every action already met its full-period target", () => {
    const action3 = action("a", {
      schedulingMode: "cadence",
      cadence: periodCadence({ targetOccurrences: 3, completionLocalDates: ["2026-09-01", "2026-09-02", "2026-09-03"] })
    });
    const result = computeProjectAdherence([action3], [], now);
    expect(result.actions[0]).toMatchObject({ done: 3, target: 3 });
    expect(result.health).toBe("ahead");
  });

  it("names the specific behind action in the reason", () => {
    const result = computeProjectAdherence(
      [
        action("stretching", {
          title: "stretching",
          schedulingMode: "cadence",
          cadence: periodCadence({ completionLocalDates: ["2026-09-01", "2026-09-02", "2026-09-03"] })
        })
      ],
      [],
      now
    );
    expect(result.reason).toBe("Adherence 3 of 5 due so far this 10-day period; stretching is 2 behind.");
  });
});

describe("computeProjectAdherence: legacy cadence (no period)", () => {
  // Interval 2026-09-01..2026-09-04 (4 days); `now` is the interval's last day, so the whole interval
  // has elapsed and the one-target expectation is fully due.
  const dueNow = new Date("2026-09-04T09:00:00.000Z");

  it("counts done when the last completion falls inside the current interval", () => {
    const result = computeProjectAdherence(
      [action("a", { schedulingMode: "cadence", cadence: legacyCadence({ lastCompletedLocalDate: "2026-09-02" }) })],
      [],
      dueNow
    );
    expect(result.actions[0]).toMatchObject({ done: 1, target: 1, expectedSoFar: 1 });
    expect(result.ratio).toBe(1);
  });

  it("counts not-done when the last completion falls in a prior interval", () => {
    const result = computeProjectAdherence(
      [action("a", { schedulingMode: "cadence", cadence: legacyCadence({ lastCompletedLocalDate: "2026-08-30" }) })],
      [],
      dueNow
    );
    expect(result.actions[0]).toMatchObject({ done: 0, target: 1, expectedSoFar: 1 });
    expect(result.health).toBe("behind");
  });
});

describe("computeProjectAdherence: recurring occurrences", () => {
  // intervalDays 7, two windows per cycle -> target 2. Period 2026-09-01..2026-09-07.
  const rule = recurrenceRule();
  const template = action("a", { schedulingMode: "recurring", recurrenceRule: rule });

  it("counts a completed occurrence as done", () => {
    const occurrences = [
      occurrence({ id: "occ-1", windowId: "w1", localDate: "2026-09-02", status: "completed" }),
      occurrence({
        id: "occ-2",
        windowId: "w2",
        localDate: "2026-09-06",
        windowStartsAt: new Date("2026-09-06T18:00:00.000Z"),
        windowEndsAt: new Date("2026-09-06T20:00:00.000Z"),
        status: "pending"
      })
    ];
    const result = computeProjectAdherence([template], occurrences, now);
    // Only occ-1 is due (completed); occ-2's window is still ahead of `now` and is not yet due.
    expect(result.actions[0]).toMatchObject({ done: 1, expectedSoFar: 1, target: 2 });
    expect(result.ratio).toBe(1);
  });

  it("counts a missed occurrence, and a pending occurrence whose window has closed, as due and not done", () => {
    const occurrences = [
      occurrence({ id: "occ-1", windowId: "w1", localDate: "2026-09-02", status: "missed" }),
      occurrence({
        id: "occ-2",
        windowId: "w2",
        localDate: "2026-09-02",
        windowStartsAt: new Date("2026-09-02T18:00:00.000Z"),
        windowEndsAt: new Date("2026-09-02T20:00:00.000Z"),
        status: "pending"
      })
    ];
    const result = computeProjectAdherence([template], occurrences, now);
    expect(result.actions[0]).toMatchObject({ done: 0, expectedSoFar: 2, target: 2 });
    expect(result.ratio).toBe(0);
    expect(result.health).toBe("behind");
  });

  it("excludes a cancelled occurrence from both done and expected", () => {
    const occurrences = [occurrence({ id: "occ-1", windowId: "w1", localDate: "2026-09-02", status: "cancelled" })];
    const result = computeProjectAdherence([template], occurrences, now);
    expect(result.actions[0]).toMatchObject({ done: 0, expectedSoFar: 0 });
    expect(result.ratio).toBe(1);
  });

  it("is behind when the previous period's occurrences are all missed", () => {
    // Previous cycle: 2026-08-25..2026-08-31, both windows missed.
    const occurrences = [
      occurrence({ id: "prev-1", windowId: "w1", localDate: "2026-08-26", status: "missed" }),
      occurrence({ id: "prev-2", windowId: "w2", localDate: "2026-08-27", status: "missed" })
    ];
    const result = computeProjectAdherence([template], occurrences, now);
    // Nothing due yet this period, so the ratio alone would read on_track (1); the prior-period miss
    // is what forces the health down.
    expect(result.ratio).toBe(1);
    expect(result.health).toBe("behind");
    expect(result.reason).toContain("missed the last period entirely");
  });

  it("does not report a missed last period when no record of it exists", () => {
    const result = computeProjectAdherence([template], [], now);
    expect(result.health).toBe("on_track");
  });

  it("groups a recurring template's several synthesized per-occurrence units as one action", () => {
    const units = [
      { ...template, id: "occ-1", templateActionId: "a" },
      { ...template, id: "occ-2", templateActionId: "a" }
    ];
    const result = computeProjectAdherence(units, [], now);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.actionId).toBe("a");
  });
});

describe("computeProjectAdherence: nothing due yet", () => {
  it("reports ratio 1 and on_track when no action has anything expected so far", () => {
    // A 30-day period that started today: one elapsed day of thirty floors a target of 10 to zero.
    const cadence = periodCadence({
      startDate: "2026-09-05",
      period: { unit: "days", length: 30 },
      targetOccurrences: 10,
      completionLocalDates: []
    });
    const result = computeProjectAdherence([action("a", { schedulingMode: "cadence", cadence })], [], now);
    expect(result.actions[0]!.expectedSoFar).toBe(0);
    expect(result.ratio).toBe(1);
    expect(result.health).toBe("on_track");
  });
});

describe("planSchedule: maintenance projects", () => {
  function project(id: string, overrides: Partial<Project> = {}): Project {
    return { id, status: "active", uncertainty: "known", value: 3, consequence: 3, outcomeActive: true, ...overrides };
  }

  it("classifies a maintenance project by adherence instead of unknown, with no deadline set", () => {
    const p = project("p");
    const a = action("a", {
      projectId: "p",
      schedulingMode: "cadence",
      cadence: legacyCadence({ lastCompletedLocalDate: "2026-09-04" })
    });
    const result = planSchedule({
      now: new Date("2026-09-04T09:00:00.000Z"),
      horizonEnd: new Date(now.getTime() + 200 * 86_400_000),
      projects: [p],
      actions: [a],
      capacityWindows: [],
      commitments: []
    });
    const forecast = result.forecasts.find((item) => item.projectId === "p")!;
    // The top-level `health` deliberately stays "unknown" — recommendation/score.ts reads Behind/At
    // risk there as proof of a real deadline, and a maintenance project has none; see the comment on
    // `ProjectAdherence` in model/types.ts. The real classification lives on `adherence.health`.
    expect(forecast.health).toBe("unknown");
    expect(forecast.healthBasis).toBe("adherence");
    expect(forecast.adherence?.health).toBe("ahead");
    expect(forecast.adherence?.actions).toHaveLength(1);
  });

  it("classifies a maintenance project by adherence even with a deadline beyond the forecast horizon", () => {
    const p = project("p", { internalDeadlineAt: new Date(now.getTime() + 200 * 86_400_000) });
    const a = action("a", {
      projectId: "p",
      schedulingMode: "cadence",
      cadence: legacyCadence({ lastCompletedLocalDate: "2026-09-04" })
    });
    const result = planSchedule({
      now: new Date("2026-09-04T09:00:00.000Z"),
      horizonEnd: new Date(now.getTime() + 200 * 86_400_000),
      projects: [p],
      actions: [a],
      capacityWindows: [],
      commitments: []
    });
    const forecast = result.forecasts.find((item) => item.projectId === "p")!;
    expect(forecast.health).toBe("unknown");
    expect(forecast.healthBasis).toBe("adherence");
    expect(forecast.adherence?.health).toBe("ahead");
  });

  it("threads materialised occurrences through to a recurring maintenance project's adherence", () => {
    const p = project("p");
    const rule = recurrenceRule();
    const a = action("a", { projectId: "p", schedulingMode: "recurring", recurrenceRule: rule });
    const occurrences = [occurrence({ id: "occ-1", windowId: "w1", localDate: "2026-09-02", status: "completed" })];
    const result = planSchedule({
      now: new Date("2026-09-05T09:00:00.000Z"),
      horizonEnd: new Date(now.getTime() + 200 * 86_400_000),
      projects: [p],
      actions: [a],
      capacityWindows: [],
      commitments: [],
      occurrences
    });
    const forecast = result.forecasts.find((item) => item.projectId === "p")!;
    expect(forecast.healthBasis).toBe("adherence");
    expect(forecast.adherence?.actions[0]).toMatchObject({ done: 1 });
  });

  it("leaves a mixed one-off/recurring project on the ordinary feasibility path, unaffected", () => {
    const p = project("p", { internalDeadlineAt: new Date(now.getTime() + 10 * 86_400_000) });
    const oneOff = action("one-off", { projectId: "p", remainingMinutes: 60, minimumSessionMinutes: 15 });
    const cadenceAction = action("regular", {
      projectId: "p",
      schedulingMode: "cadence",
      cadence: legacyCadence()
    });
    const result = planSchedule({
      now: new Date("2026-09-04T09:00:00.000Z"),
      horizonEnd: new Date(now.getTime() + 200 * 86_400_000),
      projects: [p],
      actions: [oneOff, cadenceAction],
      capacityWindows: [
        {
          id: "w",
          startsAt: now,
          endsAt: new Date(now.getTime() + 10 * 86_400_000),
          energy: "medium",
          contexts: [],
          usableFraction: 1
        }
      ],
      commitments: []
    });
    const forecast = result.forecasts.find((item) => item.projectId === "p")!;
    expect(forecast.healthBasis).toBe("feasibility");
    expect(forecast.protectedRemainingMinutes).not.toBeNull();
  });
});
