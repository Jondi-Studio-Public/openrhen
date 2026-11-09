import baselineJson from "../../../test/replay/baseline.json" with { type: "json" };
import goldenJson from "../../../test/replay/golden.json" with { type: "json" };
import lexiconJson from "../../../test/replay/lexicon.json" with { type: "json" };
import { parseReplayCase, type ReplayCase } from "./replay-case.js";
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
  metrics: {
    /** Overall, per tag and per plan size: the figures the ratchet watches. */
    deterministic: MetricGroups;
    /** Overall only: how the three chooser stubs move the same cases. */
    judge: Record<"oracle" | "adversarial" | "noisy", Metrics>;
  };
}

export const baseline = baselineJson as unknown as Baseline;
