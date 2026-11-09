import type { Chooser, ReplayCase, ReplayOutcome, Reconciler } from "./replay-case.js";
import { adversarial, never, noisy, oracle } from "./replay-stubs.js";

export const PATHS = ["deterministic", "oracle", "adversarial", "noisy"] as const;
export type ReplayPath = (typeof PATHS)[number];

export const NOISY_P = 0.7;
export const NOISY_SEED = "replay-v1";

export function chooserFor(path: ReplayPath, testCase: ReplayCase): Chooser {
  switch (path) {
    case "deterministic":
      return never;
    case "oracle":
      return oracle(testCase.gold);
    case "adversarial":
      return adversarial;
    case "noisy":
      return noisy(NOISY_P, NOISY_SEED, testCase.id, testCase.gold);
  }
}

export interface RunResult {
  testCase: ReplayCase;
  outcome: ReplayOutcome;
}

/**
 * A frozen plan (the generator's, shared by thousands of cases) cannot be changed by a reconciler, so
 * only the message is copied; any other input is copied whole.
 */
function inputOf(testCase: ReplayCase): ReplayCase["input"] {
  const { input } = testCase;
  return Object.isFrozen(input.plan) ? { ...input, message: structuredClone(input.message) } : structuredClone(input);
}

/** Every case through the reconciler on one path. In memory: no database, no network. */
export function runCases(cases: readonly ReplayCase[], reconciler: Reconciler, path: ReplayPath): RunResult[] {
  return cases.map((testCase) => ({
    testCase,
    outcome: reconciler(inputOf(testCase), { chooser: chooserFor(path, testCase) })
  }));
}

/**
 * Every path over a large case set. A case the deterministic path settled without a question never
 * needed a judge, so a chooser path reuses that result and reruns only the cases that ended `asked`.
 * (The golden suite runs every path in full, and a test holds the two ways equal on it.)
 */
export function runPaths(cases: readonly ReplayCase[], reconciler: Reconciler): Record<ReplayPath, RunResult[]> {
  const deterministic = runCases(cases, reconciler, "deterministic");
  const needsJudge = deterministic.map((r) => r.outcome.endState === "asked");
  const rerun = (path: ReplayPath): RunResult[] => {
    const asked = runCases(
      cases.filter((_, i) => needsJudge[i]),
      reconciler,
      path
    );
    let next = 0;
    return deterministic.map((r, i) => (needsJudge[i] ? asked[next++]! : r));
  };
  return {
    deterministic,
    oracle: rerun("oracle"),
    adversarial: rerun("adversarial"),
    noisy: rerun("noisy")
  };
}
