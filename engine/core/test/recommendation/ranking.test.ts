import { describe, expect, it } from "vitest";
import {
  CRITICAL_TIERS,
  ORDINARY_RANK,
  compareCandidates,
  effectiveDeadline,
  planSchedule,
  recommend,
  resolvePlanningCapacity
} from "../../src/index.js";
import type { Action, CapacityWindow, Project, ProjectForecast, RecommendationCandidate } from "../../src/index.js";

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
    schedule,
    scoreOf: (id: string) => result.candidates.find((item) => item.action.id === id)!.totalScore
  };
}

describe("recommendation ranking", () => {
  it("prefers a near-deadline assignment over a distant high-value project", () => {
    // The review's headline failure: a four-day assignment lost to a 120-day hobby.
    const projects = [
      project("assignment", 4, { value: 4, consequence: 4 }),
      project("hobby", 120, { value: 5, consequence: 5 })
    ];
    const actions = [
      action("assignment-draft", "assignment", 300, { consequence: 4, importance: 4, lastWorkedAt: days(-2) }),
      action("hobby-start", "hobby", 60, { consequence: 5, importance: 5 })
    ];
    const { result } = rank(projects, actions);
    expect(result.primary?.action.id).toBe("assignment-draft");
  });

  it("prefers the nearer deadline when everything else is equal", () => {
    const projects = [project("soon", 3), project("later", 45)];
    const actions = [action("soon-work", "soon", 120), action("later-work", "later", 120)];
    const { result, scoreOf } = rank(projects, actions);
    expect(result.primary?.action.id).toBe("soon-work");
    expect(scoreOf("soon-work")).toBeGreaterThan(scoreOf("later-work"));
  });

  it("prefers an at-risk project over a comfortable one", () => {
    // Two planning days offer roughly 1,530 usable minutes, so 1,400 expected minutes is genuinely tight.
    const projects = [project("tight", 2), project("roomy", 25)];
    const actions = [action("tight-work", "tight", 1_400), action("roomy-work", "roomy", 60)];
    const { result, schedule } = rank(projects, actions);
    expect(["behind", "at_risk"]).toContain(schedule.forecasts.find((item) => item.projectId === "tight")!.health);
    expect(result.primary?.action.id).toBe("tight-work");
  });

  it("does not let an unforecastable project outrank a well-forecast urgent one", () => {
    // "unknown" health carries no deadline the engine can reason about; it must not win by default.
    const projects = [project("known", 3, { consequence: 4 }), project("vague", null, { value: 5, consequence: 5 })];
    const actions = [
      action("known-work", "known", 600, { consequence: 4 }),
      action("vague-work", "vague", 60, { consequence: 5, importance: 5 })
    ];
    const { result, schedule } = rank(projects, actions);
    expect(schedule.forecasts.find((item) => item.projectId === "vague")!.health).toBe("unknown");
    expect(result.primary?.action.id).toBe("known-work");
  });

  it("does not charge a cross-project switching penalty for staying in the same project", () => {
    const projects = [project("current", 10)];
    const actions = [action("running", "current", 60), action("sibling", "current", 60)];
    const { result } = rank(projects, actions, { lastActionId: "running" });
    const sibling = result.candidates.find((item) => item.action.id === "sibling")!;
    expect(sibling.scoreComponents.switchingCost).toBe(-5);
  });

  it("gives a brand new action less neglect credit than a genuinely stale one", () => {
    const projects = [
      project("fresh", 20, { createdAt: now }),
      project("stale", 20, { createdAt: days(-60), lastWorkedAt: days(-30) })
    ];
    const actions = [
      action("fresh-work", "fresh", 60, { createdAt: now }),
      action("stale-work", "stale", 60, { createdAt: days(-60), lastWorkedAt: days(-30) })
    ];
    const { result } = rank(projects, actions);
    const fresh = result.candidates.find((item) => item.action.id === "fresh-work")!;
    const stale = result.candidates.find((item) => item.action.id === "stale-work")!;
    expect(fresh.scoreComponents.neglect!).toBeLessThan(stale.scoreComponents.neglect!);
  });

  it("keeps ranking deterministic and explains the winner", () => {
    const projects = [project("a", 5), project("b", 6)];
    const actions = [action("a-work", "a", 90), action("b-work", "b", 90)];
    const first = rank(projects, actions).result;
    const second = rank(projects, actions).result;
    expect(second.primary?.action.id).toBe(first.primary?.action.id);
    expect(second.evidence).toEqual(first.evidence);
    expect(first.evidence.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * `ranking-consistency`: one test per issue, from each issue's
 * own reproduction, plus the tier change and the maximum-session break.
 */
describe("ranking consistency: one deadline definition", () => {
  it("prefers the candidate whose own deadline is nearer, not whichever field a stale reader checked first", () => {
    // The bug: the old tie-break read `forecast.internalDeadlineAt` before `action.deadlineAt`, so a
    // sibling's own explicit, nearer deadline lost to its project's later forecast deadline. Built
    // directly against `compareCandidates`, so only the one function under test is exercised.
    const projects = new Map<string, Project>([
      ["p-near", project("p-near", 20)],
      ["p-far", project("p-far", 10)]
    ]);
    const forecasts = new Map<string, ProjectForecast>([
      [
        "p-near",
        { projectId: "p-near", health: "on_track", internalDeadlineAt: days(20) } as unknown as ProjectForecast
      ]
    ]);
    const base: Omit<RecommendationCandidate, "action"> = {
      eligible: true,
      exclusionReasons: [],
      windowBound: false,
      recommendedMinutes: 60,
      recommendedWallClockMinutes: 60,
      usableFraction: 1,
      sessionBoundary: days(1),
      totalScore: 50,
      scoreComponents: {},
      criticalRank: ORDINARY_RANK,
      criticalTier: "ordinary",
      conditionMatch: {
        status: "yes",
        missing: [],
        unknowns: [],
        reachableVia: null
      } as unknown as RecommendationCandidate["conditionMatch"]
    };
    // Its project's forecast deadline is 20 days out, but the action itself carries its own, much
    // nearer, deadline: `effectiveDeadline` must read that, not the project's.
    const nearOwnDeadline: RecommendationCandidate = {
      ...base,
      action: action("near-own-deadline", "p-near", 60, { deadlineAt: days(2) })
    };
    const farNoOverride: RecommendationCandidate = {
      ...base,
      action: action("far-no-override", "p-far", 60, {})
    };
    expect(
      effectiveDeadline({
        action: nearOwnDeadline.action,
        project: projects.get("p-near"),
        forecast: forecasts.get("p-near")
      })
    ).toEqual(days(2));
    const { order, factor } = compareCandidates(nearOwnDeadline, farNoOverride, projects, forecasts, now);
    expect(factor).toBe("deadline");
    expect(order).toBeLessThan(0);
  });
});

describe("ranking consistency: one completion definition", () => {
  it("reads the same completion bonus the score itself set, not a re-derived raw-minutes guess", () => {
    // The bug: the old tie-break recomputed "does this session finish it" from raw remainingMinutes,
    // which can disagree with the risk-adjusted figure the score already used for `completionBonus`.
    const projects = new Map<string, Project>([["p", project("p", 20)]]);
    const forecasts = new Map<string, ProjectForecast>();
    const base: Omit<RecommendationCandidate, "action" | "scoreComponents"> = {
      eligible: true,
      exclusionReasons: [],
      windowBound: false,
      recommendedMinutes: 60,
      recommendedWallClockMinutes: 60,
      usableFraction: 1,
      sessionBoundary: days(1),
      totalScore: 50,
      criticalRank: ORDINARY_RANK,
      criticalTier: "ordinary",
      conditionMatch: {
        status: "yes",
        missing: [],
        unknowns: [],
        reachableVia: null
      } as unknown as RecommendationCandidate["conditionMatch"]
    };
    const finishes: RecommendationCandidate = {
      ...base,
      action: action("finishes", "p", 60, {}),
      scoreComponents: { completionBonus: 10 }
    };
    const doesNot: RecommendationCandidate = {
      ...base,
      action: action("does-not", "p", 60, {}),
      scoreComponents: { completionBonus: 0 }
    };
    const { order, factor } = compareCandidates(finishes, doesNot, projects, forecasts, now);
    expect(factor).toBe("completion");
    expect(order).toBeLessThan(0);
  });
});

describe("ranking consistency: daily-horizon boundary fallback", () => {
  it("reports the daily horizon, not a fictitious tomorrow opening, when nothing opens before it today", () => {
    // No capacity covers `now` (it ended an hour ago); the only other opening is 30 hours out, well
    // past a 5-hour daily horizon. The fix reports the horizon itself rather than the old bug's
    // silent "no fit at all", or (before that) a stale reading of tomorrow's slot as today's boundary.
    const capacityWindows: CapacityWindow[] = [
      {
        id: "earlier-today",
        startsAt: days(0),
        endsAt: new Date(now.getTime() - 60 * 60_000),
        energy: "high",
        contexts: [],
        usableFraction: 1
      },
      {
        id: "well-past-horizon",
        startsAt: new Date(now.getTime() + 30 * 3_600_000),
        endsAt: new Date(now.getTime() + 40 * 3_600_000),
        energy: "high",
        contexts: [],
        usableFraction: 1
      }
    ];
    const projects = [project("solo", null)];
    const actions = [action("solo-work", "solo", 90, { minimumSessionMinutes: 30 })];
    const schedule = planSchedule({
      now,
      horizonEnd,
      projects,
      actions,
      capacityWindows,
      commitments: []
    });
    const dailyHorizonEnd = new Date(now.getTime() + 5 * 3_600_000);
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
      dailyHorizonEnd
    });
    expect(result.primary).toBeNull();
    expect(result.noFit?.kind).toBe("boundary");
    if (result.noFit?.kind === "boundary") {
      expect(result.noFit.boundaryKind).toBe("daily_horizon");
      expect(result.noFit.boundaryAt).toEqual(dailyHorizonEnd);
    }
  });
});

describe("ranking consistency: next fit honours latest useful start", () => {
  it("skips a window-bound candidate whose latest useful start has passed by the time capacity opens", () => {
    const capacityWindows: CapacityWindow[] = [
      {
        id: "opens-later",
        startsAt: new Date(now.getTime() + 2 * 3_600_000),
        endsAt: new Date(now.getTime() + 10 * 3_600_000),
        energy: "high",
        contexts: [],
        usableFraction: 1
      }
    ];
    const projects = [project("urgent", null, { value: 5, consequence: 5 }), project("plain", null)];
    const actions = [
      // Ranks first (higher value/consequence project), but its latest useful start passes before
      // the capacity opens, so next-fit must not offer it there.
      action("urgent-work", "urgent", 90, {
        consequence: 5,
        importance: 5,
        minimumSessionMinutes: 30,
        latestStartAt: new Date(now.getTime() + 1 * 3_600_000)
      }),
      action("plain-work", "plain", 90, { minimumSessionMinutes: 30 })
    ];
    const schedule = planSchedule({
      now,
      horizonEnd,
      projects,
      actions,
      capacityWindows,
      commitments: []
    });
    const dailyHorizonEnd = new Date(now.getTime() + 20 * 3_600_000);
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
      dailyHorizonEnd
    });
    expect(result.primary).toBeNull();
    expect(result.noFit?.kind).toBe("boundary");
    if (result.noFit?.kind === "boundary") {
      expect(result.noFit.nextFit?.targetId).toBe("plain-work");
    }
  });
});

describe("ranking consistency: importance in halves", () => {
  it("gives five importance ratings five distinct scores, unrounded", () => {
    const projects = [project("p", 20)];
    const scores = [1, 2, 3, 4, 5].map((importance) => {
      const actions = [action(`work-${importance}`, "p", 60, { importance })];
      const { scoreOf } = rank(projects, actions);
      return scoreOf(`work-${importance}`);
    });
    expect(new Set(scores).size).toBe(5);
  });

  it("carries a half-point importance component rather than rounding it away", () => {
    // Every other component driven to zero (no deadline, neutral project rating, no history, a
    // session too short to finish it) isolates `importance`'s own contribution: centred on 3 with
    // weight 2, importance 4 of 5 normalises to 0.75 and must contribute exactly +0.5, not 0 or 1.
    const projects = [project("solo", null, { value: 1, consequence: 1 })];
    const actions = [action("solo-work", "solo", 300, { importance: 4, consequence: 1, maximumSessionMinutes: 60 })];
    const { result } = rank(projects, actions);
    const candidate = result.candidates.find((item) => item.action.id === "solo-work")!;
    expect(candidate.scoreComponents.importance).toBe(0.5);
    expect(result.evidence.some((line) => line.includes("Own importance"))).toBe(true);
  });
});

describe("ranking consistency: zero-length work", () => {
  it("gives a used-up action and a windowed-out one different reasons, and the windowed one still gets a next fit", () => {
    const capacityWindows: CapacityWindow[] = [
      {
        id: "opens-later",
        startsAt: new Date(now.getTime() + 2 * 3_600_000),
        endsAt: new Date(now.getTime() + 10 * 3_600_000),
        energy: "high",
        contexts: [],
        usableFraction: 1
      }
    ];
    const projects = [project("p", null)];
    const actions = [
      action("used-up", "p", 60, { remainingMinutes: 0 }),
      action("windowed-out", "p", 90, { minimumSessionMinutes: 30 })
    ];
    const schedule = planSchedule({ now, horizonEnd, projects, actions, capacityWindows, commitments: [] });
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
      dailyHorizonEnd: new Date(now.getTime() + 20 * 3_600_000)
    });
    const usedUp = result.candidates.find((item) => item.action.id === "used-up")!;
    const windowedOut = result.candidates.find((item) => item.action.id === "windowed-out")!;
    expect(usedUp.exclusionReasons).toContain("Nothing remains; mark it done or re-estimate it.");
    expect(usedUp.windowBound).toBe(false);
    expect(windowedOut.exclusionReasons).toContain("No compatible time is open now.");
    expect(windowedOut.windowBound).toBe(true);
    expect(result.noFit?.kind).toBe("boundary");
    if (result.noFit?.kind === "boundary") expect(result.noFit.nextFit?.targetId).toBe("windowed-out");
  });
});

describe("ranking consistency: the tier change (self-set deadline this week)", () => {
  function withSelfSetDeadline(days_: number, overrides: Partial<Action> = {}) {
    return action("self-set", "solo", 60, { deadlineAt: days(days_), ...overrides });
  }

  it("a measured self-set deadline this week beats an undated sibling in the same project", () => {
    // "solo" carries its own far internal deadline (60 days out, so its forecast is measured, not
    // "unknown"); the action's own nearer deadlineAt (5 days) is what makes it self-set-this-week.
    const projects = [project("solo", 60, { value: 3, consequence: 3 })];
    const actions = [withSelfSetDeadline(5), action("undated-sibling", "solo", 60, { importance: 3, consequence: 3 })];
    const { result } = rank(projects, actions);
    expect(result.primary?.action.id).toBe("self-set");
    expect(result.primary?.criticalTier).toBe("ordinary");
    expect(result.primary?.scoreComponents.selfSetDeadline).toBe(45);
  });

  it("loses to a due external deadline this week", () => {
    const projects = [
      project("solo", 60, { value: 3, consequence: 3 }),
      project("committed", 60, { value: 3, consequence: 3, externalDeadlineAt: days(5) })
    ];
    const actions = [withSelfSetDeadline(5), action("external-work", "committed", 60)];
    const { result } = rank(projects, actions);
    expect(result.primary?.action.id).toBe("external-work");
    expect(result.primary?.criticalTier).toBe("due_this_week_external");
  });

  it("gets 30 when the project's health is unmeasured, and 0 for a cadence action", () => {
    // No deadline anywhere on the project itself, so its forecast health is "unknown" — the action's
    // own self-set deadlineAt is still what triggers the bonus, just at the unmeasured rate.
    const projects = [project("vague", null, { value: 3, consequence: 3 })];
    const actions = [
      withSelfSetDeadline(5, { projectId: "vague" }),
      action("cadence-self-set", "vague", 60, {
        deadlineAt: days(5),
        schedulingMode: "cadence",
        cadence: { intervalDays: 7, timezone: "Australia/Sydney", startDate: "2026-07-01", completionCount: 0 }
      })
    ];
    const { result } = rank(projects, actions);
    const measured = result.candidates.find((item) => item.action.id === "self-set")!;
    const cadence = result.candidates.find((item) => item.action.id === "cadence-self-set")!;
    expect(measured.scoreComponents.selfSetDeadline).toBe(30);
    expect(cadence.scoreComponents.selfSetDeadline ?? 0).toBe(0);
  });

  it("retired the due_this_week_internal and unforecastable_internal tiers", () => {
    expect(CRITICAL_TIERS).not.toContain("due_this_week_internal");
    expect(CRITICAL_TIERS).not.toContain("unforecastable_internal");
    expect(CRITICAL_TIERS.length).toBe(7);
  });
});

describe("critical path as a tie-break", () => {
  it("puts the sibling more work waits on ahead of an otherwise equal one", () => {
    // `a-lone` would win the identifier tie-break; `b-head` leads because `c-tail` waits on it.
    const { result } = rank(
      [project("p", 30)],
      [
        action("a-lone", "p", 60),
        action("b-head", "p", 60),
        action("c-tail", "p", 120, { dependencyIds: ["b-head"], dependenciesComplete: false })
      ]
    );
    const byId = (id: string) => result.candidates.find((item) => item.action.id === id)!;
    expect(byId("b-head").downstreamMinutes).toBe(120);
    expect(byId("a-lone").downstreamMinutes).toBeUndefined();
    expect(result.candidates[0]!.action.id).toBe("b-head");
    expect(result.why?.whyNot?.decidingFactor).toBe("critical_path");
  });

  it("breaks an ordinary-tier tie the same way", () => {
    const { result } = rank(
      [project("p", null)],
      [
        action("a-lone", "p", 60),
        action("b-head", "p", 60),
        action("c-tail", "p", 120, { dependencyIds: ["b-head"], dependenciesComplete: false })
      ]
    );
    expect(result.candidates[0]!.criticalTier).toBe("ordinary");
    expect(result.candidates[0]!.action.id).toBe("b-head");
    expect(result.why?.whyNot?.decidingFactor).toBe("critical_path");
  });
});
