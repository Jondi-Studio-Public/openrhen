import { describe, expect, it } from "vitest";
import {
  ORDINARY_RANK,
  effectiveConsequence,
  effectiveConsequenceRefined,
  planSchedule,
  recommend,
  resolvePlanningCapacity,
  simulateContinuation
} from "../../src/index.js";
import type { Action, CapacityWindow, Project } from "../../src/index.js";

const now = new Date("2026-08-07T07:00:00.000Z");
const MIN = 60_000;
const DAY_MS = 86_400_000;
const days = (count: number) => new Date(now.getTime() + count * DAY_MS);
const horizonEnd = days(120);

const automatic = (): CapacityWindow[] =>
  resolvePlanningCapacity({
    now,
    horizonEnd,
    usableFraction: 0.85,
    timezone: "Australia/Sydney",
    dayStartTime: "07:00",
    dayEndTime: "22:00"
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
    optimisticMinutes: minutes,
    expectedMinutes: minutes,
    pessimisticMinutes: minutes,
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

function rank(projects: Project[], actions: Action[]) {
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
    currentEnergy: "high"
  });
}

describe("effectiveConsequenceRefined", () => {
  it("equals the stars version when nothing is refined", () => {
    for (const p of [1, 2, 3, 4, 5]) {
      for (const a of [1, 3, 5]) {
        const proj = project("p", null, { consequence: p });
        const act = action("a", "p", 30, { consequence: a });
        expect(effectiveConsequenceRefined(act, proj)).toBe(effectiveConsequence(act, proj));
      }
    }
    expect(effectiveConsequenceRefined(action("a", "p", 30), undefined)).toBe(
      effectiveConsequence(action("a", "p", 30), undefined)
    );
  });

  it("clamps each input to 1..5 separately, then mixes 0.6/0.4", () => {
    const proj = project("p", null, { consequence: 3, consequenceRefined: 6 });
    const act = action("a", "p", 30, { consequence: 3, consequenceRefined: 0 });
    expect(effectiveConsequenceRefined(act, proj)).toBeCloseTo(0.6 * 5 + 0.4 * 1, 12);
    expect(effectiveConsequenceRefined(act, project("p", null))).toBeCloseTo(0.6 * 3 + 0.4 * 1, 12);
  });

  it("leaves effectiveConsequence on stars only", () => {
    const proj = project("p", null, { consequence: 3, consequenceRefined: 4.5 });
    const act = action("a", "p", 30, { consequence: 2, consequenceRefined: 1.2 });
    expect(effectiveConsequence(act, proj)).toBeCloseTo(0.6 * 3 + 0.4 * 2, 12);
  });
});

describe("consequenceRefined in ordinary ranking", () => {
  it("changes only the 0-15 consequence component, and a missing value changes nothing", () => {
    const projects = [project("a", null), project("b", null)];
    const plain = rank(projects, [action("a-work", "a", 60), action("b-work", "b", 60)]);
    const refinedOnes = rank(projects, [
      action("a-work", "a", 60, { consequenceRefined: 4.6 }),
      action("b-work", "b", 60, { consequenceRefined: 1.4 })
    ]);
    const before = plain.candidates.find((c) => c.action.id === "a-work")!;
    const after = refinedOnes.candidates.find((c) => c.action.id === "a-work")!;
    expect(after.scoreComponents.consequence).toBeGreaterThan(before.scoreComponents.consequence!);
    for (const candidate of refinedOnes.candidates) {
      expect(candidate.scoreComponents.consequence!).toBeGreaterThanOrEqual(0);
      expect(candidate.scoreComponents.consequence!).toBeLessThanOrEqual(15);
    }
    const { consequence: _b, ...beforeRest } = before.scoreComponents;
    const { consequence: _a, ...afterRest } = after.scoreComponents;
    expect(afterRest).toEqual(beforeRest);
    // A plan with no refined values anywhere is today's behaviour exactly.
    const undefinedOnes = rank(projects, [action("a-work", "a", 60), action("b-work", "b", 60)]);
    expect(undefinedOnes).toEqual(plain);
  });

  it("cannot exceed the component range with out-of-range refined values", () => {
    const r = rank(
      [project("a", null, { consequenceRefined: 6 })],
      [action("a-work", "a", 60, { consequenceRefined: 6 })]
    );
    expect(r.candidates[0]!.scoreComponents.consequence).toBe(15);
    const low = rank(
      [project("a", null, { consequenceRefined: 0 })],
      [action("a-work", "a", 60, { consequenceRefined: 0 })]
    );
    expect(low.candidates[0]!.scoreComponents.consequence).toBe(0);
  });

  it("breaks an ordinary score tie by the refined value", () => {
    // 3.4 and 3.1 both round to 8 consequence points, so the score ties and only the tiebreak can separate them.
    const projects = [project("a", null), project("b", null)];
    const result = rank(projects, [
      action("a-work", "a", 60, { consequenceRefined: 3.4 }),
      action("b-work", "b", 60, { consequenceRefined: 3.1 })
    ]);
    const [first, second] = result.candidates.filter((c) => c.criticalRank === ORDINARY_RANK);
    expect(first!.totalScore).toBe(second!.totalScore);
    expect(first!.action.id).toBe("a-work");
    const flipped = rank(projects, [
      action("a-work", "a", 60, { consequenceRefined: 3.1 }),
      action("b-work", "b", 60, { consequenceRefined: 3.4 })
    ]);
    expect(flipped.candidates.filter((c) => c.criticalRank === ORDINARY_RANK)[0]!.action.id).toBe("b-work");
  });
});

describe("deadline tiers and continuation ignore refined values", () => {
  const scenarios: Array<{ name: string; projects: Project[]; actions: Action[] }> = [
    {
      name: "two tight deadlines of different stakes",
      projects: [project("x", 0.3, { consequence: 2 }), project("y", 0.3, { consequence: 5 }), project("z", null)],
      actions: [action("x-work", "x", 120), action("y-work", "y", 120), action("z-work", "z", 30)]
    },
    {
      name: "equal stars, tight deadlines",
      projects: [project("x", 0.4), project("y", 0.4), project("z", 2)],
      actions: [action("x-work", "x", 150), action("y-work", "y", 150), action("z-work", "z", 90)]
    },
    {
      name: "tight deadline with action-level stars",
      projects: [project("x", 0.35, { consequence: 4 }), project("y", 0.35, { consequence: 4 })],
      actions: [action("x-work", "x", 120, { consequence: 1 }), action("y-work", "y", 120, { consequence: 5 })]
    }
  ];
  // Refined values that invert the star order as hard as the bounds allow.
  const invert = <T extends { consequence: number }>(record: T): T => ({
    ...record,
    consequenceRefined: record.consequence >= 3 ? record.consequence - 1 : record.consequence + 1
  });

  for (const scenario of scenarios) {
    it(`orders the critical tiers identically with and without refined values: ${scenario.name}`, () => {
      const plain = rank(scenario.projects, scenario.actions);
      const refined = rank(scenario.projects.map(invert), scenario.actions.map(invert));
      const critical = (r: typeof plain) =>
        r.candidates.filter((c) => c.criticalRank < ORDINARY_RANK).map((c) => [c.action.id, c.criticalRank] as const);
      expect(critical(plain).length).toBeGreaterThan(0);
      expect(critical(refined)).toEqual(critical(plain));
    });
  }

  it("makes the same continuation decision with and without refined values", () => {
    const run = (refine: boolean) => {
      const cleaning = project("cleaning", null, {
        internalDeadlineAt: new Date(now.getTime() + 48 * 60 * MIN),
        consequence: 1,
        value: 1
      });
      const study = project("study", null, {
        internalDeadlineAt: new Date(now.getTime() + 8 * 60 * MIN),
        consequence: 3,
        ...(refine ? { consequenceRefined: 0.5 } : {})
      });
      const other = { ...cleaning, ...(refine ? { consequenceRefined: 6 } : {}) };
      return simulateContinuation({
        now,
        horizonEnd: new Date(now.getTime() + 8 * 60 * MIN),
        projects: [other, study],
        capacityWindows: [
          {
            id: "day",
            startsAt: now,
            endsAt: new Date(now.getTime() + 8 * 60 * MIN),
            energy: "high",
            contexts: [],
            usableFraction: 1
          }
        ],
        commitments: [],
        actions: [
          action("clean", "cleaning", 240, { energy: "low", remainingMinutes: 180, maximumSessionMinutes: 240 }),
          action("study-draft", "study", 300, { maximumSessionMinutes: 240 })
        ],
        actionId: "clean",
        requestedMinutes: 180
      });
    };
    expect(run(true)).toEqual(run(false));
  });
});
