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
export const DERIVED_FACT_TYPES = ["ask", "commitment", "event", "deadline"] as const;
export const DERIVED_TIERS = ["t0", "t1", "t2", "t3"] as const;
/** Attrs of a derived row are small facts and spans, never text, so the cap is half the general 8 KB. */
export const ACTIVITY_DERIVED_ATTRS_MAX_BYTES = 4096;
export const DERIVED_MAX_REASONS = 8;

const FACT_ID = /^[0-9a-f]{40}$/;
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

function checkMsgClass(attrs: Record<string, unknown>): string | null {
  const problem = requireSourceEventId(attrs);
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
  const problem = requireSourceEventId(attrs) ?? requireFactId(attrs);
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
  if (attrs.answer === undefined || attrs.answer === null)
    return "attrs.answer is missing. Send his ground-truth answer for this fact or message.";
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
