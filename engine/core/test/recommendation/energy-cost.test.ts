import { describe, expect, it } from "vitest";
import { planSchedule, recommend, resolvePlanningCapacity } from "../../src/index.js";
import type { Action, Project, RecommendArguments } from "../../src/index.js";

/** Stretch offers (low-energy deadlines design, PR 2): derived from eligibility, tier and a rescore. */

const now = new Date("2026-08-07T07:00:00.000Z");
const HOUR = 3_600_000;
const DAY_MS = 24 * HOUR;
const horizonEnd = new Date(now.getTime() + 30 * DAY_MS);
const dayBounds = { timezone: "Australia/Sydney", dayStartTime: "07:00", dayEndTime: "22:00" };
const at = (ms: number) => new Date(now.getTime() + ms);

const project = (id: string, overrides: Partial<Project> = {}): Project => ({
  id,
  status: "active",
  uncertainty: "known",
  value: 3,
  consequence: 3,
  outcomeActive: true,
  ...overrides
});

const action = (id: string, projectId: string, energy: Action["energy"], overrides: Partial<Action> = {}): Action => ({
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
  maximumSessionMinutes: 90,
  importance: 3,
  consequence: 3,
  contexts: [],
  dependenciesComplete: true,
  dependencyIds: [],
  splittable: true,
  setupMinutes: 0,
  ...overrides
});

function run(
  projects: Project[],
  actions: Action[],
  { noEnergy = false, ...extra }: Partial<RecommendArguments> & { noEnergy?: boolean } = {}
) {
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
  return recommend({
    now,
    horizonEnd,
    projects,
    actions,
    planning,
    forecasts: planning.forecasts,
    capacityWindows,
    commitments: [],
    ...(noEnergy ? {} : { currentEnergy: "low" as const }),
    timezone: dayBounds.timezone,
    ...extra
  });
}

const far = () => project("far", { externalDeadlineAt: at(20 * DAY_MS) });
const smallHigh = (id: string, projectId: string, overrides: Partial<Action> = {}) =>
  action(id, projectId, "high", { title: id, remainingMinutes: 60, expectedMinutes: 60, ...overrides });

describe("energy cost note", () => {
  it("counts actions only the declared energy keeps out", () => {
    const result = run(
      [far()],
      [smallHigh("a", "far"), smallHigh("b", "far"), action("mid", "far", "medium"), action("easy", "far", "low")]
    );
    expect(result.energyCost).toEqual({ declaredEnergy: "low", blockedCount: 3, dueSoon: [] });
  });

  it("does not count an action blocked by something else too", () => {
    const result = run(
      [far()],
      [smallHigh("a", "far"), smallHigh("dep", "far", { dependenciesComplete: false }), action("easy", "far", "low")]
    );
    expect(result.energyCost?.blockedCount).toBe(1);
  });

  it("does not count recovery work or an option whose deliverable has another that fits", () => {
    const result = run(
      [far()],
      [
        smallHigh("opt-hard", "far", { deliverableId: "D" }),
        action("opt-easy", "far", "low", { deliverableId: "D" }),
        action("rest", "far", "recovery")
      ]
    );
    expect(result.energyCost).toBeUndefined();
  });

  it("counts blocked options of one deliverable once, and lists it once in dueSoon", () => {
    const soon = project("soon", { externalDeadlineAt: at(10 * HOUR) });
    const result = run(
      [soon, far()],
      [
        smallHigh("opt-1", "soon", { deliverableId: "D" }),
        smallHigh("opt-2", "soon", { deliverableId: "D" }),
        smallHigh("other", "far")
      ]
    );
    expect(result.energyCost?.blockedCount).toBe(2);
    expect(result.energyCost?.dueSoon).toHaveLength(1);
  });

  it("does not count an action already waived by an active stretch", () => {
    const result = run([far()], [smallHigh("a", "far"), smallHigh("b", "far")], { energyWaivedActionIds: ["a"] });
    expect(result.energyCost?.blockedCount).toBe(1);
  });

  it("is absent when nothing is blocked, energy is stale, or energy is recovery or sufficient", () => {
    expect(run([far()], [action("easy", "far", "low")]).energyCost).toBeUndefined();
    expect(run([far()], [smallHigh("a", "far")], { noEnergy: true }).energyCost).toBeUndefined();
    expect(run([far()], [smallHigh("a", "far")], { currentEnergy: "recovery" }).energyCost).toBeUndefined();
    expect(run([far()], [smallHigh("a", "far")], { currentEnergy: "high" }).energyCost).toBeUndefined();
  });

  it("names blocked actions with an external date inside 48 hours, earliest first", () => {
    const projects = [
      project("soon", { externalDeadlineAt: at(36 * HOUR) }),
      project("sooner", { externalDeadlineAt: at(10 * HOUR) }),
      far()
    ];
    const result = run(projects, [smallHigh("a", "soon"), smallHigh("b", "sooner"), smallHigh("c", "far")]);
    expect(result.energyCost?.blockedCount).toBe(3);
    expect(result.energyCost?.dueSoon.map((entry) => entry.actionId)).toEqual(["b", "a"]);
    expect(result.energyCost?.dueSoon[0]?.deadlineAt?.getTime()).toBe(at(10 * HOUR).getTime());
  });

  it("names an overdue external action, but not one with only a far or self-set date", () => {
    const late = project("late", { externalDeadlineAt: at(-DAY_MS) });
    const own = project("own", { internalDeadlineAt: at(10 * HOUR) });
    const result = run([late, own, far()], [smallHigh("a", "late"), smallHigh("b", "own"), smallHigh("c", "far")]);
    expect(result.energyCost?.blockedCount).toBe(3);
    expect(result.energyCost?.dueSoon.map((entry) => entry.actionId)).toEqual(["a"]);
    expect(result.energyCost?.dueSoon[0]?.deadlineAt?.getTime()).toBe(at(-DAY_MS).getTime());
  });

  it("does not change the candidates, primary or stretch offer", () => {
    const projects = [project("tight", { externalDeadlineAt: at(DAY_MS) }), far()];
    const actions = [
      action("unit-3", "tight", "high", {
        remainingMinutes: 360,
        expectedMinutes: 360,
        optimisticMinutes: 300,
        pessimisticMinutes: 480
      }),
      smallHigh("a", "far"),
      action("easy", "far", "low")
    ];
    const withNote = run(projects, actions);
    expect(withNote.energyCost?.blockedCount).toBe(2);
    const { energyCost: _note, ...rest } = withNote;
    // Ranking, eligibility and tiers are what the energy cut alone decides (pinned in stretch.test.ts):
    // the blocked action stays ineligible, the primary is the one that fits, and a second run agrees.
    expect(rest.primary?.action.id).toBe("easy");
    expect(withNote.stretchOffer?.actionId).toBe("unit-3");
    const again = run(projects, actions);
    const { energyCost: _again, ...rest2 } = again;
    expect(rest2).toEqual(rest);
    expect(withNote.candidates.map((c) => [c.action.id, c.eligible, c.criticalTier, c.totalScore])).toEqual(
      again.candidates.map((c) => [c.action.id, c.eligible, c.criticalTier, c.totalScore])
    );
    expect(withNote.candidates.find((c) => c.action.id === "a")?.eligible).toBe(false);
  });

  it("is absent while a protected commitment holds the clock", () => {
    const result = run([far()], [smallHigh("a", "far")], {
      commitments: [{ id: "class", title: "Class", startsAt: at(-HOUR), endsAt: at(HOUR) }]
    });
    expect(result.protectedCommitment).toBeDefined();
    expect(result.energyCost).toBeUndefined();
  });
});
