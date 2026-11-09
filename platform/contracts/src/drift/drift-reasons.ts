/**
 * "What pulled you off?" reasons and the tags put on them: the owner's own words about a deviated check-in, and short
 * phrases that name them. Pure and self-contained (the drift boundary test forbids imports from outside this folder).
 * The validator for the rows lives with the other activity-source validators (`activity-drift-reason.ts`) and reads the
 * limits and key builders below, so a writer and the judge cannot disagree. Nothing here sends or reads anything.
 * Words are private: no message built here repeats them. See docs/architecture/drift.md.
 */

/** The source that holds the words and their tags. Owner-only to read and to write: no token scope opens it. */
export const DRIFT_REASON_SOURCE = "drift-reason";
export const REASON_KINDS = ["reason", "reason_tag"] as const;

/** Reasons are capped in characters and in UTF-8 bytes; the byte cap is what keeps a row under the attrs limit. */
export const REASON_TEXT_MAX_CHARS = 1000;
export const REASON_TEXT_MAX_BYTES = 3500;

export const REASON_CHECK_IN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REASON_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
export const REASON_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$/;

export const REASON_TAGS_MAX = 6;
export const REASON_TAG_MAX_CHARS = 40;
/** `ingested_via` of a model-made tag row, reserved for the tagging runner. A corrected row is the person's, so its `ingested_via` is null. */
export const REASON_TAG_INFERRED_VIA = "drift:reason-tag";

/** Whether the text holds a control character (C0, DEL, C1) or a line or paragraph separator; `allowed` code points are let through. */
function hasControl(text: string, allowed: readonly number[] = []): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (allowed.includes(code)) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}
/** A reason may span lines and use tabs. */
const LINE_BREAK_AND_TAB = [0x0a, 0x09];

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;
const charsOf = (text: string): number => Array.from(text).length;

/** The key of a reason row: one per save, named by the client's request id so a retried save writes once. A later save for the same check-in is a new row. */
export function reasonKey(checkInId: string, requestId: string): string {
  return `reason|${checkInId}|${requestId}`;
}

/** The key of an owner-corrected tag row: one per request. */
export function correctedReasonTagKey(checkInId: string, requestId: string): string {
  return `reason_tag|${checkInId}|corrected|${requestId}`;
}

/** The key of a model-made tag row: one per check-in, prompt version and model, so a prompt or model change tags again. */
export function inferredReasonTagKey(checkInId: string, promptVersion: number, modelId: string): string {
  return `reason_tag|${checkInId}|inferred|v${promptVersion}|${modelId}`;
}

/** The text as stored: outer whitespace off, nothing else changed. */
export function normaliseReasonText(raw: string): string {
  return raw.trim();
}

/**
 * What is wrong with a reason's text, or null when it can be stored. The sentence says what the limit is and how far
 * over it the text ran, never what the text says.
 */
export function describeReasonTextProblem(text: unknown): string | null {
  if (typeof text !== "string") return "The reason must be text.";
  if (text.length === 0) return "The reason is empty. Type a few words, or skip it.";
  const chars = charsOf(text);
  if (chars > REASON_TEXT_MAX_CHARS)
    return `The reason is ${chars} characters; the limit is ${REASON_TEXT_MAX_CHARS}. Shorten it.`;
  const bytes = bytesOf(text);
  if (bytes > REASON_TEXT_MAX_BYTES)
    return `The reason takes ${bytes} bytes; the limit is ${REASON_TEXT_MAX_BYTES} (emoji and some scripts take several bytes a character). Shorten it.`;
  if (hasControl(text, LINE_BREAK_AND_TAB)) return "The reason holds a control character. Retype it as plain text.";
  return null;
}

/** One tag as stored: Unicode composed, trimmed, lower case. */
export function normaliseReasonTag(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

/** What is wrong with a list of tags, or null. Open-ended: shape and size only, no vocabulary. Never repeats a tag. */
export function describeReasonTagsProblem(tags: unknown): string | null {
  if (!Array.isArray(tags)) return "attrs.tags must be a list of short phrases.";
  if (tags.length > REASON_TAGS_MAX) return `attrs.tags holds ${tags.length} tags; the limit is ${REASON_TAGS_MAX}.`;
  const seen = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== "string") return "Each tag must be text.";
    const chars = charsOf(tag);
    if (chars < 1 || chars > REASON_TAG_MAX_CHARS) return `Each tag must be 1 to ${REASON_TAG_MAX_CHARS} characters.`;
    if (hasControl(tag)) return "A tag is one line of plain text with no control characters.";
    if (tag !== normaliseReasonTag(tag)) return "Each tag must be trimmed, lower case and Unicode-composed (NFC).";
    if (seen.has(tag)) return "A tag appears twice in one list.";
    seen.add(tag);
  }
  return null;
}

/** One stored `reason` row, as the resolver reads it. */
export interface ReasonRow {
  id: string;
  checkInId: string;
  text: string;
  ingestedAt: Date;
  /** Where the row came from: null for the owner's own. Anything else is ignored. */
  ingestedVia: string | null;
}

/**
 * The reason that stands for each check-in: the owner's latest save, by the time the server stored it, then by row id.
 * A later save for the same check-in is a new row and wins; the earlier words stay stored until the owner deletes the
 * reason. A row that is not the owner's is ignored.
 */
export function resolveReasons(rows: readonly ReasonRow[]): Map<string, ReasonRow> {
  const latest = new Map<string, ReasonRow>();
  for (const row of rows) {
    if (row.ingestedVia !== null) continue;
    const held = latest.get(row.checkInId);
    if (held === undefined || compareReasonRows(row, held) > 0) latest.set(row.checkInId, row);
  }
  return latest;
}

function compareReasonRows(a: ReasonRow, b: ReasonRow): number {
  const byTime = a.ingestedAt.getTime() - b.ingestedAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
