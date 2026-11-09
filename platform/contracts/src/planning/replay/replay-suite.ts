import baselineJson from "../../../test/replay/baseline.json" with { type: "json" };
import generatedBaselineJson from "../../../test/replay/baseline-generated.json" with { type: "json" };
import goldenJson from "../../../test/replay/golden.json" with { type: "json" };
import lexiconJson from "../../../test/replay/lexicon.json" with { type: "json" };
import { parseReplayCase, type ReplayCase } from "./replay-case.js";
import { DEFAULT_SEED, generateCases, SIZE_NAMES, type PlanSize } from "./replay-generate.js";
import type { Metrics, MetricGroups } from "./replay-score.js";

/** The committed fixtures, parsed. Imported explicitly: contracts keeps no filesystem dependency. */
export const goldenCases: ReplayCase[] = (goldenJson as unknown[]).map(parseReplayCase);

export const lexicon: { words: string[] } = lexiconJson;

export interface Baseline {
  /** Accepted slack on the ratcheted rates. The golden suite is exact data, so 0. */
  tolerance: number;
  /**
   * Hard-invariant violations the current reference resolver is known to commit, by case id. The list
   * may only shrink: a violation not listed fails, and the tie-result change empties `tieGuess`.
   */
  knownViolations: { tieGuess: string[]; mustNot: string[] };
  /** Cases an adversarial chooser makes apply that the deterministic path does not. Always empty. */
  adversarialNewApplies: string[];
  /** Cases an adversarial chooser pins to the wrong record that the deterministic path does not. May only shrink. */
  adversarialNewWrongDuplicates: string[];
  metrics: {
    /** Overall, per tag and per plan size: the figures the ratchet watches. */
    deterministic: MetricGroups;
    /** Overall only: how the three chooser stubs move the same cases. */
    judge: Record<"oracle" | "adversarial" | "noisy", Metrics>;
  };
}

export const baseline = baselineJson as unknown as Baseline;

/** Cases per plan size in the CI run: measured to keep the whole suite near three seconds. */
export const GENERATED_COUNTS: Record<PlanSize, number> = { "1x": 1000, "5x": 150, "20x": 100 };

/** The `REPLAY_LARGE` sweep: about 20,000 cases, for a local run only. */
export const LARGE_COUNTS: Record<PlanSize, number> = { "1x": 12000, "5x": 6000, "20x": 600 };

/** Generated cases for each plan size, 1x first. Deterministic in the seed. */
export function generatedSuite(counts: Record<PlanSize, number> = GENERATED_COUNTS, seed = DEFAULT_SEED): ReplayCase[] {
  return SIZE_NAMES.flatMap((size) => generateCases({ seed, size, count: counts[size] }));
}

export interface GeneratedBaseline extends Baseline {
  seed: string;
  counts: Record<PlanSize, number>;
}

export const generatedBaseline = generatedBaselineJson as unknown as GeneratedBaseline;
