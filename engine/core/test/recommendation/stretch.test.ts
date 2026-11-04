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

// External deadline in one day for 6h of work: certainly losing margin or behind.
const tight = () => project("tight", { externalDeadlineAt: at(DAY_MS) });
const bigHigh = (overrides: Partial<Action> = {}) =>
  action("unit-3", "tight", "high", {
    remainingMinutes: 360,
    expectedMinutes: 360,
    optimisticMinutes: 300,
    pessimisticMinutes: 480,
    ...overrides
  });

describe("stretch offers", () => {
  it("offers a high-energy action with a tight external deadline to someone who declared low, capped at 45", () => {
    const result = run([tight()], [bigHigh()]);
    const offer = result.stretchOffer;
    expect(offer).toBeDefined();
    expect(offer).toMatchObject({
      actionId: "unit-3",
      declaredEnergy: "low",
      requiredEnergy: "high",
      energyGap: 2,
      cappedAtMinutes: 45
    });
    expect(offer!.minutes).toBeLessThanOrEqual(45);
    expect(offer!.minutes).toBeGreaterThan(0);
    expect(offer!.externalDeadlineAt?.getTime()).toBe(at(DAY_MS).getTime());
    expect(["overdue_external", "behind_external", "at_risk_external"]).toContain(offer!.reason);
  });

  it("a one-step gap (medium for high) is not capped", () => {
    const offer = run([tight()], [bigHigh()], { currentEnergy: "medium" }).stretchOffer;
    expect(offer).toMatchObject({ declaredEnergy: "medium", energyGap: 1, cappedAtMinutes: null });
    expect(offer!.minutes).toBeGreaterThan(45);
  });

  it("does not change the ranking, eligibility or tiers", () => {
    const withOffer = run([tight()], [bigHigh(), action("easy", "tight", "low")]);
    const { stretchOffer: _o, ...rest } = withOffer;
    expect(withOffer.stretchOffer).toBeDefined();
    const candidate = withOffer.candidates.find((c) => c.action.id === "unit-3")!;
    expect(candidate.eligible).toBe(false);
    expect(candidate.exclusionReasons.join(" ")).toContain("Current energy is low");
    expect(rest.primary?.action.id).toBe("easy");
  });

  it("offers nothing when energy is fresh enough to fit, or absent (stale), or recovery", () => {
    expect(run([tight()], [bigHigh()], { currentEnergy: "high" }).stretchOffer).toBeUndefined();
    expect(run([tight()], [bigHigh()], { noEnergy: true }).stretchOffer).toBeUndefined();
    expect(run([tight()], [bigHigh()], { currentEnergy: "recovery" }).stretchOffer).toBeUndefined();
  });

  it("offers nothing for a self-set deadline", () => {
    const own = project("own", { internalDeadlineAt: at(DAY_MS) });
    expect(run([own], [bigHigh({ projectId: "own" })]).stretchOffer).toBeUndefined();
  });

  it("offers nothing when low energy is not the only blocker", () => {
    const result = run([tight()], [bigHigh({ dependenciesComplete: false })]);
    expect(result.stretchOffer).toBeUndefined();
  });

  it("offers nothing when the external deadline is far away and the tier is ordinary", () => {
    const far = project("far", { externalDeadlineAt: at(20 * DAY_MS) });
    expect(
      run([far], [bigHigh({ projectId: "far", remainingMinutes: 60, expectedMinutes: 60 })]).stretchOffer
    ).toBeUndefined();
  });

  it("a declined action is skipped and the next qualifying one is offered; declining everything offers nothing", () => {
    const projects = [tight(), project("tight2", { externalDeadlineAt: at(DAY_MS) })];
    const actions = [bigHigh(), bigHigh({ id: "unit-4", title: "unit-4", projectId: "tight2" })];
    const first = run(projects, actions).stretchOffer!;
    const other = first.actionId === "unit-3" ? "unit-4" : "unit-3";
    const next = run(projects, actions, { stretch: { declinedActionIds: [first.actionId] } }).stretchOffer;
    expect(next?.actionId).toBe(other);
    expect(
      run(projects, actions, { stretch: { declinedActionIds: [first.actionId, other] } }).stretchOffer
    ).toBeUndefined();
    expect(run(projects, actions, { stretch: { declinedAll: true } }).stretchOffer).toBeUndefined();
  });

  it("after a decline with nothing else qualifying, Now falls back to the normal low-energy answer", () => {
    const result = run([tight()], [bigHigh(), action("easy", "tight", "low")], {
      stretch: { declinedActionIds: ["unit-3"] }
    });
    expect(result.stretchOffer).toBeUndefined();
    expect(result.primary?.action.id).toBe("easy");
  });

  it("offers an overdue external deadline's action", () => {
    const late = project("late", { externalDeadlineAt: at(-DAY_MS) });
    const offer = run([late], [bigHigh({ projectId: "late", remainingMinutes: 60, expectedMinutes: 60 })]).stretchOffer;
    expect(offer?.reason).toBe("overdue_external");
    expect(offer?.externalDeadlineAt?.getTime()).toBe(at(-DAY_MS).getTime());
  });

  describe("the 48-hour clause (tier still ordinary)", () => {
    const near = () => project("near", { externalDeadlineAt: at(36 * HOUR) });
    const small = () =>
      bigHigh({
        projectId: "near",
        remainingMinutes: 60,
        expectedMinutes: 60,
        optimisticMinutes: 48,
        pessimisticMinutes: 84
      });

    it("offers only when the latest safe start falls before the next wake", () => {
      const baseline = run([near()], [small()]);
      const lss = baseline.stretchOffer?.latestSafeStartAt;
      expect(baseline.stretchOffer?.reason).toBe("external_within_48h");
      expect(lss).toBeInstanceOf(Date);
      // Wake before the latest safe start: sleeping and starting fresh still fits, so no offer tonight.
      const wakesFirst = run([near()], [small()], { stretch: { nextWakeAt: new Date(lss!.getTime() - HOUR) } });
      expect(wakesFirst.stretchOffer).toBeUndefined();
      // Latest safe start comes before the wake: tonight is the last chance, so it is offered.
      const wakesAfter = run([near()], [small()], { stretch: { nextWakeAt: new Date(lss!.getTime() + HOUR) } });
      expect(wakesAfter.stretchOffer?.actionId).toBe("unit-3");
    });

    it("does not offer a deadline beyond 48 hours", () => {
      const far = project("near", { externalDeadlineAt: at(60 * HOUR) });
      expect(run([far], [small()]).stretchOffer).toBeUndefined();
    });
  });

  it("is offered when every candidate is blocked (no primary)", () => {
    const result = run([tight()], [bigHigh()]);
    expect(result.primary).toBeNull();
    expect(result.stretchOffer?.actionId).toBe("unit-3");
  });

  it("offers nothing while a protected commitment holds the clock", () => {
    const result = run([tight()], [bigHigh()], {
      commitments: [{ id: "class", title: "Class", startsAt: at(-HOUR), endsAt: at(HOUR) }]
    });
    expect(result.protectedCommitment).toBeDefined();
    expect(result.stretchOffer).toBeUndefined();
  });

  it("skips an option whose deliverable has another option that fits the declared energy", () => {
    const options = [
      bigHigh({ id: "opt-hard", title: "opt-hard", deliverableId: "D" }),
      action("opt-easy", "tight", "low", { deliverableId: "D" })
    ];
    const result = run([tight()], options);
    expect(result.primary?.action.id).toBe("opt-easy");
    expect(result.stretchOffer).toBeUndefined();
  });

  it("a date inside 48h still qualifies when the latest safe start was not measured", () => {
    const near = project("near", { externalDeadlineAt: at(36 * HOUR) });
    const result = run([near], [bigHigh({ projectId: "near", remainingMinutes: 60, expectedMinutes: 60 })], {
      forecasts: [],
      stretch: { nextWakeAt: at(8 * HOUR) }
    });
    expect(result.stretchOffer).toMatchObject({ reason: "external_within_48h", latestSafeStartAt: null });
  });
});
