export { MSG_CLASSES, MSG_CLASS_REASONS, classifyMessage } from "./classify-message.js";
export type { MessageClassification, MsgClass, MsgClassReason } from "./classify-message.js";
export { EVIDENCE_HASH_HEX_CHARS, locateEvidence, resolveEvidence } from "./evidence-span.js";
export type { EvidenceSpan, ResolvedEvidence } from "./evidence-span.js";
export { NORMALISER_VERSION, factId, normaliseText, readerEventKey, statusEventKey } from "./fact-id.js";
export type { FactIdInput, ReaderEventKeyInput, StatusEventKeyInput } from "./fact-id.js";
export { FACT_STATUSES, isOpenStatus, resolveFactStatus } from "./fact-status.js";
export type { FactStatus, ResolvedStatus, StatusActor, StatusRow } from "./fact-status.js";
