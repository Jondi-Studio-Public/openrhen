import { describe, expect, it } from "vitest";
import { planSchedule, recommend, resolvePlanningCapacity } from "../../src/index.js";
import { dayPlanFor } from "../model/day-plan-harness.js";
import type { Action, Project } from "../../src/index.js";

/**
 * Per-action energy waiver (low-energy deadlines design, PR 1). An accepted stretch drops the
 * declared-energy check for that one action; every other action stays held to the declaration.
 */

const now = new Date("2026-08-07T07:00:00.000Z");
const DAY_MS = 86_400_000;
const horizonEnd = new Date(now.getTime() + 30 * DAY_MS);
const dayBounds = { timezone: "Australia/Sydney", dayStartTime: "07:00", dayEndTime: "22:00" };

const project = (id: string): Project => ({
  id,
  status: "active",
  uncertainty: "known",
  value: 3,
  consequence: 3,
  outcomeActive: true,
  internalDeadlineAt: new Date(now.getTime() + 2 * DAY_MS)
});

const action = (id: string, projectId: string, energy: Action["energy"]): Action => ({
  id,
  projectId,
  title: id,
  status: "active",
  optimisticMinutes: 48,
  expectedMinutes: 60,
  pessimisticMinutes: 84,
  remainingMinutes: 60,
  energy,
  minimumSessionMinutes: 30,
  maximumSessionMinutes: 60,
  importance: 3,
  consequence: 3,
  contexts: [],
  dependenciesComplete: true,
  dependencyIds: [],
  splittable: true,
  setupMinutes: 0
});

function run(
  extra: { energyWaivedActionIds?: string[]; energyWaivedUntil?: Record<string, Date> } = {},
  currentEnergy: "low" | "high" = "low"
) {
  const projects = [project("p1"), project("p2")];
  const actions = [action("hard-a", "p1", "high"), action("hard-b", "p2", "high"), action("easy", "p2", "low")];
  const capacityWindows = resolvePlanningCapacity({ now, horizonEnd, usableFraction: 0.85, ...dayBounds });
  const planning = planSchedule({
    now,
    horizonEnd,
    projects,
    actions,
    capacityWindows,
    commitments: [],
    projectedDailyProtectedMinutes: 30
  });
  const args = {
    now,
    horizonEnd,
    projects,
    actions,
    planning,
    forecasts: planning.forecasts,
    capacityWindows,
    commitments: [],
    currentEnergy,
    timezone: dayBounds.timezone,
    ...extra
  };
  return { result: recommend(args), args };
}

const candidate = (result: ReturnType<typeof recommend>, id: string) =>
  result.candidates.find((item) => item.action.id === id)!;

describe("per-action energy waiver", () => {
  it("without a waiver, low energy cuts every high-energy action", () => {
    const { result } = run();
    expect(candidate(result, "hard-a").eligible).toBe(false);
    expect(candidate(result, "hard-a").exclusionReasons.join(" ")).toContain("Current energy is low");
    expect(candidate(result, "hard-b").eligible).toBe(false);
    expect(candidate(result, "easy").eligible).toBe(true);
  });

  it("waives the check for the named action only", () => {
    const { result } = run({ energyWaivedActionIds: ["hard-a"] });
    expect(candidate(result, "hard-a").eligible).toBe(true);
    expect(candidate(result, "hard-a").recommendedMinutes).toBeGreaterThan(0);
    expect(candidate(result, "hard-b").eligible).toBe(false);
    expect(candidate(result, "hard-b").exclusionReasons.join(" ")).toContain("Current energy is low");
  });

  it("leaves other eligibility rules alone for a waived action", () => {
    const projects = [project("p1")];
    const blocked = { ...action("hard-a", "p1", "high"), dependenciesComplete: false };
    const capacityWindows = resolvePlanningCapacity({ now, horizonEnd, usableFraction: 0.85, ...dayBounds });
    const planning = planSchedule({
      now,
      horizonEnd,
      projects,
      actions: [blocked],
      capacityWindows,
      commitments: [],
      projectedDailyProtectedMinutes: 30
    });
    const result = recommend({
      now,
      horizonEnd,
      projects,
      actions: [blocked],
      planning,
      forecasts: planning.forecasts,
      capacityWindows,
      commitments: [],
      currentEnergy: "low",
      energyWaivedActionIds: ["hard-a"]
    });
    const scored = candidate(result, "hard-a");
    expect(scored.eligible).toBe(false);
    expect(scored.exclusionReasons.join(" ")).toContain("dependency");
    expect(scored.exclusionReasons.join(" ")).not.toContain("Current energy");
  });

  it("ignores a waiver naming an action that is not there, and an empty list", () => {
    expect(candidate(run({ energyWaivedActionIds: ["nope"] }).result, "hard-a").eligible).toBe(false);
    expect(candidate(run({ energyWaivedActionIds: [] }).result, "hard-a").eligible).toBe(false);
  });

  it("changes nothing when energy already fits", () => {
    const plain = run({}, "high").result;
    const waived = run({ energyWaivedActionIds: ["hard-a"] }, "high").result;
    expect(waived.primary?.action.id).toBe(plain.primary?.action.id);
    expect(candidate(waived, "hard-a").totalScore).toBe(candidate(plain, "hard-a").totalScore);
  });

  it("the day plan replay honours the waiver, so the plan agrees with Now", () => {
    const base = run();
    const waived = run({ energyWaivedActionIds: ["hard-a"] });
    const titles = (args: typeof base.args) =>
      dayPlanFor(args, { timezone: dayBounds.timezone })
        .blocks.filter((block) => block.kind === "action")
        .map((block) => block.title);
    expect(titles(base.args)).not.toContain("hard-a");
    const withWaiver = titles(waived.args);
    expect(withWaiver).toContain("hard-a");
    expect(withWaiver).not.toContain("hard-b");
  });

  it("the day plan replay stops waiving an action at the instant its stretch ends", () => {
    const startsOf = (extra: Parameters<typeof run>[0]) =>
      dayPlanFor(run({ energyWaivedActionIds: ["hard-a"], ...extra }).args, { timezone: dayBounds.timezone })
        .blocks.filter((block) => block.kind === "action" && block.title === "hard-a")
        .map((block) => new Date(block.startsAt).getTime());
    const open = startsOf({});
    expect(open).toHaveLength(1);
    const start = open[0]!;
    // Still waived at the block's own start: the stretch ends after it.
    expect(startsOf({ energyWaivedUntil: { "hard-a": new Date(start + 1) } })).toEqual(open);
    // Ended at that instant (and so before it): the replay no longer waives it, so the block is gone.
    expect(startsOf({ energyWaivedUntil: { "hard-a": new Date(start) } })).toEqual([]);
    expect(startsOf({ energyWaivedUntil: { "hard-a": new Date(now.getTime() + 60_000) } })).toEqual([]);
    // An id with no entry stays waived throughout.
    expect(startsOf({ energyWaivedUntil: {} })).toEqual(open);
  });
});
