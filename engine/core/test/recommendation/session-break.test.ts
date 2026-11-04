import { describe, expect, it } from "vitest";
import { planSchedule, recommend, resolvePlanningCapacity } from "../../src/index.js";
import { dayPlanFor, directiveFor } from "../model/day-plan-harness.js";
import type { Action, CapacityWindow, FixedCommitment, Project } from "../../src/index.js";
import type { DeliverableProjection } from "@openrhen/contracts";
import { formatTime } from "../../src/recommendation/format.js";
import { deliverableForecastUnits } from "../../src/scheduling/deliverables.js";

/**
 * `ranking-consistency`, "Break, data": an action or deliverable
 * is not eligible again until `endedAt + sessionBreakMinutes` once a session reaching at least its own
 * `maximumSessionMinutes` has ended. Never applies to the action currently running.
 */

const now = new Date("2026-08-07T07:00:00.000Z");
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const days = (count: number) => new Date(now.getTime() + count * DAY_MS);
const minutesAgo = (count: number) => new Date(now.getTime() - count * MINUTE_MS);
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
  return { result, candidateOf: (id: string) => result.candidates.find((item) => item.action.id === id)! };
}

describe("session break: an action just finished a full session", () => {
  it("excludes it until the break ends, naming the time", () => {
    const projects = [project("p", null)];
    const actions = [action("a", "p", 300, { maximumSessionMinutes: 60 })];
    const { candidateOf } = rank(projects, actions, {
      sessionBreakMinutes: 15,
      lastEndedSessions: [{ targetId: "a", endedAt: minutesAgo(5), focusedMinutes: 60 }]
    });
    const candidate = candidateOf("a");
    expect(candidate.eligible).toBe(false);
    const reason = candidate.exclusionReasons.find((item) => item.startsWith("Resting after a full session until"));
    expect(reason).toBeDefined();
    const restUntil = new Date(minutesAgo(5).getTime() + 15 * MINUTE_MS);
    expect(reason).toContain(formatTime(restUntil));
    expect(reason).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("stays eligible once the break itself has elapsed", () => {
    const projects = [project("p", null)];
    const actions = [action("a", "p", 300, { maximumSessionMinutes: 60 })];
    const { candidateOf } = rank(projects, actions, {
      sessionBreakMinutes: 15,
      lastEndedSessions: [{ targetId: "a", endedAt: minutesAgo(20), focusedMinutes: 60 }]
    });
    expect(candidateOf("a").eligible).toBe(true);
  });

  it("does not rest an action whose last session stopped short of the maximum", () => {
    const projects = [project("p", null)];
    const actions = [action("a", "p", 300, { maximumSessionMinutes: 60 })];
    const { candidateOf } = rank(projects, actions, {
      sessionBreakMinutes: 15,
      lastEndedSessions: [{ targetId: "a", endedAt: minutesAgo(5), focusedMinutes: 30 }]
    });
    expect(candidateOf("a").eligible).toBe(true);
  });

  it("never rests the action that is currently the running one", () => {
    const projects = [project("p", null)];
    const actions = [action("a", "p", 300, { maximumSessionMinutes: 60 })];
    const { candidateOf } = rank(projects, actions, {
      activeActionId: "a",
      sessionBreakMinutes: 15,
      lastEndedSessions: [{ targetId: "a", endedAt: minutesAgo(5), focusedMinutes: 60 }]
    });
    expect(candidateOf("a").eligible).toBe(true);
  });

  it("keys a deliverable candidate by its target id, not the forecast unit's own id", () => {
    const deliverable: DeliverableProjection = {
      id: "assessment",
      projectId: "p",
      title: "Assessment",
      status: "in_progress",
      approved: true,
      remainingMinutes: 150,
      minimumUsefulSessionMinutes: 20,
      uncertainty: "known",
      importance: 5,
      consequence: 5,
      partiallyBlocked: false,
      hasOpenBlockers: false,
      dependenciesSatisfied: true,
      incompletePrerequisites: [],
      hasSteps: false,
      executionOptions: [
        {
          id: "draft",
          title: "Draft it",
          optimisticMinutes: 60,
          expectedMinutes: 90,
          pessimisticMinutes: 120,
          remainingMinutes: 90,
          energy: "high",
          minimumSessionMinutes: 20,
          maximumSessionMinutes: 60,
          splittable: true,
          setupMinutes: 0,
          requirementPathways: []
        }
      ]
    };
    const [unit] = deliverableForecastUnits([deliverable]);
    const projects = [project("p", null)];
    const { candidateOf } = rank(projects, [unit as Action], {
      sessionBreakMinutes: 15,
      lastEndedSessions: [{ targetId: "assessment", endedAt: minutesAgo(5), focusedMinutes: 60 }]
    });
    const candidate = candidateOf(unit!.id);
    expect(candidate.eligible).toBe(false);
    expect(candidate.exclusionReasons.some((item) => item.startsWith("Resting after a full session until"))).toBe(true);
  });
});

describe("session break: deadline-tier work", () => {
  const overdue = () => project("late", null, { externalDeadlineAt: days(-1) });
  const justEnded = (targetId: string) => [{ targetId, endedAt: minutesAgo(5), focusedMinutes: 60 }];

  it("stays eligible and keeps Now over a low-stakes chore, saying to take the break first", () => {
    const projects = [overdue(), project("chore", null, { consequence: 1, value: 1 })];
    const actions = [
      action("late-work", "late", 300, { maximumSessionMinutes: 60 }),
      action("chore-work", "chore", 30, { consequence: 1, importance: 1 })
    ];
    const { result, candidateOf } = rank(projects, actions, {
      sessionBreakMinutes: 15,
      timezone: "Australia/Sydney",
      locale: "en-AU",
      lastEndedSessions: justEnded("late-work")
    });
    const late = candidateOf("late-work");
    expect(late.eligible).toBe(true);
    expect(late.criticalTier).toBe("overdue_external");
    expect(late.criticalReason).toContain("Take a break until");
    expect(late.criticalReason).toContain(formatTime(late.restUntil!, "Australia/Sydney", "en-AU"));
    expect(late.criticalReason).toMatch(/Take a break until [\d:]+ [ap]m first, then start this\.$/);
    expect(result.evidence.join(" ")).toContain("Take a break until");
    expect(result.primary?.action.id).toBe("late-work");
  });

  it("ranks behind equally urgent work that is not resting", () => {
    const projects = [overdue(), project("other", null, { externalDeadlineAt: days(-1) })];
    const actions = [
      action("late-work", "late", 300, { maximumSessionMinutes: 60 }),
      action("other-work", "other", 300, { maximumSessionMinutes: 60 })
    ];
    const { result } = rank(projects, actions, {
      sessionBreakMinutes: 15,
      lastEndedSessions: justEnded("late-work")
    });
    expect(result.primary?.action.id).toBe("other-work");
  });

  it("is excluded when its latest useful start falls inside the break", () => {
    const projects = [overdue()];
    const latestStartAt = new Date(now.getTime() + 5 * MINUTE_MS);
    const actions = [action("late-work", "late", 300, { maximumSessionMinutes: 60, latestStartAt })];
    const resting = rank(projects, actions, {
      sessionBreakMinutes: 15,
      timezone: "Australia/Sydney",
      locale: "en-AU",
      lastEndedSessions: justEnded("late-work")
    }).candidateOf("late-work");
    // The break ends at now + 10, after the latest useful start, so starting then is already too late.
    expect(resting.eligible).toBe(false);
    expect(resting.exclusionReasons).toContain(
      `Latest useful start, ${formatTime(latestStartAt, "Australia/Sydney", "en-AU")}, falls inside the break.`
    );
    // Control: with no break owed it is still startable now.
    expect(rank(projects, actions, { sessionBreakMinutes: 15 }).candidateOf("late-work").eligible).toBe(true);
  });
});

describe("session break: deadline work in the day plan", () => {
  const scenario = (justEnded: boolean, commitments: FixedCommitment[] = []) => {
    const projects = [project("late", null, { externalDeadlineAt: days(-1) })];
    const actions = [action("late-work", "late", 180, { maximumSessionMinutes: 60 })];
    const capacityWindows = resolvePlanningCapacity({
      now,
      horizonEnd,
      usableFraction: 1,
      ...dayBounds
    });
    const planning = planSchedule({
      now,
      horizonEnd,
      projects,
      actions,
      capacityWindows,
      commitments,
      projectedDailyProtectedMinutes: 0
    });
    const args = {
      now,
      horizonEnd,
      projects,
      actions,
      planning,
      forecasts: planning.forecasts,
      capacityWindows,
      commitments,
      currentEnergy: "high" as const,
      timezone: dayBounds.timezone,
      sessionBreakMinutes: 15,
      // The previous session of the same work just ended, so the first block must wait out its break.
      ...(justEnded
        ? { lastEndedSessions: [{ targetId: "late-work", endedAt: minutesAgo(0), focusedMinutes: 60 }] }
        : {})
    };
    const live = recommend(args);
    const plan = dayPlanFor(args, { timezone: dayBounds.timezone });
    const hhmm = (iso: string) => iso.slice(11, 16);
    const span = (blocks: typeof plan.blocks) =>
      blocks.slice(0, 3).map((block) => `${hhmm(block.startsAt)}-${hhmm(block.endsAt)}`);
    return {
      live,
      directive: directiveFor(args, { timezone: dayBounds.timezone }),
      work: span(plan.blocks.filter((block) => block.kind === "action")),
      breaks: plan.blocks.filter((block) => block.title === "Take a break"),
      blocks: plan.blocks
    };
  };

  it("separates back-to-back full sessions of overdue work by the break, and says so", () => {
    const { work, breaks, live } = scenario(false);
    expect(work).toEqual(["07:00-08:00", "08:15-09:15", "09:30-10:30"]);
    expect(breaks.slice(0, 2).map((block) => block.startsAt.slice(11, 16))).toEqual(["08:00", "09:15"]);
    expect(breaks[0]!.reason).toContain("Take a break until");
    expect(live.primary?.restUntil).toBeUndefined();
  });

  it("starts overdue work at the end of a break already owed, sized from there", () => {
    const { work, breaks, live } = scenario(true);
    expect(live.primary?.restUntil?.getTime()).toBe(now.getTime() + 15 * MINUTE_MS);
    expect(live.primary?.recommendedMinutes).toBe(60);
    expect(live.primary?.criticalReason).toContain("Take a break until");
    expect(work).toEqual(["07:15-08:15", "08:30-09:30", "09:45-10:45"]);
    expect(breaks[0]!.startsAt.slice(11, 16)).toBe("07:00");
  });

  it("places a commitment that falls inside the break instead of skipping over it", () => {
    const commitment: FixedCommitment = {
      id: "call",
      startsAt: new Date(now.getTime() + 5 * MINUTE_MS),
      endsAt: new Date(now.getTime() + 10 * MINUTE_MS)
    };
    const { live, work, blocks } = scenario(true, [commitment]);
    // The commitment is placed inside the break, and the work starts once the break is over.
    const call = blocks.find((block) => block.kind === "commitment")!;
    expect([call.startsAt.slice(11, 16), call.endsAt.slice(11, 16)]).toEqual(["07:05", "07:10"]);
    expect(work[0]).toBe("07:15-08:15");
    // Started now, a 60-minute session sized from 07:15 would run across the 07:05 call, so the work
    // rests like ordinary work rather than being offered with the break said alongside it.
    expect(live.primary?.action.id).not.toBe("late-work");
    const resting = live.candidates.find((candidate) => candidate.action.id === "late-work")!;
    expect(resting.eligible).toBe(false);
    expect(resting.restUntil).toBeUndefined();
    expect(resting.exclusionReasons.some((item) => item.startsWith("Resting after a full session until"))).toBe(true);
  });

  it("tells the live directive when the work can start", () => {
    const { live, directive } = scenario(true);
    expect(directive.kind).toBe("action");
    expect((directive as { notBefore?: string }).notBefore).toBe(live.primary!.restUntil!.toISOString());
    expect((scenario(false).directive as { notBefore?: string }).notBefore).toBeUndefined();
  });
});
