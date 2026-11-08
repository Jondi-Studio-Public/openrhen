/**
 * The per-kind rules for rows of source `derived`: closed vocabularies and the attrs each kind must carry, applied at
 * ingest to every writer by `validateActivityEvent`. Pure, never throws. The reasons name the allowed values and the
 * exact fix, because the poster is often an automation. See docs/architecture/activity-store.md, "Derived rows".
 *
 * `integrations/communication-readers` holds its own copy of the class, reason and status lists (it imports no
 * workspace package); portal/server/activity-derived-vocabulary.test.ts fails if the copies drift.
 */

export const DERIVED_FACT_STATUSES = [
  "proposed",
  "confirmed",
  "rescheduled",
  "cancelled",
  "done",
  "superseded",
  "source_gone"
] as const;
export const DERIVED_MSG_CLASSES = ["person", "bulk", "automated", "transaction", "calendar"] as const;
/** Why a message got its class. `no_headers` is not here: an unknown message gets no `msg_class` row at all. */
export const DERIVED_MSG_CLASS_REASONS = [
  "ics_present",
  "jsonld_event",
  "jsonld_order",
  "receipt_subject",
  "auto_submitted",
  "list_id",
  "unsubscribe_header",
  "noreply_sender",
  "auth_failed",
  "in_reply_to",
  "from_self",
  "no_automation_signals"
] as const;
/** The kinds an extractor writes: these rows name the extractor version that wrote them, and reads show the active version's only. */
export const DERIVED_EXTRACTOR_KINDS = ["msg_class", "fact"] as const;
export const DERIVED_FACT_TYPES = ["ask", "commitment", "event", "deadline"] as const;
/**
 * The attrs a label can answer. A label about a message (`source_event_id`) answers an attr of its `msg_class` row; one
 * about a fact (`fact_id`) answers an attr of the `fact` row, or its resolved `status`. Fields are checked here so a
 * misspelt one is refused with the list instead of silently never matching a prediction in the eval report.
 */
export const DERIVED_MESSAGE_LABEL_FIELDS = ["class", "reasons", "tier"] as const;
export const DERIVED_FACT_LABEL_FIELDS = [
  "fact_type",
  "who",
  "span",
  "when",
  "direction",
  "conversation_key",
  "ics_uid",
  "confidence",
  "tier",
  "status"
] as const;
/** Which sample a label came from: the stratified draw (precision) or the random recall slice (recall). */
export const DERIVED_LABEL_SLICES = ["random", "stratified"] as const;
export const DERIVED_TIERS = ["t0", "t1", "t2", "t3"] as const;
/** Attrs of a derived row are small facts and spans, never text, so the cap is half the general 8 KB. */
export const ACTIVITY_DERIVED_ATTRS_MAX_BYTES = 4096;
export const DERIVED_MAX_REASONS = 8;

const FACT_ID = /^[0-9a-f]{40}$/;
const EXTRACTOR_NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const EXTRACTOR_VERSION = /^[A-Za-z0-9][A-Za-z0-9.-]{0,19}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const list = (values: readonly string[]) => values.join(", ");
const shown = (value: unknown) =>
  typeof value === "string" ? `"${value.slice(0, 60)}"` : (JSON.stringify(value) ?? "undefined");

/** The shape matched, so check the date exists: `Date.parse` accepts 2026-02-30 as March, so compare the parts too. */
function isRealTime(value: string): boolean {
  if (Number.isNaN(Date.parse(value))) return false;
  const [year, month, day] = [Number(value.slice(0, 4)), Number(value.slice(5, 7)), Number(value.slice(8, 10))];
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function requireFactId(attrs: Record<string, unknown>): string | null {
  const id = attrs.fact_id;
  if (id === undefined)
    return (
      'attrs.fact_id is missing. Send the 40-character fact id the reader returned, such as "' + "0".repeat(40) + '".'
    );
  if (typeof id !== "string" || !FACT_ID.test(id))
    return `attrs.fact_id ${shown(id)} is not a fact id. It must be 40 lowercase hex characters (the sha1 the reader's factId returns).`;
  return null;
}

function requireSourceEventId(attrs: Record<string, unknown>): string | null {
  const id = attrs.source_event_id;
  if (typeof id !== "string" || id.length === 0 || id.length > 200)
    return "attrs.source_event_id must be the event key of the row this was read from, 1 to 200 characters.";
  return null;
}

function checkTier(attrs: Record<string, unknown>): string | null {
  if (attrs.tier === undefined) return null;
  if (typeof attrs.tier !== "string" || !(DERIVED_TIERS as readonly string[]).includes(attrs.tier))
    return `attrs.tier ${shown(attrs.tier)} is not a tier. Use one of: ${list(DERIVED_TIERS)}.`;
  return null;
}

/**
 * `extractor` and `extractor_version` say which extractor version wrote a `msg_class` or `fact` row; reads show a row
 * only while that version is the active one. Both are required: a row naming no version could never be read back.
 */
function checkExtractor(attrs: Record<string, unknown>): string | null {
  const { extractor, extractor_version: version } = attrs;
  if (extractor === undefined && version === undefined)
    return 'attrs.extractor and attrs.extractor_version are missing. A msg_class or fact row names the extractor version that wrote it, such as "extractor": "msg-class-t0", "extractor_version": "1"; reads show only the active version\'s rows, so a row naming none could never be read back.';
  if (typeof extractor !== "string" || !EXTRACTOR_NAME.test(extractor))
    return `attrs.extractor ${shown(extractor)} is not an extractor name. Use lowercase letters, digits and hyphens, 1 to 60 characters, such as "msg-class-t0".`;
  if (typeof version !== "string" || !EXTRACTOR_VERSION.test(version))
    return `attrs.extractor_version ${shown(version)} is not a version. Send the extractor's version as a string of 1 to 20 letters, digits, dots or hyphens, such as "1", alongside attrs.extractor.`;
  return null;
}

function checkMsgClass(attrs: Record<string, unknown>): string | null {
  const problem = requireSourceEventId(attrs) ?? checkExtractor(attrs);
  if (problem) return problem;
  const cls = attrs.class;
  if (cls === "unknown")
    return 'attrs.class "unknown" is never stored: a message with no headers gets no msg_class row. Do not write the row.';
  if (typeof cls !== "string" || !(DERIVED_MSG_CLASSES as readonly string[]).includes(cls))
    return `attrs.class ${shown(cls)} is not a message class. Use one of: ${list(DERIVED_MSG_CLASSES)}.`;
  const reasons = attrs.reasons;
  if (!Array.isArray(reasons) || reasons.length > DERIVED_MAX_REASONS)
    return `attrs.reasons must be a list of at most ${DERIVED_MAX_REASONS} reason codes from: ${list(DERIVED_MSG_CLASS_REASONS)}.`;
  if (new Set(reasons).size !== reasons.length)
    return "attrs.reasons lists a reason code more than once. List each code once.";
  for (const reason of reasons)
    if (typeof reason !== "string" || !(DERIVED_MSG_CLASS_REASONS as readonly string[]).includes(reason))
      return `attrs.reasons has ${shown(reason)}, which is not a reason code. Use only: ${list(DERIVED_MSG_CLASS_REASONS)}.`;
  return checkTier(attrs);
}

function checkFact(attrs: Record<string, unknown>): string | null {
  const problem = requireSourceEventId(attrs) ?? requireFactId(attrs) ?? checkExtractor(attrs);
  if (problem) return problem;
  const type = attrs.fact_type;
  if (typeof type !== "string" || !(DERIVED_FACT_TYPES as readonly string[]).includes(type))
    return `attrs.fact_type ${shown(type)} is not a fact type. Use one of: ${list(DERIVED_FACT_TYPES)}.`;
  const confidence = attrs.confidence;
  if (confidence !== undefined && (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)))
    return "attrs.confidence must be a number between 0 and 1, or left out.";
  return checkTier(attrs);
}

function checkFactStatus(attrs: Record<string, unknown>): string | null {
  const problem = requireFactId(attrs);
  if (problem) return problem;
  const status = attrs.status;
  if (typeof status !== "string" || !(DERIVED_FACT_STATUSES as readonly string[]).includes(status))
    return `attrs.status ${shown(status)} is not a fact status. Use one of: ${list(DERIVED_FACT_STATUSES)}. Send {"fact_id": "...", "status": "confirmed", "valid_from": "2026-11-08T01:00:00Z"}.`;
  if (typeof attrs.valid_from !== "string" || !RFC3339.test(attrs.valid_from) || !isRealTime(attrs.valid_from))
    return 'attrs.valid_from is missing or not an RFC 3339 time. Send when the status took effect, such as "2026-11-08T01:00:00Z".';
  return null;
}

function checkOverride(attrs: Record<string, unknown>): string | null {
  const problem = requireFactId(attrs);
  if (problem) return problem;
  if (typeof attrs.field !== "string" || attrs.field.length === 0 || attrs.field.length > 60)
    return 'attrs.field must name the corrected field of the fact, 1 to 60 characters, such as "when".';
  if (attrs.new_value === undefined) return "attrs.new_value is missing. Send the corrected value (it may be null).";
  return null;
}

function checkLabel(attrs: Record<string, unknown>): string | null {
  if (attrs.fact_id === undefined && attrs.source_event_id === undefined)
    return "A label needs attrs.fact_id (a fact) or attrs.source_event_id (a message) to say what it answers.";
  const problem = attrs.fact_id === undefined ? requireSourceEventId(attrs) : requireFactId(attrs);
  if (problem) return problem;
  if (attrs.answer === undefined)
    return 'attrs.answer is missing. Send his ground-truth answer for this fact or message; send null for "there is no such value" (for example no fact in this message).';
  const labelled = attrs.fact_id === undefined ? "message" : "fact";
  const allowed = labelled === "fact" ? DERIVED_FACT_LABEL_FIELDS : DERIVED_MESSAGE_LABEL_FIELDS;
  const field = attrs.field;
  if (field === undefined)
    return `attrs.field is missing. Name the attr your answer is about; for a ${labelled} it is one of: ${list(allowed)}. Send {"${labelled === "fact" ? "fact_id" : "source_event_id"}": "...", "field": "${allowed[0]}", "answer": ...}.`;
  if (typeof field !== "string" || !(allowed as readonly string[]).includes(field))
    return `attrs.field ${shown(field)} is not a field of a labelled ${labelled}. Use one of: ${list(allowed)}.`;
  const slice = attrs.slice;
  if (
    slice !== undefined &&
    (typeof slice !== "string" || !(DERIVED_LABEL_SLICES as readonly string[]).includes(slice))
  )
    return `attrs.slice ${shown(slice)} is not a sample slice. Use one of: ${list(DERIVED_LABEL_SLICES)}, or leave it out.`;
  const stratum = attrs.stratum;
  if (stratum !== undefined && (typeof stratum !== "string" || stratum.length === 0 || stratum.length > 60))
    return `attrs.stratum ${shown(stratum)} is not a stratum name. Use 1 to 60 characters, such as "t0_flag", or leave it out.`;
  return null;
}

const CHECKS: Readonly<Record<string, (attrs: Record<string, unknown>) => string | null>> = {
  msg_class: checkMsgClass,
  fact: checkFact,
  fact_status: checkFactStatus,
  override: checkOverride,
  label: checkLabel
};

/**
 * Why a row of source `derived` is unacceptable, or null. `by` is never accepted from a client: the server derives it
 * from the posting agent (`ingested_via`; null means the person). A derived row carries no body and its attrs stay
 * under `ACTIVITY_DERIVED_ATTRS_MAX_BYTES`.
 */
export function describeDerivedProblem(
  kind: string,
  attrs: Record<string, unknown>,
  content: string | null
): string | null {
  if ("by" in attrs)
    return "attrs.by is set by the server from the token that posts the row (the person when posted from the owner session). Remove attrs.by.";
  if (content !== null)
    return "A derived row carries no content: it holds spans and closed values, never the message text. Remove content.";
  const bytes = new TextEncoder().encode(JSON.stringify(attrs)).length;
  if (bytes > ACTIVITY_DERIVED_ATTRS_MAX_BYTES)
    return `attrs is ${bytes} bytes; a derived row is limited to ${ACTIVITY_DERIVED_ATTRS_MAX_BYTES}. Keep spans and closed values, not text.`;
  return CHECKS[kind]?.(attrs) ?? null;
}
