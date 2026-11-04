import { describe, expect, it } from "vitest";
import { planSchedule } from "../../src/index.js";
import type { Action, CapacityWindow, Project } from "../../src/index.js";

/**
 * Pinned cases for the forecast reservation design note steps 2-4: band-slot ledgers, tail-
 * first per-action reservation across bands, and the CPM pass with two-way dependency bounds,
 * held-back chains and the undated-prerequisite pre-pass. One case per issue, from the issue's
 * own reproduction, per the plan's Testing section.
 */

const now = new Date("2026-08-07T07:00:00.000Z");
const DAY_MS = 86_400_000;
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
const days = (count: number) => new Date(now.getTime() + count * DAY_MS);

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

function action(id: string, projectId: string, minutes: number, overrides: Partial<Action> = {}): Action {
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
    maximumSessionMinutes: 480,
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
  overrides: Partial<CapacityWindow> = {}
): CapacityWindow {
  return {
    id,
    startsAt: at(startMinutes),
    endsAt: at(endMinutes),
    energy: "high",
    usableFraction: 1,
    ...overrides
  };
}

describe("invariant 1 — band-slot ledger totals match the old aggregate within rounding", () => {
  it("a lone project's compatible capacity through a partial band equals the band ledger's own adjusted total", () => {
    // Uniform, fully compatible capacity across the whole horizon so nothing narrows what the
    // project could draw from any slot — the only question invariant 1 asks is whether the new
    // per-slot ledgers sum to the same total the old aggregate math produced.
    const capacityWindows = [window("w", 0, 200 * 24 * 60)];
    const deadline = days(20); // inside the weekly band (14-30 days), so it spans detailed+daily whole and weekly partial
    const result = planSchedule({
      now,
      horizonEnd: days(200),
      projects: [project("p", deadline)],
      actions: [action("a", "p", 30)],
      capacityWindows,
      commitments: []
    });
    const forecast = result.forecasts.find((f) => f.projectId === "p")!;
    const detailed = result.capacityEnvelopes.find((e) => e.kind === "detailed")!;
    const daily = result.capacityEnvelopes.find((e) => e.kind === "daily")!;
    const weekly = result.capacityEnvelopes.find((e) => e.kind === "weekly")!;
    const weeklyFraction =
      (deadline.getTime() - weekly.startsAt.getTime()) / (weekly.endsAt.getTime() - weekly.startsAt.getTime());
    const expected =
      detailed.adjustedCapacityMinutes +
      daily.adjustedCapacityMinutes +
      weekly.adjustedCapacityMinutes * weeklyFraction;
    // "Unchanged within rounding": the per-slot ledger sums to the same aggregate total, not to an
    // exact float — each band's own slot segmentation rounds independently.
    expect(forecast.grossCompatibleCapacityMinutes).toBeGreaterThan(expected - 5);
    expect(forecast.grossCompatibleCapacityMinutes).toBeLessThan(expected + 5);
    // Nothing else is competing, so available equals gross exactly.
    expect(forecast.compatibleCapacityMinutes).toBe(forecast.grossCompatibleCapacityMinutes);
  });
});

describe("tail-first reservation across bands", () => {
  it("does not pack a far project's work into this week when band capacity can carry it", () => {
    const capacityWindows = [window("w", 0, 60 * 24 * 60)];
    const far = project("far", days(45));
    const result = planSchedule({
      now,
      horizonEnd: days(60),
      projects: [far],
      actions: [action("far-action", "far", 120)],
      capacityWindows,
      commitments: []
    });
    // Placed entirely from band capacity (tail-first, from the latest compatible band down):
    // no real detailed-slot block reserved for it, so this week's exact ledger is untouched.
    expect(result.allocations).toHaveLength(0);
    const detailed = result.capacityEnvelopes.find((e) => e.kind === "detailed")!;
    expect(detailed.reservedMinutes).toBe(0);
    // Its latest safe start reads as a real, far-out pressure point, not "no pressure" and not
    // this week.
    const latestSafeStart = result.forecasts.find((f) => f.projectId === "far")!.latestSafeStarts["far-action"];
    expect(latestSafeStart).not.toBeNull();
    expect(latestSafeStart!.getTime()).toBeGreaterThan(days(7).getTime());
  });

  it("still lets a near project take this week's capacity even when a far project also exists", () => {
    const capacityWindows = [window("w", 0, 60 * 24 * 60)];
    const near = project("near", days(3));
    const far = project("far", days(45));
    const result = planSchedule({
      now,
      horizonEnd: days(60),
      projects: [near, far],
      actions: [action("near-action", "near", 60), action("far-action", "far", 120)],
      capacityWindows,
      commitments: []
    });
    const nearBlocks = result.allocations.filter((b) => b.projectId === "near");
    // The single-figure 60 is reserved at its padded 69 (known multiplier 1.15).
    expect(nearBlocks.reduce((sum, b) => sum + b.minutes, 0)).toBeCloseTo(69, 6);
    expect(result.allocations.some((b) => b.projectId === "far")).toBe(false);
  });
});

describe("per-slot band ledgers (the office/home probe)", () => {
  it("two context-disjoint projects in the same band do not compete for one shared pool", () => {
    // Disjoint in time as well as context — an office slot and a home slot on different days, so
    // neither project could physically touch the other's window. The old aggregate pool shared one
    // number across both regardless; the per-slot ledger must not.
    const officeWindow = window("office", 40 * 24 * 60, 40.5 * 24 * 60, { contexts: ["office"] });
    const homeWindow = window("home", 41 * 24 * 60, 41.5 * 24 * 60, { contexts: ["home"] });
    const capacityWindows = [officeWindow, homeWindow];
    const office = project("office-project", days(45));
    const home = project("home-project", days(50));
    const build = (first: Project, second: Project) =>
      planSchedule({
        now,
        horizonEnd: days(60),
        projects: [first, second],
        actions: [
          action("office-action", "office-project", 60, {
            contexts: ["office"],
            requirementPathways: [{ id: "o", contextIds: ["office"] }]
          }),
          action("home-action", "home-project", 60, {
            contexts: ["home"],
            requirementPathways: [{ id: "h", contextIds: ["home"] }]
          })
        ],
        capacityWindows,
        commitments: []
      });
    // Office has the earlier deadline in the first run, home in the second — swapping which one is
    // processed first must not change either one's `reservedByEarlierDeadlinesMinutes`, because the
    // two never physically compete (invariant 6, the office/home probe).
    const officeFirst = build(office, home);
    const homeFirst = build({ ...home, internalDeadlineAt: days(40) }, { ...office, internalDeadlineAt: days(41) });
    for (const result of [officeFirst, homeFirst]) {
      for (const forecast of result.forecasts) expect(forecast.reservedByEarlierDeadlinesMinutes).toBe(0);
    }
  });
});

describe("cross-project dependency bounds", () => {
  // Both deadlines sit inside the detailed band so the bound is checkable on real, exact blocks
  // (`result.allocations`) rather than on band-aggregate placement.
  it("bounds a dependant by its prerequisite's placed end whichever project is placed first", () => {
    const earlyFirst = planSchedule({
      now,
      horizonEnd: days(30),
      projects: [project("prereq-project", days(4)), project("dependant-project", days(6))],
      actions: [
        action("prereq", "prereq-project", 120),
        action("dependant", "dependant-project", 60, { dependencyIds: ["prereq"] })
      ],
      capacityWindows: [window("w", 0, 7 * 24 * 60)],
      commitments: []
    });
    expect(earlyFirst.allocations.some((b) => b.actionId === "prereq")).toBe(true);
    expect(earlyFirst.allocations.some((b) => b.actionId === "dependant")).toBe(true);
    const prereqEnd = Math.max(
      ...earlyFirst.allocations.filter((b) => b.actionId === "prereq").map((b) => b.endsAt.getTime())
    );
    const dependantStart = Math.min(
      ...earlyFirst.allocations.filter((b) => b.actionId === "dependant").map((b) => b.startsAt.getTime())
    );
    expect(dependantStart).toBeGreaterThanOrEqual(prereqEnd);

    // Now the dependant's project has the EARLIER deadline (processed first, before its own
    // prerequisite even exists in the ledger yet) — the bound must still hold, applied the other way.
    const dependantFirst = planSchedule({
      now,
      horizonEnd: days(30),
      projects: [project("prereq-project", days(6)), project("dependant-project", days(4))],
      actions: [
        action("prereq", "prereq-project", 120),
        action("dependant", "dependant-project", 60, { dependencyIds: ["prereq"] })
      ],
      capacityWindows: [window("w", 0, 7 * 24 * 60)],
      commitments: []
    });
    expect(dependantFirst.allocations.some((b) => b.actionId === "prereq")).toBe(true);
    expect(dependantFirst.allocations.some((b) => b.actionId === "dependant")).toBe(true);
    const prereqEnd2 = Math.max(
      ...dependantFirst.allocations.filter((b) => b.actionId === "prereq").map((b) => b.endsAt.getTime())
    );
    const dependantStart2 = Math.min(
      ...dependantFirst.allocations.filter((b) => b.actionId === "dependant").map((b) => b.startsAt.getTime())
    );
    expect(dependantStart2).toBeGreaterThanOrEqual(prereqEnd2);
  });

  it("holds back a chain behind a blocked prerequisite, transitively, across projects", () => {
    const p1 = project("p1", days(5));
    const p2 = project("p2", days(5));
    const p3 = project("p3", days(5));
    const result = planSchedule({
      now,
      horizonEnd: days(30),
      projects: [p1, p2, p3],
      actions: [
        action("blocked", "p1", 60, { status: "blocked" }),
        action("middle", "p2", 60, { dependencyIds: ["blocked"] }),
        // Each held-back project also carries an independent, forecastable action, so the excluded
        // one's effort is reported separately rather than tipping the whole project to Unknown.
        action("middle-other", "p2", 30),
        action("leaf", "p3", 60, { dependencyIds: ["middle"] }),
        action("leaf-other", "p3", 30)
      ],
      capacityWindows: [window("w", 0, 30 * 24 * 60)],
      commitments: []
    });
    expect(result.allocations.some((b) => b.actionId === "middle")).toBe(false);
    expect(result.allocations.some((b) => b.actionId === "leaf")).toBe(false);
    expect(result.allocations.some((b) => b.actionId === "middle-other")).toBe(true);
    expect(result.allocations.some((b) => b.actionId === "leaf-other")).toBe(true);
    const middleForecast = result.forecasts.find((f) => f.projectId === "p2")!;
    const leafForecast = result.forecasts.find((f) => f.projectId === "p3")!;
    expect(middleForecast.blockedEffortMinutes).toBeGreaterThan(0);
    expect(leafForecast.blockedEffortMinutes).toBeGreaterThan(0);
    expect(leafForecast.reasons.some((reason) => reason.includes("held back"))).toBe(true);
  });

  it("places an undated active project's prerequisite in a pre-pass for its dated dependant", () => {
    const { internalDeadlineAt: _omit, ...undated } = project("undated", days(1));
    const dated = project("dated", days(5));
    const result = planSchedule({
      now,
      horizonEnd: days(30),
      projects: [undated, dated],
      actions: [action("prereq", "undated", 60), action("dependant", "dated", 60, { dependencyIds: ["prereq"] })],
      capacityWindows: [window("w", 0, 7 * 24 * 60)],
      commitments: []
    });
    // Both fall inside the detailed band, so the prerequisite is placed as real, exact blocks even
    // though its own project carries no deadline to be feasible against.
    expect(result.allocations.some((b) => b.actionId === "prereq")).toBe(true);
    const prereqEnd = Math.max(
      ...result.allocations.filter((b) => b.actionId === "prereq").map((b) => b.endsAt.getTime())
    );
    const dependantStart = Math.min(
      ...result.allocations.filter((b) => b.actionId === "dependant").map((b) => b.startsAt.getTime())
    );
    expect(dependantStart).toBeGreaterThanOrEqual(prereqEnd);
    const undatedForecast = result.forecasts.find((f) => f.projectId === "undated")!;
    expect(undatedForecast.health).toBe("unknown");
    expect(undatedForecast.latestSafeStarts["prereq"]).not.toBeNull();
    expect(undatedForecast.reasons.some((reason) => reason.startsWith("Needed by"))).toBe(true);
  });
});

describe("monotone allocation, leftover folding and the maximum-session break", () => {
  it("100/40 capacity, minimum session 50, 110 risk-adjusted minutes required -> 100 placed, not 60", () => {
    // Two disjoint capacity regions inside the detailed band: 40 minutes right against the deadline
    // (processed first, tail-first) and 100 minutes further back, with a one-minute uncovered gap
    // between them so they are genuinely two separate candidate groups. The 40-minute group is the
    // very first thing tail-first touches for this action, so there is no run yet to fold it into: it
    // is dropped whole rather than standing as an illegal 40-minute session (invariant 5). The
    // 100-minute group is then taken in full, because shrinking it would only strand its own
    // 10-minute remainder (40 minutes of capacity elsewhere, itself already spent) — monotone
    // placement means that remainder stands as-is rather than the old code's habit of
    // shrinking the take to protect a minimum session it can no longer reach anyway.
    const capacityWindows = [window("late", 150, 190), window("early", 0, 100)];
    // PERT so the risk-adjusted figure the reservation targets (111) sits above the expected,
    // unbuffered figure (100) that `unplacedUnitIds` reads: the 11-minute shortfall must land as an
    // At-risk reason on the project, never as an unplaced unit.
    const result = planSchedule({
      now,
      horizonEnd: days(2),
      projects: [project("p", days(1))],
      actions: [
        action("a", "p", 100, {
          minimumSessionMinutes: 50,
          maximumSessionMinutes: 480,
          optimisticMinutes: 71,
          expectedMinutes: 100,
          remainingMinutes: 100,
          pessimisticMinutes: 129
        })
      ],
      capacityWindows,
      commitments: []
    });
    const placed = result.allocations.filter((b) => b.actionId === "a").reduce((sum, b) => sum + b.minutes, 0);
    expect(placed).toBe(100);
    // All 100 placed minutes come from the "early" (100-minute) window; the too-small "late" group
    // was dropped whole, not partially spent.
    expect(
      result.allocations.filter((b) => b.actionId === "a").every((b) => b.startsAt.getTime() < at(100).getTime())
    ).toBe(true);
    const forecast = result.forecasts.find((f) => f.projectId === "p")!;
    expect(forecast.unplacedUnitIds ?? []).not.toContain("a");
    expect(forecast.reasons.some((reason) => reason.includes("risk buffer can't be reserved"))).toBe(true);
  });

  it("folds a sub-minimum leftover into the run already open for the same action", () => {
    // "late" (100 minutes) sits right against the deadline and is fully consumed first, opening a
    // 100-minute run. "early" (40 minutes) sits earlier still, separated from "late" by an uncovered
    // minute — a real gap, but the design's own condition for folding is only "stays within the
    // maximum session", not wall-clock adjacency, so the 15-minute leftover this project still
    // needs joins the open run instead of being dropped.
    const capacityWindows = [window("late", 41, 141), window("early", 0, 40)];
    const result = planSchedule({
      now,
      horizonEnd: days(2),
      projects: [project("p", days(1))],
      actions: [
        action("a", "p", 100, {
          minimumSessionMinutes: 50,
          maximumSessionMinutes: 200
        })
      ],
      capacityWindows,
      commitments: []
    });
    const aBlocks = result.allocations.filter((b) => b.actionId === "a");
    // 100 padded by the known multiplier reserves the same 115 this case was built around.
    expect(aBlocks.reduce((sum, b) => sum + b.minutes, 0)).toBe(115);
    // The fold actually drew from "early": without it only the 100-minute "late" window could have
    // contributed, so some block must start before the gap.
    expect(aBlocks.some((b) => b.startsAt.getTime() < at(40).getTime())).toBe(true);
    const forecast = result.forecasts.find((f) => f.projectId === "p")!;
    expect(forecast.unplacedUnitIds ?? []).not.toContain("a");
  });

  it("splits a 360-minute (padded) action at a 90-minute maximum into four runs, and another action uses the breaks", () => {
    // One 405-minute window: exactly four 90-minute runs plus three 15-minute breaks between them, and
    // nothing left over — so whatever "b" gets, it can only have come from inside those breaks.
    const capacityWindows = [window("w", 0, 405)];
    const result = planSchedule({
      now,
      horizonEnd: days(2),
      projects: [project("p", days(1))],
      actions: [
        action("a", "p", 313, { minimumSessionMinutes: 15, maximumSessionMinutes: 90 }),
        action("b", "p", 34, { minimumSessionMinutes: 15, maximumSessionMinutes: 90 })
      ],
      capacityWindows,
      commitments: []
    });
    const aBlocks = result.allocations
      .filter((b) => b.actionId === "a")
      .sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime());
    expect(aBlocks.reduce((sum, b) => sum + b.minutes, 0)).toBe(360);
    // Group a's own blocks into contiguous runs (no gap between consecutive blocks) and check each
    // run is at most the maximum, and that consecutive runs are at least a break apart.
    const runs: { start: number; end: number; minutes: number }[] = [];
    for (const block of aBlocks) {
      const openRun = runs.at(-1);
      if (openRun && openRun.end === block.startsAt.getTime()) {
        openRun.end = block.endsAt.getTime();
        openRun.minutes += block.minutes;
      } else runs.push({ start: block.startsAt.getTime(), end: block.endsAt.getTime(), minutes: block.minutes });
    }
    expect(runs).toHaveLength(4);
    for (const run of runs) expect(run.minutes).toBeLessThanOrEqual(90);
    for (let i = 1; i < runs.length; i += 1)
      expect(runs[i]!.start - runs[i - 1]!.end).toBeGreaterThanOrEqual(15 * 60_000);
    // "b" is fully placed even though the only free capacity left in the window is inside a's breaks.
    const bBlocks = result.allocations.filter((b) => b.actionId === "b");
    expect(bBlocks.reduce((sum, b) => sum + b.minutes, 0)).toBe(40);
    expect(
      bBlocks.some((b) => runs.some((run) => b.startsAt.getTime() >= run.start && b.endsAt.getTime() <= run.end))
    ).toBe(false);
  });
});

describe("recurring standing pass", () => {
  it("reserves a maintenance project's week-one occurrence and its later-band demand, before any deadline project", () => {
    // "maint" carries no deadline and only recurring actions, so it is a maintenance project
    // (`isMaintenanceProject`) and the ordinary per-project loop below skips it entirely — the only
    // way its own recurring demand reserves anything at all is the standing pass this test pins.
    const maint = project("maint", days(1), {});
    const { internalDeadlineAt: _omit, ...undatedMaint } = maint;
    // Week-one: an every-3-days occurrence's own exact window, mirroring what `engine.ts`'s `prepare()`
    // synthesizes for a pending occurrence.
    const weekOneOccurrence = action("hydrate-day3", "maint", 20, {
      schedulingMode: "recurring",
      availableFrom: at(2 * 24 * 60),
      deadlineAt: at(3 * 24 * 60)
    });
    // A later band's aggregate demand — what `prepare()` synthesizes for occurrences beyond the
    // pending week, one unit per band rather than one per occurrence.
    const weeklyBandDemand = action("hydrate-weekly-band", "maint", 300, {
      schedulingMode: "recurring",
      availableFrom: days(14),
      deadlineAt: days(30)
    });
    // "far" is an ordinary dated project whose deadline sits inside that same weekly band, sharing
    // the same capacity windows — proving the maintenance project's later-band demand is real,
    // reserved capacity a deadline project must now compete for, not just its week-one occurrence.
    const far = project("far", days(20));
    const capacityWindows = [window("w", 0, 40 * 24 * 60)];
    const result = planSchedule({
      now,
      horizonEnd: days(60),
      projects: [undatedMaint as Project, far],
      actions: [weekOneOccurrence, weeklyBandDemand, action("far-action", "far", 60)],
      capacityWindows,
      commitments: []
    });
    // Week one: real, exact blocks reserved for the maintenance project's own occurrence — the hole
    // the design names ("even its week-one recurring occurrences reserve nothing") is closed.
    expect(result.allocations.some((b) => b.actionId === "hydrate-day3")).toBe(true);
    expect(result.allocations.filter((b) => b.actionId === "hydrate-day3").reduce((sum, b) => sum + b.minutes, 0)).toBe(
      23 // 20 padded by the known multiplier
    );
    // Later bands: "far"'s own forecast shows real capacity reserved ahead of it, even though "far" is
    // the only *dated* project and would otherwise see this capacity as entirely free.
    const farForecast = result.forecasts.find((f) => f.projectId === "far")!;
    expect(farForecast.reservedByEarlierDeadlinesMinutes).toBeGreaterThan(0);
  });
});

/**
 * a dated project's recurring series still only reserved its pending week-one occurrence in
 * the ordinary per-project loop; its later occurrences (the per-band aggregate actions `prepare()`
 * synthesizes beyond the pending week — mirrored here directly, as the standing-pass suite above mirrors
 * them for a maintenance project) reserved nothing at all, so a dated project's band forecast was
 * too optimistic about capacity its own weekly routine will actually use.
 */
describe("dated project's later recurring occurrences reserve in the bands", () => {
  it("reserves a weekly recurring series' later-band demand in its own band, not wherever the project's overall deadline happens to fall", () => {
    // Deadline at day 60 sits in the fortnightly band (30-90 days), so tail-first reservation for
    // this project's ordinary work lands there, as late as possible — the pre-existing behaviour
    // this fix must not disturb. The recurring series' own later-band demand belongs in the weekly
    // band (14-30 days), where `prepare()` actually places its window.
    const dated = project("dated", days(60));
    const other = action("dated-other", "dated", 60);
    const weekOne = action("dated-week1", "dated", 20, {
      schedulingMode: "recurring",
      availableFrom: days(2),
      deadlineAt: days(3)
    });
    const weeklyBandDemand = action("dated-weekly-band", "dated", 300, {
      schedulingMode: "recurring",
      availableFrom: days(14),
      deadlineAt: days(30)
    });
    const capacityWindows = [window("w", 0, 90 * 24 * 60)];
    const result = planSchedule({
      now,
      horizonEnd: days(120),
      projects: [dated],
      actions: [other, weekOne, weeklyBandDemand],
      capacityWindows,
      commitments: []
    });
    const weeklyEnvelope = result.projectEnvelopes.find((e) => e.projectId === "dated" && e.kind === "weekly");
    const fortnightlyEnvelope = result.projectEnvelopes.find(
      (e) => e.projectId === "dated" && e.kind === "fortnightly"
    );
    // The series' own 300 expected minutes (345 padded) land in the weekly band, its own window — not folded into
    // whichever band the project's overall deadline happens to sit in.
    expect(weeklyEnvelope?.reservedMinutes).toBe(345); // 300 padded by the known multiplier (1.15)
    // The fortnightly band (where the deadline sits) carries only the ordinary work reserved as late
    // as possible: the plain action and the week-one occurrence, 60 + 20 minutes.
    expect(fortnightlyEnvelope?.reservedMinutes).toBe(92); // 69 + 23, each padded
    // Counted as the project's own allocation (design decision), never as capacity reserved for an
    // earlier deadline — there is no earlier deadline here at all.
    const forecast = result.forecasts.find((f) => f.projectId === "dated")!;
    expect(forecast.reservedByEarlierDeadlinesMinutes).toBe(0);
    // Three single figures, each padded; the project total is the quadrature sum, a little under the 437 linear sum.
    expect(forecast.protectedRemainingMinutes).toBe(426);
    // Nothing about the later-band series ever appears as a detailed, exact block.
    expect(result.allocations.some((b) => b.actionId === "dated-weekly-band")).toBe(false);
  });

  it("scales a routine-covered series' later-band demand the same way the maintenance pass does", () => {
    // Mirrors `prepare()`'s own scaling: `laterMinutes = expectedMinutes * (1 - coveredShare)`. Here
    // the caller has already applied a 50% covered share to the synthesized action, exactly as
    // `prepare()` would for a series half-covered by completed occurrences this week.
    const dated = project("dated", days(60));
    const halfCoveredWeeklyBand = action("dated-weekly-band-half", "dated", 150, {
      schedulingMode: "recurring",
      availableFrom: days(14),
      deadlineAt: days(30)
    });
    const capacityWindows = [window("w", 0, 90 * 24 * 60)];
    const result = planSchedule({
      now,
      horizonEnd: days(120),
      projects: [dated],
      actions: [halfCoveredWeeklyBand],
      capacityWindows,
      commitments: []
    });
    const weeklyEnvelope = result.projectEnvelopes.find((e) => e.projectId === "dated" && e.kind === "weekly");
    expect(weeklyEnvelope?.reservedMinutes).toBe(173); // 150 padded: 172.5
  });

  it("never draws from, or displaces, a detailed-band slot when band capacity runs short", () => {
    // A tiny, single-day capacity window entirely inside the weekly band: nowhere near enough to
    // cover the series' 300-minute later-band demand. Before the fix, a shortfall like this fell
    // through to the detailed-band `allocateAction` fallback (`reserveTailFirst`'s ordinary path);
    // the fix's `bandsOnly` flag must leave that shortfall unreserved instead.
    const dated = project("dated", days(60));
    const weeklyBandDemand = action("dated-weekly-band", "dated", 300, {
      schedulingMode: "recurring",
      availableFrom: days(14),
      deadlineAt: days(30)
    });
    const capacityWindows = [window("w", 14 * 24 * 60, 14 * 24 * 60 + 60)]; // one hour, inside the weekly band
    const result = planSchedule({
      now,
      horizonEnd: days(120),
      projects: [dated],
      actions: [weeklyBandDemand],
      capacityWindows,
      commitments: []
    });
    expect(result.allocations).toEqual([]);
    const weeklyEnvelope = result.projectEnvelopes.find((e) => e.projectId === "dated" && e.kind === "weekly");
    expect(weeklyEnvelope?.reservedMinutes).toBeLessThan(300);
  });

  it("leaves detailed-band allocations byte-identical whether or not the later recurring band demand is present", () => {
    // "soon" has a deadline inside the detailed band, forcing real, exact placement there. "dated"'s
    // deadline (day 20) sits earlier than "soon"'s (day 25), so the project loop reserves "dated"
    // first — exactly the ordering under which a bug in the new bands-only path could leak into
    // "soon"'s later detailed-band reservation.
    const soon = project("soon", days(25));
    const soonAction = action("soon-action", "soon", 300);
    const dated = project("dated", days(20));
    const datedOther = action("dated-other", "dated", 60);
    const weeklyBandDemand = action("dated-weekly-band", "dated", 300, {
      schedulingMode: "recurring",
      availableFrom: days(14),
      deadlineAt: days(20)
    });
    const capacityWindows = [window("w", 0, 40 * 24 * 60)];
    const without = planSchedule({
      now,
      horizonEnd: days(60),
      projects: [soon, dated],
      actions: [soonAction, datedOther],
      capacityWindows,
      commitments: []
    });
    const withLaterBand = planSchedule({
      now,
      horizonEnd: days(60),
      projects: [soon, dated],
      actions: [soonAction, datedOther, weeklyBandDemand],
      capacityWindows,
      commitments: []
    });
    const detailedOnly = (blocks: typeof without.allocations) =>
      blocks.filter((block) => block.actionId === "soon-action");
    expect(detailedOnly(withLaterBand.allocations)).toEqual(detailedOnly(without.allocations));
    expect(withLaterBand.allocations.some((b) => b.actionId === "dated-weekly-band")).toBe(false);
  });

  it("a dated project with a tiny daily series and ample capacity stays On track", () => {
    // Reviewer finding: two real routine projects flipped to At risk even though their
    // own aggregate margin was enormous (ratio 6.8 and 7.4) — the true cause was their own daily
    // band's real ledger being fully claimed by other, earlier-processed projects before their own
    // turn, with nowhere for the shortfall to go. This is the base case that must stay untouched:
    // plenty of capacity everywhere, so a tiny daily-band demand reserves fully inside its own band
    // and the project reads On track, not At risk.
    const dated = project("dated", days(60));
    const tinyDailyBand = action("dated-daily-band", "dated", 5, {
      schedulingMode: "recurring",
      availableFrom: days(7),
      deadlineAt: days(14)
    });
    const capacityWindows = [window("w", 0, 90 * 24 * 60)];
    const result = planSchedule({
      now,
      horizonEnd: days(120),
      projects: [dated],
      actions: [tinyDailyBand],
      capacityWindows,
      commitments: []
    });
    const forecast = result.forecasts.find((f) => f.projectId === "dated")!;
    expect(forecast.health).toBe("on_track");
    expect(forecast.unplacedUnitIds ?? []).toEqual([]);
    const dailyEnvelope = result.projectEnvelopes.find((e) => e.projectId === "dated" && e.kind === "daily");
    expect(dailyEnvelope?.reservedMinutes).toBe(6); // 5 padded: 5.75
  });

  it("spills a later occurrence's shortfall into a later band — never an earlier one or detailed — when its own band is oversubscribed by an earlier-processed project", () => {
    // "hog" has the nearer deadline (day 10, inside the daily band itself) and is given a tiny,
    // exhaustible slice of real capacity that sits entirely inside the daily band; being processed
    // first (project order is by deadline), it claims all of it, leaving "routine"'s own daily-band
    // ledger at zero by the time its turn comes — reproducing the reviewer's finding structurally.
    // "routine" is a dated project (day 60, in the fortnightly band) with a daily-band later
    // occurrence; ample separate capacity exists from day 14 on (weekly/fortnightly), which the
    // fix must fall back into, never a detailed-band slot (there is none available to "hog" or
    // "routine" here at all) and never an earlier band than its own.
    const hog = project("hog", days(10));
    const hogAction = action("hog-action", "hog", 300); // more than the daily window can hold
    const routine = project("routine", days(60));
    const dailyBandDemand = action("routine-daily-band", "routine", 30, {
      schedulingMode: "recurring",
      availableFrom: days(7),
      deadlineAt: days(14)
    });
    const capacityWindows = [
      window("dailyWindow", 7 * 24 * 60, 7 * 24 * 60 + 240), // 4 hours, entirely inside the daily band
      window("laterWindow", 14 * 24 * 60, 90 * 24 * 60) // ample capacity from the weekly band onward
    ];
    const result = planSchedule({
      now,
      horizonEnd: days(120),
      projects: [hog, routine],
      actions: [hogAction, dailyBandDemand],
      capacityWindows,
      commitments: []
    });
    const dailyBand = result.capacityEnvelopes.find((e) => e.kind === "daily")!;
    // "hog" fully claimed the daily band's own real ledger before "routine"'s turn.
    expect(dailyBand.freeMinutes).toBe(0);
    const routineDaily = result.projectEnvelopes.find((e) => e.projectId === "routine" && e.kind === "daily");
    expect(routineDaily?.reservedMinutes ?? 0).toBe(0);
    // The full 30 minutes still land somewhere in a later band (weekly or fortnightly) instead of
    // being reported as unplaced — "routine"'s own wider margin, not its exhausted daily slice,
    // decides its health.
    const routineForecast = result.forecasts.find((f) => f.projectId === "routine")!;
    expect(routineForecast.unplacedUnitIds ?? []).toEqual([]);
    expect(routineForecast.protectedRemainingMinutes).toBe(35); // 30 padded: 34.5
    const laterBands = result.projectEnvelopes.filter(
      (e) => e.projectId === "routine" && (e.kind === "weekly" || e.kind === "fortnightly")
    );
    expect(laterBands.reduce((sum, e) => sum + e.reservedMinutes, 0)).toBe(35);
    // Still never a detailed-band slot: none exists in this capacity layout for it to draw from.
    expect(result.allocations.some((b) => b.actionId === "routine-daily-band")).toBe(false);
  });
});
