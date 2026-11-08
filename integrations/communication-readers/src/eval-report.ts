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
  "A few hundred labels show gross failure only: the intervals are wide and the scores cannot calibrate a confidence. Precision is over the labelled messages the extractor wrote a value for; recall is over the random slice alone. Until enough labels exist, the action level is set by tier and structured source, not by these scores.";

export interface EvalReportInput {
  labels: readonly EvalLabel[];
  predictions: readonly EvalPrediction[];
  writes: readonly AutoWrite[];
  corrections: readonly PersonCorrection[];
  /** All messages of the extractor's input source, and how many have a tier-t0 class; null when the input is not known. */
  t0: { messages: number; resolvedByT0: number } | null;
}

export interface EvalReport {
  labels: { total: number; unfielded: number };
  fields: FieldMetrics[];
  wrongAutoActions: { count: number; items: WrongAutoAction[]; truncated: boolean };
  t0: T0Share | null;
  caveat: string;
}

/** The whole report for one extractor version, from plain data. */
export function buildEvalReport(input: EvalReportInput): EvalReport {
  return {
    labels: { total: input.labels.length, unfielded: input.labels.filter((label) => label.field === null).length },
    fields: fieldMetrics(input.labels, input.predictions),
    wrongAutoActions: wrongAutoActions(input.writes, input.corrections),
    t0: input.t0 === null ? null : t0Share(input.t0),
    caveat: EVAL_CAVEAT
  };
}
