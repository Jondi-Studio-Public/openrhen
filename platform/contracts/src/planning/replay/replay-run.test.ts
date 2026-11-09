import { describe, expect, it } from "vitest";
import { chooserFor, PATHS, runCases } from "./replay-run.js";
import { referenceReconciler } from "./replay-reference.js";
import { goldenCases } from "./replay-suite.js";

describe("replay runner", () => {
  it("builds a chooser for every path, and the deterministic one is unavailable", () => {
    for (const path of PATHS) expect(typeof chooserFor(path, goldenCases[0]!)).toBe("function");
    expect(chooserFor("deterministic", goldenCases[0]!).unavailable).toBe(true);
    expect(chooserFor("oracle", goldenCases[0]!).unavailable).toBeUndefined();
  });

  it("runs every case on every path without calling the deterministic chooser", () => {
    for (const path of PATHS) {
      const results = runCases(goldenCases, referenceReconciler, path);
      expect(results).toHaveLength(goldenCases.length);
      expect(results.every((r) => r.outcome.candidates.length <= 5)).toBe(true);
    }
  });

  it("does not let a reconciler change a case", () => {
    const before = JSON.stringify(goldenCases);
    runCases(
      goldenCases,
      (input) => {
        input.plan.commitments.length = 0;
        return referenceReconciler(input, { chooser: chooserFor("deterministic", goldenCases[0]!) });
      },
      "deterministic"
    );
    expect(JSON.stringify(goldenCases)).toBe(before);
  });
});
