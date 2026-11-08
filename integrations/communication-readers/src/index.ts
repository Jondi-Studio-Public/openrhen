export { MSG_CLASSES, MSG_CLASS_REASONS, classifyMessage } from "./classify-message.js";
export type { MessageClassification, MsgClass, MsgClassReason } from "./classify-message.js";
export { EVIDENCE_HASH_HEX_CHARS, locateEvidence, resolveEvidence } from "./evidence-span.js";
export type { EvidenceSpan, ResolvedEvidence } from "./evidence-span.js";
export { NORMALISER_VERSION, factId, normaliseText, readerEventKey, statusEventKey } from "./fact-id.js";
export type { FactIdInput, ReaderEventKeyInput, StatusEventKeyInput } from "./fact-id.js";
export { FACT_STATUSES, isOpenStatus, resolveFactStatus } from "./fact-status.js";
export type { FactStatus, ResolvedStatus, StatusActor, StatusRow } from "./fact-status.js";
export { BACKFILL_LIMITS, estimateBackfill } from "./backfill-estimate.js";
export type { BackfillEstimate, BackfillInput } from "./backfill-estimate.js";
export { EVAL_CAVEAT, buildEvalReport } from "./eval-report.js";
export type { EvalReport, EvalReportInput } from "./eval-report.js";
export { drawSample } from "./eval-sampling.js";
export type { SampleCandidate, SamplePlan, SampleRequest } from "./eval-sampling.js";
export { WRONG_AUTO_ACTIONS_LISTED, fieldMetrics, t0Share, wilsonInterval, wrongAutoActions } from "./eval-stats.js";
export type {
  AutoWrite,
  EvalLabel,
  EvalPrediction,
  EvalSubject,
  FieldMetrics,
  Interval,
  PersonCorrection,
  Rate,
  T0Share,
  WrongAutoAction
} from "./eval-stats.js";
