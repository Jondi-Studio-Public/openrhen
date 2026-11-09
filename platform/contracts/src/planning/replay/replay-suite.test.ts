import { describe, expect, it } from "vitest";
import { referenceReconciler } from "./replay-reference.js";
import { PATHS, runCases, type ReplayPath } from "./replay-run.js";
import { newApplies, ratchetFailures, scoreGroups, violations } from "./replay-score.js";
import { baseline, goldenCases } from "./replay-suite.js";

const runs = Object.fromEntries(
  PATHS.map((path) => [path, runCases(goldenCases, referenceReconciler, path)])
) as Record<ReplayPath, ReturnType<typeof runCases>>;

const refresh =
  "If this change is deliberate, update platform/contracts/test/replay/baseline.json in the same commit and give the reason in the commit message.";

describe("replay suite against the baseline", () => {
  it("does not let a ratcheted rate fall below the baseline", () => {
    const current = scoreGroups(runs.deterministic);
    const failures = [
      ...ratchetFailures(current.overall, baseline.metrics.deterministic.overall, baseline.tolerance),
      ...Object.entries(baseline.metrics.deterministic.byTag).flatMap(([tag, was]) =>
        ratchetFailures(current.byTag[tag]!, was, baseline.tolerance).map((f) => `${tag}: ${f}`)
      )
    ];
    expect(failures, refresh).toEqual([]);
  });

  it("records every metric exactly, so a change of behaviour shows in the baseline diff", () => {
    expect(scoreGroups(runs.deterministic), refresh).toEqual(baseline.metrics.deterministic);
    for (const path of ["oracle", "adversarial", "noisy"] as const) {
      expect(scoreGroups(runs[path]).overall, `${path}. ${refresh}`).toEqual(baseline.metrics.judge[path]);
    }
  });

  it("never commits a hard-invariant violation that the baseline does not list, on any path", () => {
    for (const path of PATHS) {
      const found = violations(runs[path]);
      expect(
        found.tieGuess.filter((id) => !baseline.knownViolations.tieGuess.includes(id)),
        `${path} tieGuess`
      ).toEqual([]);
      expect(
        found.mustNot.filter((id) => !baseline.knownViolations.mustNot.includes(id)),
        `${path} mustNot`
      ).toEqual([]);
    }
  });

  it("keeps the known-violation list honest: each entry still happens, so a fix shrinks the list", () => {
    const found = violations(runs.deterministic);
    expect(found, refresh).toEqual(baseline.knownViolations);
  });

  it("holds an adversarial chooser to no new applies", () => {
    expect(newApplies(runs.deterministic, runs.adversarial)).toEqual([]);
    expect(baseline.adversarialNewApplies).toEqual([]);
  });

  it("calls a chooser only to settle a held question, never on the deterministic path", () => {
    expect(runs.deterministic.some((r) => r.outcome.usedChooser)).toBe(false);
    for (const path of ["oracle", "adversarial", "noisy"] as const) {
      expect(runs[path].some((r) => r.outcome.usedChooser)).toBe(true);
    }
  });

  it("is first-wins on a tie today (PR 3 changes this)", () => {
    const twins = runs.deterministic.find((r) => r.testCase.id === "event-twin-records")!;
    expect(twins.outcome).toMatchObject({ endState: "duplicate", tie: true });
  });

  it("runs quickly, in memory", () => {
    const start = performance.now();
    for (const path of PATHS) runCases(goldenCases, referenceReconciler, path);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
