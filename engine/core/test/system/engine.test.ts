import { describe, expect, it } from "vitest";
import {
  analyzeDependencies,
  calculateActionEffort,
  normalizePlanningSlots,
  planSchedule,
  recommend,
  simulateContinuation,
  slotFitsAction
} from "../../src/index.js";
import type { Action, CapacityWindow, Project } from "../../src/index.js";
import { holding } from "../model/situation.js";

const now = new Date("2026-08-08T08:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

function project(id: string, deadlineMinutes = 180, overrides: Partial<Project> = {}): Project {
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

function action(id: string, projectId: string, minutes = 30, overrides: Partial<Action> = {}): Action {
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
    maximumSessionMinutes: 60,
    importance: 3,
    consequence: 3,
    contexts: ["laptop"],
    dependenciesComplete: true,
    dependencyIds: [],
    splittable: true,
    setupMinutes: 0,
    ...overrides
  };
}

function capacity(
  id: string,
  start: number,
  end: number,
  energy: CapacityWindow["energy"] = "high",
  contexts = ["laptop"],
  usableFraction = 1
): CapacityWindow {
  return { id, startsAt: at(start), endsAt: at(end), energy, contexts, usableFraction };
}

describe("Gate 3 deterministic planning engine", () => {
  it("G3.1 normalizes overlaps and expanded commitments into one non-overlapping slot ledger", () => {
    const slots = normalizePlanningSlots({
      from: now,
      until: at(90),
      capacityWindows: [capacity("high", 0, 90), capacity("low", 15, 75, "low")],
      commitments: [
        { id: "class", startsAt: at(45), endsAt: at(60), setupBeforeMinutes: 15, transitionAfterMinutes: 15 }
      ]
    });
    expect(slots.every((slot, index) => index === 0 || slots[index - 1]!.endsAt <= slot.startsAt)).toBe(true);
    expect(slots.reduce((sum, slot) => sum + slot.capacityMinutes, 0)).toBe(45);
    expect(slots.filter((slot) => slot.availability === "fixed")).toHaveLength(3);
  });

  it("G3.1 does not borrow contexts from a lower-energy overlapping window", () => {
    const slots = normalizePlanningSlots({
      from: now,
      until: at(60),
      capacityWindows: [
        capacity("high-laptop", 0, 60, "high", ["laptop"]),
        capacity("low-home", 0, 60, "low", ["home"])
      ],
      commitments: []
    });
    expect(slots[0]?.energy).toBe("high");
    expect(slots[0]?.contexts).toEqual(["laptop"]);
    expect(slotFitsAction(slots[0]!, action("home-focus", "project", 30, { energy: "high", contexts: ["home"] }))).toBe(
      false
    );
    expect(slotFitsAction(slots[0]!, action("home-low", "project", 30, { energy: "low", contexts: ["home"] }))).toBe(
      true
    );
  });

  it("G3.2 calculates and preserves three-point PERT evidence", () => {
    const effort = calculateActionEffort(
      action("draft", "study", 60, { optimisticMinutes: 30, expectedMinutes: 60, pessimisticMinutes: 90 }),
      project("study")
    );
    expect(effort).toMatchObject({
      optimisticMinutes: 30,
      mostLikelyMinutes: 60,
      pessimisticMinutes: 90,
      expectedMinutes: 60,
      standardDeviationMinutes: 10,
      riskAdjustedMinutes: 71,
      riskAdjustedRemainingMinutes: 71,
      method: "pert"
    });
  });

  it("G3.3 returns stable topological and critical ordering and detects cycles", () => {
    const first = action("a", "study", 30);
    const second = action("b", "study", 45, { dependencyIds: ["a"] });
    const third = action("c", "study", 15, { dependencyIds: ["b"] });
    const analysis = analyzeDependencies(
      [third, first, second],
      [
        calculateActionEffort(first, project("study")),
        calculateActionEffort(second, project("study")),
        calculateActionEffort(third, project("study"))
      ]
    );
    expect(analysis.order).toEqual(["a", "b", "c"]);
    expect(analysis.criticalMinutesByAction.a).toBe(105);
    expect(analysis.downstreamMinutesByAction).toMatchObject({ a: 70, c: 0 });
    expect(analyzeDependencies([{ ...first, dependencyIds: ["c"] }, second, third]).errors[0]).toContain(
      "Dependency cycle"
    );
  });

  it("G3.4 respects shared time, energy, contexts, and usable fractions", () => {
    const plan = planSchedule({
      now,
      horizonEnd: at(120),
      projects: [project("study", 120)],
      actions: [action("campus", "study", 30, { contexts: ["campus"] })],
      capacityWindows: [
        capacity("home", 0, 60, "high", ["home"], 1),
        capacity("campus", 60, 120, "high", ["campus"], 0.5)
      ],
      commitments: []
    });
    expect(plan.forecasts[0]?.compatibleCapacityMinutes).toBe(30);
    expect(plan.allocations.reduce((sum, block) => sum + block.minutes, 0)).toBe(30);
  });

  it("G3.5 allocates earliest-deadline projects first without double booking", () => {
    const early = project("early", 60);
    const late = project("late", 120);
    const plan = planSchedule({
      now,
      horizonEnd: at(120),
      projects: [late, early],
      actions: [action("late-work", "late", 60), action("early-work", "early", 45)],
      capacityWindows: [capacity("day", 0, 120)],
      commitments: []
    });
    expect(
      plan.allocations.filter((block) => block.actionId === "early-work").every((block) => block.endsAt <= at(60))
    ).toBe(true);
    // Protected figures (52 and 69) are reserved, so the early project takes 52 and the late one fills the
    // 15-minute slots left up to its own padded need.
    expect(plan.allocations.reduce((sum, block) => sum + block.minutes, 0)).toBe(112);
    for (const slot of plan.slots)
      expect(
        plan.allocations.filter((block) => block.slotId === slot.id).reduce((sum, block) => sum + block.minutes, 0)
      ).toBeLessThanOrEqual(slot.capacityMinutes);
  });

  it("G3.5 does not let paused projects consume active-project capacity", () => {
    const paused = project("paused", 60, { status: "paused" });
    const active = project("active", 60);
    const plan = planSchedule({
      now,
      horizonEnd: at(60),
      projects: [paused, active],
      actions: [action("paused-work", "paused", 60), action("active-work", "active", 60)],
      capacityWindows: [capacity("day", 0, 60)],
      commitments: []
    });
    expect(plan.allocations.every((block) => block.projectId === "active")).toBe(true);
    expect(plan.forecasts.find((forecast) => forecast.projectId === "active")?.health).toBe("behind");
  });

  it("G3.5 does not manufacture a valid session from fragments below the minimum", () => {
    const fragmented = planSchedule({
      now,
      horizonEnd: at(50),
      projects: [project("study", 50)],
      actions: [action("focus", "study", 30, { minimumSessionMinutes: 30 })],
      capacityWindows: [capacity("one", 0, 20), capacity("two", 30, 50)],
      commitments: []
    });
    expect(fragmented.allocations).toHaveLength(0);
    // Forty compatible minutes exist (the action's padded 35 fit), but as two fragments below the minimum session. That is a
    // scheduling-shape failure, not a shortage of time, so it is at risk rather than behind.
    expect(fragmented.forecasts[0]?.health).toBe("at_risk");
    expect(fragmented.forecasts[0]?.schedulingBlocked).toBe(true);
    expect(fragmented.forecasts[0]?.expectedMarginMinutes).toBeGreaterThanOrEqual(0);
    expect(fragmented.forecasts[0]?.reasons.some((reason) => reason.includes("not its shape"))).toBe(true);
  });

  it("G3.5 reports an unreserved shortfall in whole minutes", () => {
    // The shortfall is the unreserved share of the honest project total, a ratio that rarely lands on
    // a whole minute; the reason text and the field must still read as whole minutes.
    const plan = planSchedule({
      now,
      horizonEnd: at(100),
      projects: [project("short", 100)],
      actions: [action("a-one", "short", 37), action("b-two", "short", 41), action("c-three", "short", 29)],
      capacityWindows: [capacity("only", 0, 100)],
      commitments: []
    });
    const forecast = plan.forecasts[0]!;
    expect(forecast.unallocatedExpectedMinutes).toBeGreaterThan(0);
    expect(Number.isInteger(forecast.unallocatedExpectedMinutes)).toBe(true);
    expect(forecast.reasons.join(" ")).not.toMatch(/\d+\.\d+ minutes/);
  });

  it("G3.5 preserves scarce high-energy capacity for high-energy work", () => {
    const p = project("mixed", 60);
    const high = action("a-high", p.id, 30, { energy: "high" });
    const low = action("z-low", p.id, 30, { energy: "low" });
    const plan = planSchedule({
      now,
      horizonEnd: at(60),
      projects: [p],
      actions: [high, low],
      capacityWindows: [capacity("low-first", 0, 30, "low"), capacity("high-last", 30, 60, "high")],
      commitments: []
    });
    expect(
      plan.allocations.filter((block) => block.actionId === high.id).reduce((sum, block) => sum + block.minutes, 0)
    ).toBe(30);
    expect(
      plan.allocations.filter((block) => block.actionId === low.id).reduce((sum, block) => sum + block.minutes, 0)
    ).toBe(30);
  });

  it("G3.5 uses a project remaining-effort override for forecasts and scheduling", () => {
    const overridden = project("study", 300, { remainingEffortOverrideMinutes: 90 });
    const plan = planSchedule({
      now,
      horizonEnd: at(300),
      projects: [overridden],
      actions: [action("first", "study", 60), action("second", "study", 60)],
      capacityWindows: [capacity("available", 0, 300)],
      commitments: []
    });
    const forecast = plan.forecasts[0]!;
    expect(forecast.protectedRemainingMinutes).toBe(90);
    expect(plan.allocations.reduce((sum, block) => sum + block.minutes, 0)).toBe(90);
    expect(forecast.expectedMarginMinutes).toBe(210);
    expect(forecast.reasons.join(" ")).toContain("override of 90 minutes");
  });

  it("G3.6 exposes slack and dependency-aware latest safe starts", () => {
    const first = action("research", "study", 30);
    const second = action("write", "study", 30, { dependencyIds: ["research"] });
    const forecast = planSchedule({
      now,
      horizonEnd: at(120),
      projects: [project("study", 120)],
      actions: [second, first],
      capacityWindows: [capacity("day", 0, 120)],
      commitments: []
    }).forecasts[0]!;
    // Two single-figure 30-minute actions are padded to 35 each (a combined spread on a mean of 60),
    // so the 120-minute margin is no longer 60.
    expect(forecast.expectedMarginMinutes).toBe(53);
    expect(forecast.pessimisticMarginMinutes).toBe(52);
    expect(forecast.latestSafeStarts.research!.getTime()).toBeLessThan(forecast.latestSafeStarts.write!.getTime());
  });

  it("G3.7 classifies pace and feasibility states from shared allocation", () => {
    const behind = planSchedule({
      now,
      horizonEnd: at(30),
      projects: [project("behind", 30)],
      actions: [action("large", "behind", 60)],
      capacityWindows: [capacity("short", 0, 30)],
      commitments: []
    }).forecasts[0]!;
    const ahead = planSchedule({
      now,
      horizonEnd: at(120),
      projects: [project("ahead", 120, { actualCompletionRatio: 0.7, requiredCompletionRatio: 0.5 })],
      actions: [action("small", "ahead", 30)],
      capacityWindows: [capacity("long", 0, 120)],
      commitments: []
    }).forecasts[0]!;
    expect(behind.health).toBe("behind");
    expect(ahead.health).toBe("ahead");
  });

  it("G3.8 excludes inactive outcomes, indivisible work, and high-focus work from recovery", () => {
    const inactive = project("inactive", 120, { outcomeActive: false });
    const task = action("indivisible", "inactive", 60, { splittable: false });
    const result = recommend({
      now,
      horizonEnd: at(30),
      projects: [inactive],
      actions: [task],
      capacityWindows: [capacity("recovery", 0, 30, "recovery")],
      commitments: [],
      ...holding("laptop")
    });
    expect(result.primary).toBeNull();
    expect(result.candidates[0]?.exclusionReasons).toEqual(expect.arrayContaining(["Parent outcome is not active."]));
    expect(result.candidates[0]?.exclusionReasons.join(" ")).toContain("indivisible");
  });

  it("G3.9 ranks capacity pressure above otherwise equal flexible work", () => {
    const urgent = project("urgent", 60);
    const relaxed = project("relaxed", 180);
    const urgentAction = action("urgent-action", "urgent", 60, { contexts: ["campus"] });
    const relaxedAction = action("relaxed-action", "relaxed", 15, { contexts: ["home"] });
    const result = recommend({
      now,
      horizonEnd: at(180),
      projects: [relaxed, urgent],
      actions: [relaxedAction, urgentAction],
      capacityWindows: [capacity("campus", 0, 60, "high", ["campus"]), capacity("home", 0, 180, "high", ["home"])],
      commitments: [],
      ...holding("campus", "home")
    });
    expect(result.primary?.action.id).toBe("urgent-action");
    expect(result.primary?.scoreComponents.capacityPressure).toBeGreaterThan(
      result.alternatives[0]!.scoreComponents.capacityPressure!
    );
  });

  it("G3.10 emits calculation evidence and exact exclusion facts", () => {
    const p = project("study", 120);
    const task = action("draft", "study", 30);
    const result = recommend({
      now,
      horizonEnd: at(120),
      projects: [p],
      actions: [task],
      capacityWindows: [capacity("day", 0, 120)],
      commitments: [],
      ...holding("laptop")
    });
    expect(result.evidence.join(" ")).toContain("protected minutes");
    expect(result.explanation).toContain("protected boundary");
  });

  it("G3.10 formats recommendation deadlines in the supplied timezone", () => {
    const p = project("study", 120);
    const task = action("draft", "study", 30);
    const result = recommend({
      now,
      horizonEnd: at(120),
      projects: [p],
      actions: [task],
      capacityWindows: [capacity("day", 0, 120)],
      commitments: [],
      ...holding("laptop"),
      timezone: "Australia/Sydney",
      locale: "en-AU"
    });
    expect(result.explanation).toContain("8:00 pm");
  });

  it("G3.11 refuses continuation that makes an earlier project infeasible", () => {
    const currentProject = project("current", 120);
    const urgent = project("urgent", 40, { consequence: 5 });
    const simulation = simulateContinuation({
      now,
      horizonEnd: at(120),
      actionId: "current-work",
      requestedMinutes: 15,
      projects: [currentProject, urgent],
      actions: [action("current-work", "current", 60, { status: "doing" }), action("urgent-work", "urgent", 30)],
      capacityWindows: [capacity("day", 0, 120)],
      commitments: []
    });
    expect(simulation.safe).toBe(false);
    expect(simulation.reason).toContain("more urgent project");
  });

  it("G3.12 recalculates deterministically after a material commitment change", () => {
    const p = project("study", 60);
    const task = action("draft", "study", 40);
    const input = {
      now,
      horizonEnd: at(60),
      projects: [p],
      actions: [task],
      capacityWindows: [capacity("day", 0, 60)],
      commitments: []
    };
    const before = planSchedule(input);
    const again = planSchedule(input);
    const after = planSchedule({ ...input, commitments: [{ id: "call", startsAt: at(15), endsAt: at(60) }] });
    expect(before).toEqual(again);
    expect(before.forecasts[0]?.health).toBe("on_track");
    expect(after.forecasts[0]?.health).toBe("behind");
  });
});

describe("Gate 3 acceptance transitions", () => {
  it("AT-F makes an overrun visible as soon as time consumes the remaining margin", () => {
    const p = project("study", 60);
    const task = action("draft", "study", 40);
    const initial = planSchedule({
      now,
      horizonEnd: at(60),
      projects: [p],
      actions: [task],
      capacityWindows: [capacity("day", 0, 60)],
      commitments: []
    });
    const afterOverrun = planSchedule({
      now: at(30),
      horizonEnd: at(60),
      projects: [p],
      actions: [task],
      capacityWindows: [capacity("day", 0, 60)],
      commitments: []
    });
    expect(initial.forecasts[0]?.health).toBe("on_track");
    expect(afterOverrun.forecasts[0]?.health).toBe("behind");
  });

  it("AT-G reveals the dependant as the next action immediately after completion", () => {
    const p = project("study", 120);
    const first = action("research", "study", 30);
    const second = action("write", "study", 30, { dependencyIds: ["research"], dependenciesComplete: false });
    const input = {
      now,
      horizonEnd: at(120),
      projects: [p],
      capacityWindows: [capacity("day", 0, 120)],
      commitments: [],
      ...holding("laptop")
    };
    expect(recommend({ ...input, actions: [first, second] }).primary?.action.id).toBe("research");
    expect(
      recommend({
        ...input,
        actions: [
          { ...first, status: "done" },
          { ...second, dependenciesComplete: true }
        ]
      }).primary?.action.id
    ).toBe("write");
  });

  it("AT-J keeps recovery capacity protected from ordinary work", () => {
    const p = project("study", 60);
    const task = action("draft", "study", 30);
    const plan = planSchedule({
      now,
      horizonEnd: at(60),
      projects: [p],
      actions: [task],
      capacityWindows: [capacity("rest", 0, 60, "recovery")],
      commitments: []
    });
    expect(plan.slots.every((slot) => slot.availability === "protected")).toBe(true);
    expect(plan.allocations).toHaveLength(0);
  });
});

describe("six-month graduated planning", () => {
  const day = 24 * 60;
  const sixMonthCapacity = capacity("six-months", 0, 180 * day, "high", ["laptop"]);

  it("uses the fixed band boundaries and balanced capacity decay", () => {
    const plan = planSchedule({
      now,
      horizonEnd: at(220 * day),
      projects: [],
      actions: [],
      capacityWindows: [sixMonthCapacity],
      commitments: []
    });
    expect(
      plan.capacityEnvelopes.map((band) => [band.kind, band.capacityFactor, band.adjustedCapacityMinutes])
    ).toEqual([
      ["detailed", 1, 7 * day],
      ["daily", 0.9, Math.floor(7 * day * 0.9)],
      ["weekly", 0.8, Math.floor(16 * day * 0.8)],
      ["fortnightly", 0.65, Math.floor(60 * day * 0.65)],
      ["monthly", 0.5, Math.floor(90 * day * 0.5)]
    ]);
    expect(plan.capacityEnvelopes.at(-1)?.endsAt).toEqual(at(180 * day));
    expect(
      plan.slots
        .filter((slot) => slot.availability === "free")
        .every((slot) => slot.endsAt.getTime() - slot.startsAt.getTime() <= 15 * 60_000)
    ).toBe(true);
  });

  it("subtracts exact commitments and projects aggregate protection across every band beyond the exact horizon", () => {
    const plan = planSchedule({
      now,
      horizonEnd: at(30 * day),
      projects: [],
      actions: [],
      capacityWindows: [capacity("month", 0, 30 * day)],
      commitments: [{ id: "known", startsAt: at(8 * day), endsAt: at(8 * day + 60) }],
      projectedDailyProtectedMinutes: 60
    });
    // The daily band spans days 7 to 14 and carries both the known commitment and seven projected days.
    expect(plan.capacityEnvelopes.find((band) => band.kind === "daily")?.protectedKnownMinutes).toBe(60 + 7 * 60);
    expect(plan.capacityEnvelopes.find((band) => band.kind === "weekly")?.protectedKnownMinutes).toBe(16 * 60);
  });

  it("does not double-count exact allocations and coarse project envelopes", () => {
    const p = project("long", 20 * day, { remainingEffortOverrideMinutes: 15_000 });
    const plan = planSchedule({
      now,
      horizonEnd: at(30 * day),
      projects: [p],
      actions: [action("long-work", p.id, 60)],
      capacityWindows: [capacity("month", 0, 30 * day)],
      commitments: []
    });
    const allocated =
      plan.allocations.reduce((sum, block) => sum + block.minutes, 0) +
      plan.projectEnvelopes.reduce((sum, envelope) => sum + envelope.reservedMinutes, 0);
    expect(allocated).toBe(p.remainingEffortOverrideMinutes);
    for (const band of plan.capacityEnvelopes)
      expect(band.reservedMinutes + band.freeMinutes).toBeCloseTo(band.adjustedCapacityMinutes);
  });

  it("uses later capacity for a distant project instead of marking it behind when week one is full", () => {
    const august = project("august", 7 * day, { consequence: 5, remainingEffortOverrideMinutes: 7 * day });
    const january = project("january", 150 * day, { consequence: 5, remainingEffortOverrideMinutes: 60 * day });
    const augustAction = action("august-work", august.id, 60, { consequence: 5 });
    const januaryAction = action("january-work", january.id, 60, { consequence: 5 });
    const plan = planSchedule({
      now,
      horizonEnd: at(180 * day),
      projects: [january, august],
      actions: [januaryAction, augustAction],
      capacityWindows: [sixMonthCapacity],
      commitments: []
    });
    expect(plan.forecasts.find((item) => item.projectId === "january")?.health).not.toBe("behind");
    const recommendation = recommend({
      now,
      horizonEnd: at(180 * day),
      projects: [january, august],
      actions: [januaryAction, augustAction],
      forecasts: plan.forecasts,
      planning: plan,
      capacityWindows: [sixMonthCapacity],
      commitments: [],
      ...holding("laptop"),
      currentEnergy: "high"
    });
    expect(recommendation.primary?.action.id).toBe("august-work");
  });

  it("immediately changes Now when current context or energy makes nearer work eligible", () => {
    const near = project("near", 2 * day, { consequence: 5, remainingEffortOverrideMinutes: 2 * day });
    const distant = project("distant", 120 * day, { consequence: 5 });
    const nearAction = action("near-online", near.id, 60, { energy: "high", contexts: ["online"] });
    const distantAction = action("distant-desktop", distant.id, 60, { energy: "medium", contexts: ["desktop"] });
    const plan = planSchedule({
      now,
      horizonEnd: at(180 * day),
      projects: [near, distant],
      actions: [nearAction, distantAction],
      capacityWindows: [capacity("all", 0, 180 * day, "high", ["online", "desktop"])],
      commitments: []
    });
    const base = {
      now,
      horizonEnd: at(180 * day),
      projects: [near, distant],
      actions: [nearAction, distantAction],
      forecasts: plan.forecasts,
      planning: plan,
      capacityWindows: [capacity("all", 0, 180 * day, "high", ["online", "desktop"])],
      commitments: []
    };
    expect(recommend({ ...base, ...holding("desktop"), currentEnergy: "medium" }).primary?.action.id).toBe(
      "distant-desktop"
    );
    expect(recommend({ ...base, ...holding("online", "desktop"), currentEnergy: "high" }).primary?.action.id).toBe(
      "near-online"
    );
  });

  it("keeps beyond-horizon and unselected undated work unknown without maximum urgency", () => {
    const outside = project("outside", 200 * day, { consequence: 5 });
    const { internalDeadlineAt: _deadline, ...undated } = project("undated", 60);
    const actions = [action("outside-work", outside.id), action("undated-work", undated.id)];
    const plan = planSchedule({
      now,
      horizonEnd: at(365 * day),
      projects: [outside, undated],
      actions,
      capacityWindows: [sixMonthCapacity],
      commitments: []
    });
    expect(plan.forecasts.find((item) => item.projectId === outside.id)).toMatchObject({
      health: "unknown",
      forecastBand: null
    });
    expect(plan.forecasts.find((item) => item.projectId === outside.id)?.reasons.join(" ")).toContain(
      "outside the current six-month forecast"
    );
    expect(plan.forecasts.find((item) => item.projectId === undated.id)?.reasons.join(" ")).toContain(
      "not selected in Review"
    );
    const focused = planSchedule({
      now,
      horizonEnd: at(180 * day),
      projects: [undated],
      actions: [actions[1]!],
      capacityWindows: [sixMonthCapacity],
      commitments: [],
      focusedProjectIds: [undated.id]
    });
    // Focus plans it to the end of the horizon, but that end is not a deadline: it is measured (it has
    // numbers and an estimated finish) without ever being called on track.
    const forecast = focused.forecasts[0]!;
    expect(forecast.deadlineSource).toBe("none");
    expect(forecast.reasons.join(" ")).not.toContain("not selected in Review");
    expect(forecast.reasons.join(" ")).toContain("No deadline is set");
    expect(forecast.protectedRemainingMinutes).not.toBeNull();
    expect(forecast.estimatedFinishAt).toBeInstanceOf(Date);
    expect(["on_track", "ahead"]).not.toContain(forecast.health);
    expect(plan.forecasts.find((item) => item.projectId === undated.id)?.deadlineSource).toBe("none");
    expect(plan.forecasts.find((item) => item.projectId === outside.id)?.deadlineSource).toBe("internal");
  });
});
