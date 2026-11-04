import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  conditionDefinitionSchema,
  currentSituationSchema,
  type ConditionDefinition,
  type TransportMode
} from "@openrhen/contracts";
import {
  analyzeDependencies,
  planSchedule,
  projectSituation,
  recommend,
  resolvePlanningCapacity
} from "../../src/index.js";
import type { Action, CapacityWindow, FixedCommitment, Project, ProjectForecast } from "../../src/index.js";
import { dayPlanFor } from "../model/day-plan-harness.js";

const now = new Date("2026-08-07T07:00:00.000Z");
const DAY_MS = 86_400_000;
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
const days = (count: number) => new Date(now.getTime() + count * DAY_MS);
const dayBounds = { timezone: "Australia/Sydney", dayStartTime: "07:00", dayEndTime: "22:00" };

function project(id: string, deadline: Date, overrides: Partial<Project> = {}): Project {
  return {
    id,
    status: "active",
    uncertainty: "known",
    internalDeadlineAt: deadline,
    value: 3,
    consequence: 3,
    outcomeActive: true,
    ...overrides
  };
}

function action(id: string, projectId: string, minutes = 60, overrides: Partial<Action> = {}): Action {
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
    maximumSessionMinutes: 120,
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

function window(
  id: string,
  startMinutes: number,
  endMinutes: number,
  energy: CapacityWindow["energy"] = "high"
): CapacityWindow {
  return { id, startsAt: at(startMinutes), endsAt: at(endMinutes), energy, contexts: [], usableFraction: 1 };
}

function plan(overrides: Partial<Parameters<typeof planSchedule>[0]> = {}) {
  return planSchedule({
    now,
    horizonEnd: days(30),
    projects: [project("p", days(10))],
    actions: [action("a", "p", 120)],
    capacityWindows: [window("w", 0, 30 * 24 * 60)],
    commitments: [],
    ...overrides
  });
}

describe("capacity properties", () => {
  it("never lets usable capacity per day increase as the horizon lengthens", () => {
    const capacityWindows = resolvePlanningCapacity({
      now,
      horizonEnd: days(180),
      usableFraction: 0.85,
      ...dayBounds
    });
    const result = planSchedule({
      now,
      horizonEnd: days(180),
      projects: [project("p", days(10))],
      actions: [action("a", "p", 120)],
      capacityWindows,
      commitments: [],
      projectedDailyProtectedMinutes: 30
    });
    const perDay = result.capacityEnvelopes.map((envelope) => {
      const span = (envelope.endsAt.getTime() - envelope.startsAt.getTime()) / DAY_MS;
      return span > 0 ? envelope.adjustedCapacityMinutes / span : 0;
    });
    expect(perDay).toHaveLength(5);
    for (const [index, value] of perDay.entries()) {
      if (index === 0) continue;
      expect(value).toBeLessThanOrEqual(perDay[index - 1]!);
    }
    // A day can never offer more than the daily planning window itself.
    expect(perDay[0]).toBeLessThanOrEqual(15 * 60);
  });

  it("cannot improve feasibility by removing capacity", () => {
    const generous = plan({ capacityWindows: [window("w", 0, 30 * 24 * 60)] });
    const scarce = plan({ capacityWindows: [window("w", 0, 200)] });
    expect(scarce.forecasts[0]!.compatibleCapacityMinutes!).toBeLessThanOrEqual(
      generous.forecasts[0]!.compatibleCapacityMinutes!
    );
    expect(scarce.forecasts[0]!.expectedMarginMinutes!).toBeLessThanOrEqual(
      generous.forecasts[0]!.expectedMarginMinutes!
    );
  });

  it("cannot increase slack by adding work", () => {
    const light = plan({ actions: [action("a", "p", 120)] });
    const heavy = plan({ actions: [action("a", "p", 120), action("b", "p", 240)] });
    expect(heavy.forecasts[0]!.expectedMarginMinutes!).toBeLessThan(light.forecasts[0]!.expectedMarginMinutes!);
    expect(heavy.forecasts[0]!.marginRatio!).toBeLessThan(light.forecasts[0]!.marginRatio!);
  });

  it("never allocates inside a fixed commitment", () => {
    const commitments: FixedCommitment[] = [
      { id: "class", startsAt: at(60), endsAt: at(180), setupBeforeMinutes: 15, transitionAfterMinutes: 15 }
    ];
    const result = plan({ capacityWindows: [window("w", 0, 600)], commitments, actions: [action("a", "p", 300)] });
    const blockedStart = at(45).getTime();
    const blockedEnd = at(195).getTime();
    for (const block of result.allocations) {
      expect(block.startsAt.getTime() >= blockedEnd || block.endsAt.getTime() <= blockedStart).toBe(true);
    }
    expect(
      result.slots.filter((slot) => slot.availability === "fixed").every((slot) => slot.capacityMinutes === 0)
    ).toBe(true);
  });

  it("never spends recovery capacity on ordinary work", () => {
    const result = plan({
      capacityWindows: [window("recovery", 0, 600, "recovery")],
      actions: [action("a", "p", 120, { energy: "low" })]
    });
    expect(result.allocations).toHaveLength(0);
    // Guard against passing vacuously: the recovery capacity must actually be present, just unusable.
    expect(result.slots.some((slot) => slot.availability === "protected")).toBe(true);
    expect(result.slots.every((slot) => slot.availability !== "free")).toBe(true);
  });

  it("never allocates an action before its dependencies", () => {
    const actions = [
      action("first", "p", 60),
      action("second", "p", 60, { dependencyIds: ["first"] }),
      action("third", "p", 60, { dependencyIds: ["second"] })
    ];
    const result = plan({ capacityWindows: [window("w", 0, 1_200)], actions });
    const earliest = (id: string) =>
      Math.min(...result.allocations.filter((block) => block.actionId === id).map((block) => block.startsAt.getTime()));
    const latestEnd = (id: string) =>
      Math.max(...result.allocations.filter((block) => block.actionId === id).map((block) => block.endsAt.getTime()));
    expect(result.allocations.length).toBeGreaterThan(0);
    expect(latestEnd("first")).toBeLessThanOrEqual(earliest("second"));
    expect(latestEnd("second")).toBeLessThanOrEqual(earliest("third"));
  });

  it("rejects dependency cycles instead of ordering them", () => {
    const analysis = analyzeDependencies([
      action("a", "p", 30, { dependencyIds: ["b"] }),
      action("b", "p", 30, { dependencyIds: ["a"] })
    ]);
    expect(analysis.order).toHaveLength(0);
    expect(analysis.errors.some((error) => error.startsWith("Dependency cycle"))).toBe(true);
  });

  it("returns identical output for identical input", () => {
    const first = plan();
    const second = plan();
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
  });
});

/**
 * The same invariants, asserted over generated inputs rather than one chosen example.
 *
 * The examples above document *why* each rule exists and stay as the readable record of it; these say
 * the rule holds across the shape of input the engine actually receives. Generators are deliberately
 * small — a handful of projects and actions, whole quarter-hours, horizons of days not months — so a
 * counterexample is short enough to read and the suite still runs in seconds.
 */

/** Fixed so a failure reproduces exactly, in CI and on a laptop, without re-rolling the input. */
const SEED = 20_260_818;
const assertion = { numRuns: 100, seed: SEED } as const;

const quarterHours = fc.integer({ min: 1, max: 8 });

const projectShape = fc.record({
  deadlineDays: fc.integer({ min: 2, max: 20 }),
  value: fc.integer({ min: 1, max: 5 }),
  consequence: fc.integer({ min: 1, max: 5 }),
  uncertainty: fc.constantFrom<Project["uncertainty"]>("known", "some", "high")
});

// Recovery is excluded: it is a demand no ordinary window serves, and mixing it in would make every
// capacity comparison below a statement about energy compatibility instead of about capacity.
const actionShape = fc.record({
  quarterHours,
  projectSlot: fc.nat({ max: 5 }),
  energy: fc.constantFrom<Action["energy"]>("high", "medium", "low"),
  splittable: fc.boolean()
});

interface Scenario {
  projects: Project[];
  actions: Action[];
  capacityWindows: CapacityWindow[];
  commitments: FixedCommitment[];
  now: Date;
  horizonEnd: Date;
}

const scenarios = fc
  .record({
    projects: fc.array(projectShape, { minLength: 1, maxLength: 3 }),
    actions: fc.array(actionShape, { minLength: 1, maxLength: 4 }),
    capacityHours: fc.integer({ min: 4, max: 120 }),
    horizonDays: fc.integer({ min: 5, max: 25 })
  })
  .map((shape): Scenario => {
    const projects = shape.projects.map((item, index) =>
      project(`p${index}`, days(item.deadlineDays), {
        value: item.value,
        consequence: item.consequence,
        uncertainty: item.uncertainty
      })
    );
    const actions = shape.actions.map((item, index) =>
      action(`a${index}`, projects[item.projectSlot % projects.length]!.id, item.quarterHours * 15, {
        energy: item.energy,
        splittable: item.splittable
      })
    );
    return {
      projects,
      actions,
      capacityWindows: [window("w", 0, shape.capacityHours * 60)],
      commitments: [],
      now,
      horizonEnd: days(shape.horizonDays)
    };
  });

/** Margins keyed by project, skipping projects the engine could not put a number on. */
function marginsByProject(forecasts: ProjectForecast[]): Map<string, number> {
  return new Map(
    forecasts.flatMap((forecast) =>
      typeof forecast.expectedMarginMinutes === "number"
        ? ([[forecast.projectId, forecast.expectedMarginMinutes]] as [string, number][])
        : []
    )
  );
}

/** A deterministic shuffle, so a reordering failure reproduces from the seed like any other. */
function rotate<T>(items: T[], by: number): T[] {
  if (items.length < 2) return [...items];
  const offset = ((by % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

describe("generated capacity and forecasting properties", () => {
  it("never improves feasibility by removing capacity", () => {
    fc.assert(
      fc.property(scenarios, fc.integer({ min: 1, max: 9 }), (scenario, tenths) => {
        const generous = planSchedule(scenario);
        const window = scenario.capacityWindows[0]!;
        const shortened = new Date(
          window.startsAt.getTime() + Math.round((window.endsAt.getTime() - window.startsAt.getTime()) * (tenths / 10))
        );
        const scarce = planSchedule({
          ...scenario,
          capacityWindows: [{ ...window, endsAt: shortened }]
        });
        const before = marginsByProject(generous.forecasts);
        for (const [projectId, margin] of marginsByProject(scarce.forecasts)) {
          if (before.has(projectId)) expect(margin).toBeLessThanOrEqual(before.get(projectId)!);
        }
      }),
      assertion
    );
  });

  it("never increases a margin by adding work", () => {
    fc.assert(
      fc.property(scenarios, quarterHours, (scenario, extraQuarters) => {
        const light = planSchedule(scenario);
        const heavy = planSchedule({
          ...scenario,
          actions: [
            ...scenario.actions,
            action("extra", scenario.projects[0]!.id, extraQuarters * 15, { energy: "low" })
          ]
        });
        const before = marginsByProject(light.forecasts);
        for (const [projectId, margin] of marginsByProject(heavy.forecasts)) {
          if (before.has(projectId)) expect(margin).toBeLessThanOrEqual(before.get(projectId)!);
        }
      }),
      assertion
    );
  });

  it("never increases a margin by adding recurring demand from a maintenance project", () => {
    fc.assert(
      fc.property(scenarios, quarterHours, (scenario, extraQuarters) => {
        // A maintenance project (no deadline, only a recurring action) whose own demand only ever
        // grows between the two runs — mirroring "adding work cannot increase margin" (above) for
        // recurring demand specifically, since the standing pass reserves it through a
        // different path than an ordinary action's.
        const maint = project("maint-property", scenario.now, {});
        const { internalDeadlineAt: _omit, ...undatedMaint } = maint;
        const recurringDemand = (minutes: number) =>
          action("maint-recurring", "maint-property", minutes, {
            schedulingMode: "recurring",
            availableFrom: scenario.now,
            deadlineAt: scenario.horizonEnd
          });
        const light = planSchedule({
          ...scenario,
          projects: [...scenario.projects, undatedMaint as Project],
          actions: [...scenario.actions, recurringDemand(15)]
        });
        const heavy = planSchedule({
          ...scenario,
          projects: [...scenario.projects, undatedMaint as Project],
          actions: [...scenario.actions, recurringDemand(15 + extraQuarters * 15)]
        });
        const before = marginsByProject(light.forecasts);
        for (const [projectId, margin] of marginsByProject(heavy.forecasts)) {
          if (before.has(projectId)) expect(margin).toBeLessThanOrEqual(before.get(projectId)!);
        }
      }),
      assertion
    );
  });

  it("never spends recovery capacity on ordinary work", () => {
    fc.assert(
      fc.property(scenarios, (scenario) => {
        const result = planSchedule({
          ...scenario,
          capacityWindows: scenario.capacityWindows.map((item) => ({ ...item, energy: "recovery" as const }))
        });
        expect(result.allocations).toHaveLength(0);
        // Not vacuous: the recovery capacity is present, it is simply never converted into work time.
        expect(result.slots.some((slot) => slot.availability === "protected")).toBe(true);
      }),
      assertion
    );
  });

  it("never allocates an action before the dependencies it waits on", () => {
    // An unallocated action has no order to violate, so those pairs are skipped — and counted, so the
    // property cannot pass by never having placed anything in the first place.
    let comparedPairs = 0;
    fc.assert(
      fc.property(scenarios, (scenario) => {
        const chained = scenario.actions.map((item, index) =>
          index === 0 ? item : { ...item, projectId: scenario.actions[0]!.projectId, dependencyIds: [`a${index - 1}`] }
        );
        const result = planSchedule({ ...scenario, actions: chained });
        const blocks = (id: string) => result.allocations.filter((block) => block.actionId === id);
        for (const [index, item] of chained.entries()) {
          if (index === 0) continue;
          const earlier = blocks(chained[index - 1]!.id);
          const later = blocks(item.id);
          if (!earlier.length || !later.length) continue;
          comparedPairs += 1;
          const latestEnd = Math.max(...earlier.map((block) => block.endsAt.getTime()));
          const earliestStart = Math.min(...later.map((block) => block.startsAt.getTime()));
          expect(latestEnd).toBeLessThanOrEqual(earliestStart);
        }
      }),
      assertion
    );
    expect(comparedPairs).toBeGreaterThan(0);
  });

  it("never allocates an action before a dependency in a different project", () => {
    // Same chain, but left in whichever project `projectSlot` gave it — a dependency edge that
    // crosses projects, which the two-way bound (schedule.ts's global `placedStart`/`placedEnd`)
    // has to enforce exactly as the same-project case above.
    let comparedPairs = 0;
    fc.assert(
      fc.property(scenarios, (scenario) => {
        const chained = scenario.actions.map((item, index) =>
          index === 0 ? item : { ...item, dependencyIds: [`a${index - 1}`] }
        );
        const result = planSchedule({ ...scenario, actions: chained });
        const blocks = (id: string) => result.allocations.filter((block) => block.actionId === id);
        for (const [index, item] of chained.entries()) {
          if (index === 0) continue;
          const earlier = blocks(chained[index - 1]!.id);
          const later = blocks(item.id);
          if (!earlier.length || !later.length) continue;
          comparedPairs += 1;
          const latestEnd = Math.max(...earlier.map((block) => block.endsAt.getTime()));
          const earliestStart = Math.min(...later.map((block) => block.startsAt.getTime()));
          expect(latestEnd).toBeLessThanOrEqual(earliestStart);
        }
      }),
      assertion
    );
    expect(comparedPairs).toBeGreaterThan(0);
  });

  it("reproduces the same plan and ranking, array order included, for identical input", () => {
    fc.assert(
      fc.property(scenarios, (scenario) => {
        const first = planSchedule(scenario);
        const second = planSchedule(scenario);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        expect(JSON.stringify(recommend({ ...scenario, planning: second }))).toBe(
          JSON.stringify(recommend({ ...scenario, planning: first }))
        );
        expect(JSON.stringify(dayPlanFor({ ...scenario, planning: second }))).toBe(
          JSON.stringify(dayPlanFor({ ...scenario, planning: first }))
        );
      }),
      assertion
    );
  });

  it("decides the same way whatever order the inputs arrive in", () => {
    fc.assert(
      fc.property(scenarios, fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 4 }), (scenario, by, alsoBy) => {
        const reordered = {
          ...scenario,
          projects: rotate(scenario.projects, by),
          actions: rotate(scenario.actions, alsoBy)
        };
        const baseline = planSchedule(scenario);
        const shuffled = planSchedule(reordered);
        // Forecast rows are emitted in the order the projects were handed over, so identity is compared
        // per project. What must not move is any decision: which minutes an action gets, and in what
        // order the candidates rank.
        const byProject = new Map(shuffled.forecasts.map((forecast) => [forecast.projectId, forecast]));
        expect([...byProject.keys()].sort()).toEqual(baseline.forecasts.map((item) => item.projectId).sort());
        expect(JSON.stringify(shuffled.allocations)).toBe(JSON.stringify(baseline.allocations));
        expect(JSON.stringify(shuffled.slots)).toBe(JSON.stringify(baseline.slots));
        // Byte-for-byte, not merely equal by value. A plan is stored and diffed as JSON, so the bytes
        // have to be a safe identity for it. `latestSafeStarts` is a record keyed by action, and a
        // record remembers the order its keys were inserted in — which used to be the order the actions
        // arrived in, making two runs over identical facts serialize differently. The keys are now
        // sorted at construction, so reordering the input cannot move a single byte.
        for (const forecast of baseline.forecasts)
          expect(JSON.stringify(byProject.get(forecast.projectId))).toBe(JSON.stringify(forecast));
        const ranked = (planning: typeof baseline, input: Scenario) =>
          recommend({ ...input, planning }).candidates.map((candidate) => candidate.action.id);
        expect(ranked(shuffled, reordered)).toEqual(ranked(baseline, scenario));
        // The projected day is the same ranking replayed forward, so it must not move a byte either.
        expect(JSON.stringify(dayPlanFor({ ...reordered, planning: shuffled }))).toBe(
          JSON.stringify(dayPlanFor({ ...scenario, planning: baseline }))
        );
      }),
      assertion
    );
  });
});

/**
 * The two directions the travel policy must never move in.
 *
 * Trips are the one place the engine tells someone to go somewhere, so the failure modes worth
 * ruling out are the ones that would make it pushy: taking away a way to travel must never conjure a
 * journey, and a longer journey must never make the work behind it more attractive.
 */
describe("generated travel properties", () => {
  const place = (id: string, travelMinutes?: number): ConditionDefinition =>
    conditionDefinitionSchema.parse({ id, name: id, kind: "location", ...(travelMinutes ? { travelMinutes } : {}) });
  const somewhere = (id: string, projectId: string, at?: string) =>
    action(id, projectId, 60, {
      maximumSessionMinutes: 60,
      ...(at ? { requirementPathways: [{ id: `${id}:at`, contextIds: [at] }] } : {})
    });

  function rank(travelMinutes: number, modes: TransportMode[]) {
    const definitions = [place("home"), place("campus", travelMinutes)];
    const situation = currentSituationSchema.parse({
      locationId: "home",
      locationSetAt: now.toISOString(),
      transportModes: modes
    });
    const scenario = {
      now,
      horizonEnd: days(30),
      projects: [project("p", days(10)), project("q", days(10))],
      actions: [somewhere("lab", "p", "campus"), somewhere("desk", "q")],
      capacityWindows: [window("w", 0, 12 * 60)],
      commitments: [] as FixedCommitment[]
    };
    const projection = projectSituation({
      from: { at: now, situation, resolvedLocationId: "home" },
      homeLocationId: "home",
      definitions,
      commitments: [],
      sleepPlans: [],
      through: days(1)
    });
    const result = recommend({
      ...scenario,
      planning: planSchedule(scenario),
      conditionDefinitions: definitions,
      currentSituation: situation,
      travel: { travelBetween: projection.travelBetween, presences: [], anchors: [] }
    });
    return {
      trips: new Set(result.candidates.flatMap((item) => (item.trip ? [item.action.id] : []))),
      order: result.candidates.map((item) => item.action.id),
      primary: result.primary?.action.id ?? null
    };
  }

  it("never conjures a trip by taking away a way to travel", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 120 }),
        fc.uniqueArray(fc.constantFrom<TransportMode>("car", "bike", "walk"), { minLength: 1, maxLength: 3 }),
        (travelMinutes, modes) => {
          const full = rank(travelMinutes, modes);
          // Not vacuous the other way either: with a way to travel, campus really is on offer.
          expect(full.trips).toEqual(new Set(["lab"]));
          for (const dropped of modes) {
            const fewer = rank(
              travelMinutes,
              modes.filter((mode) => mode !== dropped)
            );
            for (const id of fewer.trips) expect(full.trips.has(id)).toBe(true);
          }
          // Not vacuous: with every mode gone nothing elsewhere is offered at all.
          expect(rank(travelMinutes, []).trips.size).toBe(0);
        }
      ),
      { ...assertion, numRuns: 25 }
    );
  });

  it("never promotes a trip by making the journey longer", () => {
    fc.assert(
      fc.property(fc.integer({ min: 5, max: 90 }), fc.integer({ min: 1, max: 60 }), (travelMinutes, extra) => {
        const near = rank(travelMinutes, ["car"]);
        const far = rank(travelMinutes + extra, ["car"]);
        for (const id of far.trips) {
          if (!near.trips.has(id)) continue;
          expect(far.order.indexOf(id)).toBeGreaterThanOrEqual(near.order.indexOf(id));
        }
        // And a trip that did not lead when it was closer cannot start leading now.
        if (far.primary && far.trips.has(far.primary)) expect(near.primary).toBe(far.primary);
      }),
      { ...assertion, numRuns: 25 }
    );
  });
});

describe("generated horizon properties", () => {
  // Fewer runs than the rest: each one resolves months of automatic capacity and plans against it, so
  // a hundred would trade seconds of suite time for inputs that differ only in the band boundaries.
  it("never lets a later confidence band offer more capacity per day than an earlier one", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 30, max: 180 }),
        fc.integer({ min: 5, max: 10 }),
        fc.integer({ min: 0, max: 120 }),
        (horizonDays, usableTenths, protectedMinutes) => {
          const capacityWindows = resolvePlanningCapacity({
            now,
            horizonEnd: days(horizonDays),
            usableFraction: usableTenths / 10,
            ...dayBounds
          });
          const result = planSchedule({
            now,
            horizonEnd: days(horizonDays),
            projects: [project("p", days(10))],
            actions: [action("a", "p", 120)],
            capacityWindows,
            commitments: [],
            projectedDailyProtectedMinutes: protectedMinutes
          });
          const perDay = result.capacityEnvelopes.map((envelope) => {
            const span = (envelope.endsAt.getTime() - envelope.startsAt.getTime()) / DAY_MS;
            return span > 0 ? envelope.adjustedCapacityMinutes / span : 0;
          });
          for (const [index, value] of perDay.entries()) {
            if (index === 0) continue;
            expect(value).toBeLessThanOrEqual(perDay[index - 1]!);
          }
          // A generated day can never buy more than the daily planning window it came from.
          if (perDay.length) expect(perDay[0]).toBeLessThanOrEqual(15 * 60);
        }
      ),
      { ...assertion, numRuns: 20 }
    );
  }, 30_000);
});
