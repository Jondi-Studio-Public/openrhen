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

/** Every case through the reconciler on one path. In memory: no database, no network. */
export function runCases(cases: readonly ReplayCase[], reconciler: Reconciler, path: ReplayPath): RunResult[] {
  return cases.map((testCase) => ({
    testCase,
    outcome: reconciler(structuredClone(testCase.input), { chooser: chooserFor(path, testCase) })
  }));
}
