import { describe, expect, it } from "vitest";
import type { Candidate, ReplayCase, ReplayGold, ReplayOutcome } from "./replay-case.js";
import type { RunResult } from "./replay-run.js";
import {
  isCorrect,
  newApplies,
  ratchetFailures,
  rateOf,
  scoreGroups,
  scoreResults,
  targetOk,
  violations,
  wilson
} from "./replay-score.js";

const cand = (id: string): Candidate => ({ id, rank: 2, score: 1, lane: "commitment" });
const t = (id: string) => ({ kind: "commitment" as const, id });

function result(id: string, gold: ReplayGold, outcome: Partial<ReplayOutcome>, tags: string[] = ["golden"]): RunResult {
  return {
    testCase: { id, tags, gold, input: {} } as unknown as ReplayCase,
    outcome: { endState: "no_effect", candidates: [], tie: false, usedChooser: false, ...outcome }
  };
}

describe("replay scoring", () => {
  it("computes Wilson intervals that widen with a small denominator", () => {
    expect(wilson({ k: 0, n: 0 })).toEqual({ lo: 0, hi: 1 });
    const small = wilson({ k: 5, n: 10 });
    const large = wilson({ k: 500, n: 1000 });
    expect(small.hi - small.lo).toBeGreaterThan(large.hi - large.lo);
    expect(small.lo).toBeLessThan(0.5);
    expect(small.hi).toBeGreaterThan(0.5);
    expect(wilson({ k: 10, n: 10 }).hi).toBe(1);
    expect(rateOf({ k: 1, n: 4 })).toBe(0.25);
    expect(rateOf({ k: 0, n: 0 })).toBe(0);
  });

  it("checks targets against gold and acceptable targets, and none against none", () => {
    expect(targetOk({ endState: "applied" }, undefined)).toBe(true);
    expect(targetOk({ endState: "applied" }, t("a"))).toBe(false);
    expect(targetOk({ endState: "duplicate", target: t("a"), acceptableTargets: [t("b")] }, t("b"))).toBe(true);
    expect(targetOk({ endState: "duplicate", target: t("a") }, undefined)).toBe(false);
    expect(
      isCorrect(
        { endState: "applied", op: "cancel", target: t("a") },
        { endState: "applied", op: "create", target: t("a"), candidates: [], tie: false, usedChooser: false }
      )
    ).toBe(false);
    expect(
      isCorrect(
        { endState: "no_effect", reason: "past" },
        { endState: "no_effect", reason: "no_facts", candidates: [], tie: false, usedChooser: false }
      )
    ).toBe(false);
  });

  it("scores a small hand-built run", () => {
    const results = [
      result(
        "a",
        { endState: "duplicate", target: t("x") },
        { endState: "duplicate", target: t("x"), candidates: [cand("x")] }
      ),
      result(
        "b",
        { endState: "duplicate", target: t("x") },
        { endState: "applied", op: "create", candidates: [cand("x")] }
      ),
      result("c", { endState: "applied", op: "create" }, { endState: "applied", op: "create" }),
      result(
        "d",
        { endState: "no_effect", reason: "past", deny: true },
        { endState: "applied", op: "cancel", target: t("y"), candidates: [cand("y")] }
      ),
      result(
        "e",
        { endState: "asked" },
        { endState: "duplicate", target: t("x"), candidates: [cand("x"), cand("z")], tie: true }
      ),
      result("f", { endState: "asked" }, { endState: "asked", candidates: [cand("x"), cand("z")], tie: true }),
      result(
        "g",
        { endState: "duplicate", target: t("x") },
        { endState: "duplicate", target: t("x"), usedChooser: true, candidates: [cand("x")] }
      )
    ];
    const m = scoreResults(results);
    expect(m.cases).toBe(7);
    expect(m.confusion.duplicate.applied).toBe(1);
    expect(m.confusion.asked.duplicate).toBe(1);
    expect(m.appliedPrecision).toEqual({ k: 1, n: 3 });
    expect(m.falseMergeRate).toEqual({ k: 1, n: 1 });
    expect(m.wrongCreateRate).toEqual({ k: 1, n: 2 });
    expect(m.wrongDuplicateRate).toEqual({ k: 1, n: 3 });
    expect(m.denyRate).toEqual({ k: 1, n: 3 });
    expect(m.confirmAccuracy).toEqual({ k: 2, n: 3 });
    expect(m.tieRate).toEqual({ k: 2, n: 6 });
    expect(m.tieResolution).toEqual({
      chooserCorrect: { k: 0, n: 2 },
      asked: { k: 1, n: 2 },
      wronglyApplied: { k: 1, n: 2 }
    });
    expect(m.recallAt5).toEqual({ k: 3, n: 3 });
    expect(m.noJudgeShare).toEqual({ k: 5, n: 7 });
    expect(m.questionsPer100).toBeCloseTo(14.29, 2);
    expect(m.precision.duplicate).toEqual({ k: 2, n: 3 });
    expect(m.recall.duplicate).toEqual({ k: 2, n: 3 });
    expect(m.unresolvedShare).toEqual({ k: 0, n: 7 });
  });

  it("scores an empty run without dividing by zero", () => {
    const m = scoreResults([]);
    expect(m.cases).toBe(0);
    expect(m.questionsPer100).toBe(0);
    expect(rateOf(m.appliedPrecision)).toBe(0);
  });

  it("groups by tag and by plan size", () => {
    const groups = scoreGroups([
      result("a", { endState: "no_effect" }, {}, ["golden", "cancel", "5x"]),
      result("b", { endState: "no_effect" }, {}, ["golden"])
    ]);
    expect(groups.overall.cases).toBe(2);
    expect(groups.byTag.cancel?.cases).toBe(1);
    expect(groups.byTag.golden?.cases).toBe(2);
    expect(groups.byTag["5x"]).toBeUndefined();
    expect(groups.bySize["5x"]?.cases).toBe(1);
    expect(groups.bySize.unsized?.cases).toBe(1);
  });

  it("finds hard-invariant violations", () => {
    const found = violations([
      result("tie", { endState: "asked" }, { endState: "duplicate", target: t("x"), tie: true }),
      result(
        "tie-judged",
        { endState: "duplicate", target: t("x") },
        { endState: "duplicate", target: t("x"), tie: true, usedChooser: true }
      ),
      result(
        "tie-broken",
        { endState: "duplicate", target: t("x") },
        { endState: "duplicate", target: t("x"), tie: true, tieBrokenBy: "contact" }
      ),
      result("tie-asked", { endState: "asked" }, { endState: "asked", tie: true }),
      result(
        "no-apply",
        { endState: "no_effect", mustNot: ["apply"] },
        { endState: "applied", op: "cancel", target: t("x") }
      ),
      result(
        "no-create",
        { endState: "applied", op: "update", target: t("x"), mustNot: ["create"] },
        { endState: "applied", op: "create" }
      ),
      result(
        "ok",
        { endState: "applied", op: "update", target: t("x"), mustNot: ["create"] },
        { endState: "applied", op: "update", target: t("x") }
      )
    ]);
    expect(found).toEqual({ tieGuess: ["tie"], mustNot: ["no-apply", "no-create"] });
  });

  it("finds applies a chooser added", () => {
    const det = [
      result("a", { endState: "asked" }, { endState: "asked" }),
      result("b", { endState: "asked" }, { endState: "applied", op: "create" })
    ];
    const judged = [
      result("a", { endState: "asked" }, { endState: "applied", op: "create" }),
      result("b", { endState: "asked" }, { endState: "applied", op: "create" })
    ];
    expect(newApplies(det, judged)).toEqual(["a"]);
  });

  it("fails the ratchet only when a watched rate falls", () => {
    const base = scoreResults([
      result("a", { endState: "applied", op: "create" }, { endState: "applied", op: "create" })
    ]);
    const worse = scoreResults([
      result("a", { endState: "applied", op: "create" }, { endState: "applied", op: "update", target: t("x") })
    ]);
    expect(ratchetFailures(base, base, 0)).toEqual([]);
    expect(ratchetFailures(worse, base, 0)[0]).toMatch(/^appliedPrecision fell/);
    expect(ratchetFailures(base, worse, 0)).toEqual([]);
    expect(ratchetFailures(worse, base, 1)).toEqual([]);
  });
});
