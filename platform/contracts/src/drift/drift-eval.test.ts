import { describe, expect, it } from "vitest";
import type { DriftEpisode } from "./drift-episodes.js";
import {
  DRIFT_EVAL,
  baselineFlags,
  bootstrapByDay,
  buildDriftEvalReport,
  chronologicalSplit,
  isHit,
  seededRandom,
  type EvalFlag
} from "./drift-eval.js";

const DAY = 24 * 60;
const at = (minutes: number): Date => new Date(Date.UTC(2026, 0, 5, 0, 0, 0) + minutes * 60_000);
const episode = (id: string, minutes: number, overrides: Partial<DriftEpisode> = {}): DriftEpisode => ({
  id,
  type: "unsanctioned_session",
  occurredAt: at(minutes),
  knownAt: at(minutes),
  pinned: true,
  evidence: [],
  ...overrides
});
const flag = (minutes: number, rule: EvalFlag["rule"] = "after_shift"): EvalFlag => ({
  rule,
  at: at(minutes),
  momentId: `m${minutes}`
});
const days = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    day: at(i * DAY)
      .toISOString()
      .slice(0, 10)
  }));

describe("hit window", () => {
  it("is [2, 5] minutes after the flag, inclusive", () => {
    const e = episode("e", 100);
    expect(isHit({ at: at(99) }, e)).toBe(false);
    expect(isHit({ at: at(98) }, e)).toBe(true);
    expect(isHit({ at: at(95) }, e)).toBe(true);
    expect(isHit({ at: at(94) }, e)).toBe(false);
    expect(isHit({ at: at(101) }, e)).toBe(false);
  });
});

describe("report", () => {
  it("counts hits, false alarms per waking day and recall; ignores unpinned and unscorable episodes", () => {
    const report = buildDriftEvalReport({
      flags: [flag(97), flag(500), flag(DAY + 10)],
      episodes: [
        episode("a", 100),
        episode("b", 300, { pinned: false }),
        episode("c", 700, { type: "deviated_checkin" })
      ],
      days: days(2)
    });
    const rule = report.rules[0];
    expect(rule?.flags).toBe(3);
    expect(rule?.hits).toBe(1);
    expect(rule?.falseAlarms).toBe(2);
    expect(rule?.falseAlarmsPerDay).toBe(1);
    expect(rule?.scoredDrifts).toBe(2);
    expect(rule?.caught).toBe(1);
    expect(rule?.recall).toBe(0.5);
    expect(rule?.notTestable).toBe(true);
    expect(rule?.recallInterval).toBeNull();
  });

  it("scores rule A on session drifts but not on activity mismatch episodes", () => {
    const report = buildDriftEvalReport({
      flags: [flag(97, "work_item_diversion")],
      episodes: [episode("a", 100)],
      days: days(1)
    });
    expect(report.rules.find((r) => r.rule === "work_item_diversion")?.scoredTypes.sort()).toEqual([
      "deviated_checkin",
      "unsanctioned_session"
    ]);
  });

  it("reports coverage lost to the post-switch window and capture-off days", () => {
    const report = buildDriftEvalReport({
      flags: [flag(97)],
      episodes: [episode("a", 100), episode("b", 300)],
      days: [...days(1), { day: "2026-01-06", captureOff: true }],
      switches: [at(298)]
    });
    expect(report.coverage).toEqual({ pinnedScorable: 2, lostToSwitchWindow: 1 });
    expect(report.rules[0]?.scoredDrifts).toBe(1);
    expect(report.captureOffDays).toBe(1);
    expect(report.wakingDays).toBe(1);
  });

  it("records the holdout without subsetting the score", () => {
    const flags = [
      { ...flag(97), holdout: true },
      { ...flag(500), holdout: false }
    ];
    const report = buildDriftEvalReport({ flags, episodes: [episode("a", 100)], days: days(1) });
    expect(report.holdout).toEqual({ assigned: 1, of: 2 });
    expect(report.rules[0]?.flags).toBe(2);
    expect(report.rules[0]?.recall).toBe(1);
  });

  it("applies the not-testable floor to the scored subset", () => {
    const many = Array.from({ length: 30 }, (_, i) => episode(`e${i}`, i * 60 + 100));
    const flags = many.map((_, i) => flag(i * 60 + 97));
    const report = buildDriftEvalReport({ flags, episodes: many, days: days(2) });
    expect(report.rules[0]?.scoredDrifts).toBe(30);
    expect(report.rules[0]?.notTestable).toBe(false);
    expect(report.rules[0]?.recall).toBe(1);
    expect(report.rules[0]?.recallInterval).toEqual({ low: 1, high: 1 });
  });

  it("compares with a baseline at the same alarm budget", () => {
    const eligible = Array.from({ length: 200 }, (_, i) => at(i * 5));
    const report = buildDriftEvalReport({
      flags: [flag(97), flag(197)],
      episodes: [episode("a", 100), episode("b", 200)],
      days: days(1),
      eligibleMoments: eligible
    });
    const rule = report.rules[0];
    expect(rule?.baseline?.flags).toBe(2);
    expect(rule?.lift).toBeCloseTo(1 - (rule?.baseline?.recall ?? 0));
  });

  it("splits chronologically with an embargo when asked", () => {
    const flags = Array.from({ length: 100 }, (_, i) => flag(i * 2));
    const report = buildDriftEvalReport({ flags, episodes: [], days: days(1), split: { trainFraction: 0.6 } });
    expect(report.split && report.split.trainFlags + report.split.embargoedFlags + report.split.testFlags).toBe(100);
    expect(report.split?.embargoedFlags).toBeGreaterThan(0);
    expect(report.rules[0]?.flags).toBe(report.split?.testFlags);
  });
});

describe("split", () => {
  it("never shuffles and leaves one horizon between train and test", () => {
    const items = Array.from({ length: 50 }, (_, i) => at(i));
    const { train, embargoed, test } = chronologicalSplit(items, (d) => d, 0.5);
    const last = train[train.length - 1] as Date;
    const first = test[0] as Date;
    expect(first.getTime() - last.getTime()).toBeGreaterThanOrEqual(DRIFT_EVAL.horizonMinutes * 60_000);
    expect(train.length + embargoed.length + test.length).toBe(50);
    expect(chronologicalSplit([], (d: Date) => d)).toEqual({ train: [], embargoed: [], test: [] });
  });
});

describe("bootstrap", () => {
  const day = (scored: number, caught: number, falseAlarms = 0) => ({ flags: 0, falseAlarms, scored, caught });
  it("is deterministic for a seed", () => {
    const sample = [day(2, 1), day(3, 0, 2), day(0, 0), day(4, 3, 1)];
    expect(bootstrapByDay(sample, 300, 7)).toEqual(bootstrapByDay(sample, 300, 7));
    expect(seededRandom(1)()).toBe(seededRandom(1)());
  });
  it("gives 1 for all hits and 0 for all misses, and handles no days or empty days", () => {
    expect(bootstrapByDay([day(2, 2), day(3, 3)], 200).recall).toEqual({ low: 1, high: 1 });
    expect(bootstrapByDay([day(2, 0), day(3, 0)], 200).recall).toEqual({ low: 0, high: 0 });
    expect(bootstrapByDay([], 200)).toEqual({ recall: null, falseAlarms: null });
    expect(bootstrapByDay([day(0, 0), day(0, 0)], 200).recall).toBeNull();
  });
});

describe("baseline", () => {
  it("draws the same number of distinct moments, repeatably", () => {
    const pool = Array.from({ length: 20 }, (_, i) => at(i));
    const a = baselineFlags(pool, 5, 3);
    expect(a).toHaveLength(5);
    expect(new Set(a.map((d) => d.getTime())).size).toBe(5);
    expect(baselineFlags(pool, 5, 3)).toEqual(a);
    expect(baselineFlags(pool, 50, 3)).toHaveLength(20);
  });
});

describe("split scoring window", () => {
  it("counts only test-period days and draws the baseline only from the test period", () => {
    const flags = Array.from({ length: 10 }, (_, i) => flag(i * DAY + 10));
    const eligibleMoments = Array.from({ length: 10 }, (_, i) => at(i * DAY + 20));
    const report = buildDriftEvalReport({
      flags,
      episodes: [],
      days: days(10),
      eligibleMoments,
      split: { trainFraction: 0.6 }
    });
    expect(report.split?.testFlags).toBe(4);
    expect(report.wakingDays).toBe(4);
    expect(report.rules[0]?.falseAlarmsPerDay).toBe(1);
    expect(report.rules[0]?.baseline?.falseAlarmsPerDay).toBe(1);
  });
});

describe("rules that never fire", () => {
  it("still appear in the report with recall 0 and not testable", () => {
    const report = buildDriftEvalReport({
      flags: [flag(97, "after_shift")],
      episodes: [episode("a", 100)],
      days: days(1)
    });
    expect(report.rules.map((r) => r.rule).sort()).toEqual(["after_shift", "work_item_diversion"]);
    const silent = report.rules.find((r) => r.rule === "work_item_diversion");
    expect(silent?.flags).toBe(0);
    expect(silent?.recall).toBe(0);
    expect(silent?.notTestable).toBe(true);
  });
});
