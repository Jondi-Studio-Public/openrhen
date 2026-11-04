import { describe, expect, it } from "vitest";
import { planSchedule, recommend, resolvePlanningCapacity } from "../../src/index.js";
import { calculatePlanAndForecast } from "../../src/index.js";
import { planForecastRequestSchema } from "@openrhen/contracts";
import { formatDate, localisePlanText } from "../../src/recommendation/format.js";
import { choice } from "../../src/recommendation/recommend.js";
import type { RecommendationCandidate } from "../../src/index.js";
import overdueFixture from "../snapshot-replay/synthetic/overdue-external-outranks-unknown-forecast.json" with { type: "json" };
import type { Action, CapacityWindow, Project } from "../../src/index.js";

/**
 * Reason text is read by a person: dates are local and plain, a shortfall has a size and a fix, and
 * "why this" says where two candidates actually differ.
 */

const now = new Date("2026-08-07T07:00:00.000Z");
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const days = (count: number) => new Date(now.getTime() + count * DAY_MS);
const horizonEnd = days(180);
const timezone = "Australia/Sydney";
const locale = "en-AU";
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const automatic = (): CapacityWindow[] =>
  resolvePlanningCapacity({
    now,
    horizonEnd,
    usableFraction: 0.85,
    timezone,
    dayStartTime: "07:00",
    dayEndTime: "22:00"
  });

function project(id: string, overrides: Partial<Project> = {}): Project {
  return { id, status: "active", uncertainty: "known", value: 3, consequence: 3, outcomeActive: true, ...overrides };
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
  return recommend({
    now,
    horizonEnd,
    projects,
    actions,
    planning: schedule,
    forecasts: schedule.forecasts,
    capacityWindows,
    commitments: [],
    currentEnergy: "high",
    timezone,
    locale,
    ...overrides
  });
}

/** Every string anywhere in the output, with where it was found. Dates are not strings and are skipped. */
function strings(value: unknown, path = "$", found: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === "string") found.push([path, value]);
  else if (Array.isArray(value)) value.forEach((item, index) => strings(item, `${path}[${index}]`, found));
  else if (value && typeof value === "object" && !(value instanceof Date))
    for (const [key, item] of Object.entries(value)) strings(item, `${path}.${key}`, found);
  return found;
}

const scenarios: Record<string, () => ReturnType<typeof recommend>> = {
  "behind an external deadline": () =>
    rank([project("p", { externalDeadlineAt: days(2) })], [action("work", "p", 3000, { maximumSessionMinutes: 120 })]),
  "at risk against an external deadline": () =>
    rank([project("p", { externalDeadlineAt: days(12) })], [action("work", "p", 6200, { maximumSessionMinutes: 120 })]),
  "overdue external": () =>
    rank([project("p", { externalDeadlineAt: days(-1) })], [action("work", "p", 120, { maximumSessionMinutes: 60 })]),
  "resting after a full session": () =>
    rank(
      [project("p", { externalDeadlineAt: days(-1) }), project("q")],
      [action("work", "p", 300), action("other", "q", 60, { availableFrom: days(2) })],
      {
        lastEndedSessions: [{ targetId: "work", endedAt: new Date(now.getTime() - 5 * MINUTE_MS), focusedMinutes: 60 }]
      }
    ),
  "ordinary candidates": () =>
    rank(
      [project("p", { value: 5, lastWorkedAt: days(-6) }), project("q", { lastWorkedAt: days(-1) })],
      [action("a", "p", 120), action("b", "q", 120)]
    )
};

/** The sentences a forecast carries: its reasons, its proposal and its interventions. */
const forecastText = (forecasts: Array<Record<string, any>>) =>
  forecasts.flatMap((forecast) => [
    ...(forecast.reasons ?? []),
    ...(forecast.proposal ? [forecast.proposal.reason] : []),
    ...(forecast.interventions ?? []).map((item: { reason: string }) => item.reason)
  ]) as string[];

describe("reason text", () => {
  for (const [name, run] of Object.entries(scenarios)) {
    it(`never prints an ISO timestamp: ${name}`, () => {
      const result = run();
      const offenders = strings(result).filter(([, text]) => ISO.test(text));
      expect(offenders.map(([path, text]) => `${path}: ${text}`)).toEqual([]);
    });
  }

  it("sizes a shortfall and names the smallest lever when a project is behind", () => {
    const reason = scenarios["behind an external deadline"]!().primary?.criticalReason ?? "";
    expect(reason).toMatch(/Short by \d+h( \d+m)?: \d+h( \d+m)? of work against \d+h( \d+m)? of time before /);
    expect(reason).toMatch(/extension|Adding|pausing|split|estimate/);
  });

  it("names the right shape lever: split indivisible work, shorten a minimum session", () => {
    // Enough minutes, but every window (four of 45 minutes) is shorter than the session the work needs.
    const windows: CapacityWindow[] = [1, 2, 3, 4].map((day) => ({
      id: `w${day}`,
      startsAt: new Date(days(day).getTime()),
      endsAt: new Date(days(day).getTime() + 45 * MINUTE_MS),
      energy: "high",
      contexts: [],
      usableFraction: 1
    }));
    const leverOf = (overrides: Partial<Action>) => {
      const projects = [project("p", { externalDeadlineAt: days(6) })];
      const actions = [
        action("work", "p", 120, {
          optimisticMinutes: 120,
          pessimisticMinutes: 120,
          maximumSessionMinutes: 120,
          ...overrides
        })
      ];
      const schedule = planSchedule({ now, horizonEnd, projects, actions, capacityWindows: windows, commitments: [] });
      const forecast = schedule.forecasts[0]!;
      expect(forecast.schedulingBlocked).toBe(true);
      const result = recommend({
        now,
        horizonEnd,
        projects,
        actions,
        planning: schedule,
        forecasts: schedule.forecasts,
        capacityWindows: windows,
        commitments: [],
        currentEnergy: "high",
        timezone,
        locale
      });
      return result.candidates.find((item) => item.action.id === "work")?.criticalReason ?? "";
    };
    expect(leverOf({ minimumSessionMinutes: 60 })).toContain("Shortening the minimum session would let it fit.");
    expect(leverOf({ splittable: false, minimumSessionMinutes: 120 })).toContain(
      "Allowing the work to be split would let it fit."
    );
  });

  describe("lead and trail wording", () => {
    const candidate = (
      id: string,
      criticalRank: number,
      criticalTier: string,
      totalScore: number,
      scoreComponents: Record<string, number>
    ) =>
      ({
        action: { id, title: id },
        criticalRank,
        criticalTier,
        totalScore,
        scoreComponents
      }) as unknown as RecommendationCandidate;

    it("says a runner-up trails a higher-tier pick, however its score compares", () => {
      const primary = candidate("due", 1, "behind_external", 10, { neglect: 2 });
      const runnerUp = candidate("chore", 6, "ordinary", 40, { neglect: 30 });
      expect(choice(runnerUp, primary).reason).toMatch(/^Trails due on tier: /);
      expect(choice(primary, runnerUp).reason).toMatch(/^Leads chore on tier: /);
    });

    it("lets neither of two level scores claim the lead", () => {
      const a = candidate("a", 6, "ordinary", 20, { neglect: 12, value: 8 });
      const b = candidate("b", 6, "ordinary", 20, { neglect: 8, value: 12 });
      expect(choice(a, b).reason).not.toMatch(/^Leads|^Trails/);
      expect(choice(b, a).reason).not.toMatch(/^Leads|^Trails/);
    });
  });

  it("sizes an external-only shortfall to the submission buffer it was measured against", () => {
    const projects = [project("p", { externalDeadlineAt: days(2) })];
    const actions = [action("work", "p", 3000, { maximumSessionMinutes: 120 })];
    const reason = rank(projects, actions).primary?.criticalReason ?? "";
    const schedule = planSchedule({
      now,
      horizonEnd,
      projects,
      actions,
      capacityWindows: automatic(),
      commitments: [],
      projectedDailyProtectedMinutes: 30
    });
    const forecast = schedule.forecasts[0]!;
    // The scheduler measured capacity to the buffer's start, earlier than the external date itself.
    expect(forecast.internalDeadlineAt!.getTime()).toBeLessThan(days(2).getTime());
    expect(reason).toContain(
      `of time before your submission buffer starts on ${formatDate(forecast.internalDeadlineAt!, timezone, locale)}.`
    );
  });

  it("gives an at-risk project its margin against the threshold", () => {
    const candidate = scenarios["at risk against an external deadline"]!();
    const reason = candidate.primary?.criticalReason ?? "";
    expect(reason).toMatch(/Only \d+% margin remains, under the 20% it needs\./);
  });

  it("contrasts winner and runner-up components in the ordinary tier, penalties included", () => {
    const result = scenarios["ordinary candidates"]!();
    const winner = result.why.because?.reason ?? "";
    const runnerUp = result.why.whyNot?.reason ?? "";
    expect(winner).toMatch(/^Leads b|^Leads a/);
    expect(winner).toMatch(/mainly on .+ \([+−]\d+(\.\d)? vs [+−]\d+(\.\d)?\)/);
    expect(runnerUp).toMatch(/^Trails /);
    expect(winner).not.toBe(runnerUp);
  });

  it("writes forecast proposals and interventions in local time too", () => {
    const projects = [project("p", { internalDeadlineAt: days(-1), externalDeadlineAt: days(10) })];
    const actions = [action("work", "p", 120)];
    const raw = planSchedule({
      now,
      horizonEnd,
      projects,
      actions,
      capacityWindows: automatic(),
      commitments: [],
      projectedDailyProtectedMinutes: 30
    });
    expect(forecastText(raw.forecasts).some((text) => ISO.test(text))).toBe(true);
    const local = localisePlanText(raw, timezone, locale);
    expect(forecastText(local.forecasts).filter((text) => ISO.test(text))).toEqual([]);
    expect(local.forecasts[0]!.proposal?.reason).toContain("Your own target passed at Thu, 6 Aug, 5:00 pm");
  });

  it("returns no ISO timestamp anywhere in the forecasts of a whole plan", () => {
    const result = calculatePlanAndForecast(planForecastRequestSchema.parse(overdueFixture.request));
    const sentences = forecastText(
      ((result.schedule as { forecasts?: unknown } | null)?.forecasts ?? []) as Array<Record<string, any>>
    );
    expect(sentences.length).toBeGreaterThan(0);
    expect(sentences.filter((text) => ISO.test(text))).toEqual([]);
  });
});
