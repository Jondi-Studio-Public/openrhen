export { MSG_CLASSES, MSG_CLASS_REASONS, classifyMessage } from "./classify-message.js";
export type { MessageClassification, MsgClass, MsgClassReason } from "./classify-message.js";
export { EVIDENCE_HASH_HEX_CHARS, locateEvidence, resolveEvidence, searchEvidence } from "./evidence-span.js";
export type { EvidenceSearch, EvidenceSpan, ResolvedEvidence } from "./evidence-span.js";
export { MAX_SENTENCE_CODE_POINTS, SPLITTER_VERSION, sentenceAt, splitSentences } from "./sentence-split.js";
export type { SentenceUnit } from "./sentence-split.js";
export { FACT_ID_NORMALISER_VERSION, factIdN2, stripQuoteMarkers } from "./fact-id-n2.js";
export type { FactIdN2Input } from "./fact-id-n2.js";
export {
  GROUNDING_FAILURES,
  MAX_CONTENT_CODE_POINTS,
  MAX_QUOTE_CODE_POINTS,
  groundQuote,
  tallyGrounding
} from "./ground-quote.js";
export type { GroundQuoteInput, GroundingFailure, GroundingResult, GroundingTally } from "./ground-quote.js";
export { MAX_WHO, messageFactContext } from "./message-context.js";
export type { MessageFactContext, MessageFactContextFailure } from "./message-context.js";
export { NORMALISER_VERSION, factId, normaliseText, readerEventKey, statusEventKey } from "./fact-id.js";
export type { FactIdInput, ReaderEventKeyInput, StatusEventKeyInput } from "./fact-id.js";
export { FACT_STATUSES, isOpenStatus, resolveFactStatus } from "./fact-status.js";
export type { FactStatus, ResolvedStatus, StatusActor, StatusRow } from "./fact-status.js";
export {
  AMBIGUOUS_TIME_GRACE_HOURS,
  ASK_HORIZON_DAYS,
  LINK_CHAIN_MAX,
  NO_TIME_HORIZON_DAYS,
  compareOpenFacts,
  foldFactStates,
  openFacts,
  statusActorOf
} from "./fact-state.js";
export type {
  FactClosedBy,
  FactFold,
  FactFoldState,
  FoldFactRow,
  FoldInput,
  FoldLink,
  FoldMessage,
  FoldOverride,
  FoldStatus,
  FoldWhen
} from "./fact-state.js";
export { BACKFILL_LIMITS, estimateBackfill } from "./backfill-estimate.js";
export type { BackfillEstimate, BackfillInput } from "./backfill-estimate.js";
export { EVAL_CAVEAT, buildEvalReport } from "./eval-report.js";
export type { EvalReport, EvalReportInput } from "./eval-report.js";
export { FACT_TYPES, factMetrics, fallbackFactPredictions } from "./eval-facts.js";
export type {
  FactEvalInput,
  FactMetrics,
  FactReference,
  FactRow,
  FactSpan,
  FactTypeMetrics,
  FalseAlarms
} from "./eval-facts.js";
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
