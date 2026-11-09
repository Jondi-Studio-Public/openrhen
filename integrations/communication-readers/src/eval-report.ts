import { type FactEvalInput, type FactMetrics, factMetrics, fallbackFactPredictions } from "./eval-facts.js";
import {
  type AutoWrite,
  type EvalLabel,
  type EvalPrediction,
  type FieldMetrics,
  type PersonCorrection,
  type T0Share,
  type WrongAutoAction,
  fieldMetrics,
  t0Share,
  wrongAutoActions
} from "./eval-stats.js";

/** Said with every report: a few hundred labels cannot calibrate confidence, so this is for catching gross failure. */
export const EVAL_CAVEAT =
  "A few hundred labels show gross failure only: the intervals are wide and the scores cannot calibrate a confidence. Precision is over the labelled messages the extractor wrote a value for; recall is over the random slice alone. Fact types are scored one at a time by membership with a Wilson interval each, unadjusted for comparing four of them; a message the extractor had not reached is neither a hit nor a correct negative, and labelled-empty messages give a false-alarm rate, never recall. Until enough labels exist, the action level is set by tier and structured source, not by these scores.";

export interface EvalReportInput {
  labels: readonly EvalLabel[];
  predictions: readonly EvalPrediction[];
  writes: readonly AutoWrite[];
  corrections: readonly PersonCorrection[];
  /**
   * What the version wrote about facts: its fact rows, the labelled messages inside its processed range, and the labelled
   * facts as some version wrote them (for the fallback join). Absent means no fact rows and no message reached.
   */
  facts?: { rows: FactEvalInput["rows"]; reached: FactEvalInput["reached"]; references?: FactEvalInput["references"] };
  /** All messages of the extractor's input source, and how many have a tier-t0 class; null when the input is not known. */
  t0: { messages: number; resolvedByT0: number } | null;
}

export interface EvalReport {
  labels: { total: number; unfielded: number };
  fields: FieldMetrics[];
  /** Message labels of `fact_types` scored per type, and facts matched under new ids. `fields` leaves `fact_types` out. */
  facts: FactMetrics & { fallback: { matched: number; unmatched: number } };
  wrongAutoActions: { count: number; items: WrongAutoAction[]; truncated: boolean };
  t0: T0Share | null;
  caveat: string;
}

/** The whole report for one extractor version, from plain data. */
export function buildEvalReport(input: EvalReportInput): EvalReport {
  const rows = input.facts?.rows ?? [];
  const fallback = fallbackFactPredictions(rows, input.facts?.references ?? []);
  const exact = new Set(input.predictions.map((p) => `${p.subject.kind}\u0000${p.subject.id}\u0000${p.field}`));
  return {
    labels: { total: input.labels.length, unfielded: input.labels.filter((label) => label.field === null).length },
    // `fact_types` is scored by `factMetrics`: one exact-set-equality figure per field would call {ask, deadline} read
    // as {ask} a miss for both, and a message with no fact rows has no prediction at all.
    fields: fieldMetrics(
      input.labels.filter((label) => label.field !== "fact_types"),
      [
        ...input.predictions,
        ...fallback.predictions.filter((p) => !exact.has(`${p.subject.kind}\u0000${p.subject.id}\u0000${p.field}`))
      ]
    ),
    facts: {
      ...factMetrics({
        labels: input.labels,
        rows,
        reached: input.facts?.reached ?? [],
        references: input.facts?.references
      }),
      fallback: { matched: fallback.matched, unmatched: fallback.unmatched }
    },
    wrongAutoActions: wrongAutoActions(input.writes, input.corrections),
    t0: input.t0 === null ? null : t0Share(input.t0),
    caveat: EVAL_CAVEAT
  };
}
