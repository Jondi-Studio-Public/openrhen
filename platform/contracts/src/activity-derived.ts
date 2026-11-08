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
 * `fact_types` is his answer to "which kinds of fact does this message hold": a set of `DERIVED_FACT_TYPES`, where `[]`
 * is the answer "none" (a real answer, unlike `null`). `sensitive` is true or false: the message must never leave the
 * machine for a hosted model.
 */
export const DERIVED_MESSAGE_LABEL_FIELDS = ["class", "reasons", "tier", "fact_types", "sensitive"] as const;
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
/** Which way a message went, from the bridge's `from_self` and never from a model. */
export const DERIVED_DIRECTIONS = ["in", "out"] as const;
/** A fact row that cancels, moves or repeats another fact. Links are resolved at read; extractors never write a status. */
export const DERIVED_LINK_RELATIONS = ["cancel", "reschedule", "repeat"] as const;
/**
 * Why a fact needs a person's eye, as stored. Only reasons an extractor knows when it writes: `expired` (age),
 * `update_seen` (a later link row) and `t3_deferred` (the daily cap) change with time or later rows, so they are computed
 * at read from other data and stored never.
 */
export const DERIVED_STORED_REVIEW_REASONS = ["ambiguous_date", "unmatched_update", "over_cap", "low_signal"] as const;
export const DERIVED_COMPUTED_REVIEW_REASONS = ["expired", "update_seen", "t3_deferred"] as const;
/** `who` is the authenticated sender for `in` (one) and the recipients as typed for `out` (at most three). */
export const DERIVED_MAX_WHO = 3;
export const DERIVED_MAX_WHEN_CANDIDATES = 3;
export const DERIVED_MAX_LINKS = 3;
/** A grounded quote is at most this many code points; `communication-readers` keeps a copy (MAX_QUOTE_CODE_POINTS). */
export const DERIVED_SPAN_MAX_CODE_POINTS = 200;
/** Message text longer than this is not read for facts, so no offset can point past it. `communication-readers` keeps a copy. */
export const DERIVED_CONTENT_MAX_CODE_POINTS = 200000;
/** The only attrs a `fact` row may carry: a key outside this list is refused, so no free-text field can be smuggled in. */
export const DERIVED_FACT_ATTR_KEYS = [
  "source_event_id",
  "fact_id",
  "fact_type",
  "confidence",
  "tier",
  "extractor",
  "extractor_version",
  "span",
  "when",
  "who",
  "direction",
  "conversation_key",
  "ics_uid",
  "links",
  "model",
  "review_reason"
] as const;

const FACT_ID = /^[0-9a-f]{40}$/;
const EXTRACTOR_NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const EXTRACTOR_VERSION = /^[A-Za-z0-9][A-Za-z0-9.-]{0,19}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const list = (values: readonly string[]) => values.join(", ");
const shown = (value: unknown) =>
  typeof value === "string" ? `"${value.slice(0, 60)}"` : (JSON.stringify(value) ?? "undefined");

/**
 * The shape matched, so check the time exists: `Date.parse` accepts 2026-02-30 as March and hour 24 as the next day, so
 * compare the parts too. Year 0000, hour 24, minute or second 60 and an offset past 23:59 are refused.
 */
function isRealTime(value: string): boolean {
  if (Number.isNaN(Date.parse(value))) return false;
  const [year, month, day] = [Number(value.slice(0, 4)), Number(value.slice(5, 7)), Number(value.slice(8, 10))];
  const [hour, minute, second] = [
    Number(value.slice(11, 13)),
    Number(value.slice(14, 16)),
    Number(value.slice(17, 19))
  ];
  const offset = /[+-](\d{2}):(\d{2})$/.exec(value);
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (offset === null || (Number(offset[1]) <= 23 && Number(offset[2]) <= 59))
  );
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

const SPAN_HASH = /^[0-9a-f]{12}$/;
const CONVERSATION_KEY = /^gmail:[^\s\p{Cc}]{1,128}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;
const MODEL_DIGEST = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;
const CONTROL = /\p{Cc}/u;
/** Control characters and the line and paragraph separators (U+2028, U+2029), which could split a stored value in a log. */
const WHO_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const INVISIBLE_OR_SPACE = /[\s\p{Cf}]/gu;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A closed object: any key outside `allowed` is refused with the list, so a misspelt or smuggled field is not silently kept. */
function unknownKey(value: Record<string, unknown>, allowed: readonly string[], name: string): string | null {
  const extra = Object.keys(value).find((key) => value[key] !== undefined && !allowed.includes(key));
  return extra === undefined ? null : `${name} has "${extra}", which is not a field of it. Use only: ${list(allowed)}.`;
}

function checkSpan(value: unknown): string | null {
  if (!isRecord(value))
    return 'attrs.span must be an object {"start": 120, "end": 168, "hash": "0123456789ab"}: the quote\'s offsets in Unicode code points (end exclusive) and the 12-hex content hash, never the quote text.';
  const extra = unknownKey(value, ["start", "end", "hash"], "attrs.span");
  if (extra) return `${extra} Offsets and a hash only: the quote text is never stored.`;
  if (!isCount(value.start) || !isCount(value.end))
    return "attrs.span.start and attrs.span.end must each be a whole number of code points, 0 or more.";
  if (value.end <= value.start) return "attrs.span.end must be greater than start (end is exclusive).";
  if (value.end > DERIVED_CONTENT_MAX_CODE_POINTS)
    return `attrs.span ends at ${value.end}, past the ${DERIVED_CONTENT_MAX_CODE_POINTS} code points of message text that are read. Send offsets inside the message.`;
  if (value.end - value.start > DERIVED_SPAN_MAX_CODE_POINTS)
    return `attrs.span covers ${value.end - value.start} code points; a grounded quote is at most ${DERIVED_SPAN_MAX_CODE_POINTS}. Ground a shorter quote.`;
  if (typeof value.hash !== "string" || !SPAN_HASH.test(value.hash))
    return `attrs.span.hash ${shown(value.hash)} is not a content hash. It must be 12 lowercase hex characters (the hash locateEvidence returns).`;
  return null;
}

function checkOffsets(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 2 || !isCount(value[0]) || !isCount(value[1]) || value[1] <= value[0])
    return "attrs.when.raw must be two offsets [start, end] into the message in code points, start before end, such as [412, 423]. It is never the date text.";
  if (value[1] > DERIVED_CONTENT_MAX_CODE_POINTS)
    return `attrs.when.raw ends at ${value[1]}, past the ${DERIVED_CONTENT_MAX_CODE_POINTS} code points of message text that are read. Send offsets inside the message.`;
  return null;
}

function checkCandidate(value: unknown, index: number): string | null {
  const name = `attrs.when.candidates[${index}]`;
  if (!isRecord(value))
    return `${name} must be an object {"start": "2026-11-13T09:00:00+11:00"}, with an optional "end".`;
  const extra = unknownKey(value, ["start", "end"], name);
  if (extra) return extra;
  for (const field of ["start", "end"] as const) {
    const time = value[field];
    if (field === "end" && time === undefined) continue;
    if (typeof time !== "string" || !RFC3339.test(time) || !isRealTime(time))
      return `${name}.${field} ${shown(time)} is not an RFC 3339 time with an offset, such as "2026-11-13T09:00:00+11:00".`;
  }
  if (typeof value.end === "string" && Date.parse(value.end) < Date.parse(value.start as string))
    return `${name}.end ${shown(value.end)} is before its start ${shown(value.start)}. An end is never before the start; leave end out for a point in time.`;
  return null;
}

let zones: ReadonlySet<string> | null = null;
/** The IANA zones this runtime knows, plus UTC. Case matters: "sydney" and "+11:00" are not zones. */
function isTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  zones ??= new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);
  return zones.has(value);
}

/** The date resolved at write: `raw` offsets, the reference time and zone it was resolved against, and up to 3 readings. */
function checkWhen(value: unknown): string | null {
  if (!isRecord(value))
    return 'attrs.when must be an object {"ref_time": "2026-11-08T01:00:00Z", "tz": "Australia/Sydney", "candidates": [{"start": "2026-11-13T09:00:00+11:00"}], "ambiguous": false}, with an optional "raw": [412, 423].';
  const extra = unknownKey(value, ["raw", "ref_time", "tz", "candidates", "ambiguous"], "attrs.when");
  if (extra) return `${extra} The date text is never stored.`;
  if (value.raw !== undefined) {
    const problem = checkOffsets(value.raw);
    if (problem) return problem;
  }
  const ref = value.ref_time;
  if (typeof ref !== "string" || !RFC3339.test(ref) || !isRealTime(ref))
    return `attrs.when.ref_time ${shown(ref)} is missing or not an RFC 3339 time. Send the message time the date was resolved against, such as "2026-11-08T01:00:00Z".`;
  if (typeof value.tz !== "string" || !isTimeZone(value.tz))
    return `attrs.when.tz ${shown(value.tz)} is missing or not an IANA time zone. Send the zone the date was resolved in, such as "Australia/Sydney" or "UTC".`;
  if (typeof value.ambiguous !== "boolean")
    return "attrs.when.ambiguous must be true or false: true when the time is recurring, all-day, floating or has several readings.";
  const candidates = value.candidates;
  if (!Array.isArray(candidates))
    return `attrs.when.candidates must be a list of at most ${DERIVED_MAX_WHEN_CANDIDATES} readings (empty when nothing resolved), such as [{"start": "2026-11-13T09:00:00+11:00"}].`;
  if (candidates.length > DERIVED_MAX_WHEN_CANDIDATES)
    return `attrs.when.candidates has ${candidates.length} readings; keep at most ${DERIVED_MAX_WHEN_CANDIDATES} and set ambiguous to true.`;
  for (const [index, candidate] of candidates.entries()) {
    const problem = checkCandidate(candidate, index);
    if (problem) return problem;
  }
  if (!value.ambiguous && candidates.length !== 1)
    return `attrs.when.ambiguous is false but candidates has ${candidates.length} readings. A time that is not ambiguous has exactly one candidate; set ambiguous to true if there are none or several.`;
  return null;
}

function checkDirection(value: unknown): string | null {
  if (typeof value !== "string" || !(DERIVED_DIRECTIONS as readonly string[]).includes(value))
    return `attrs.direction ${shown(value)} is not a direction. Use one of: ${list(DERIVED_DIRECTIONS)}. It comes from the bridge's from_self (true is out), never from a model.`;
  return null;
}

function checkWho(attrs: Record<string, unknown>): string | null {
  const who = attrs.who;
  if (!Array.isArray(who))
    return `attrs.who must be a list: the sender's address for direction "in", or 1 to ${DERIVED_MAX_WHO} recipients as typed for "out", such as ["alex@example.test"].`;
  if (attrs.direction === undefined)
    return 'attrs.direction is missing. attrs.who reads differently for each direction, so send "direction": "in" (who is the sender) or "out" (who is the recipients) beside it.';
  const problem = checkDirection(attrs.direction);
  if (problem) return problem;
  if (attrs.direction === "in" && who.length !== 1)
    return `attrs.who has ${who.length} entries; for direction "in" it is exactly one: the authenticated sender.`;
  if (attrs.direction === "out" && (who.length < 1 || who.length > DERIVED_MAX_WHO))
    return `attrs.who has ${who.length} entries; for direction "out" it is 1 to ${DERIVED_MAX_WHO} recipients as typed. Keep the first ${DERIVED_MAX_WHO}.`;
  for (const [index, entry] of who.entries())
    if (
      typeof entry !== "string" ||
      entry.length > 254 ||
      WHO_FORBIDDEN.test(entry) ||
      entry.replace(INVISIBLE_OR_SPACE, "").length === 0
    )
      return `attrs.who[${index}] ${shown(entry)} is not an address as typed: send text of 1 to 254 characters with no control characters.`;
  // Differs from messageFactContext on purpose: that drops repeats by the address inside <...>, case-insensitively, while
  // reading headers; this last guard compares only the whole typed string (trimmed, case-insensitive).
  if (new Set(who.map((entry: string) => entry.trim().toLowerCase())).size !== who.length)
    return "attrs.who lists an address more than once (case aside). List each address once.";
  return null;
}

function checkConversationKey(value: unknown): string | null {
  if (typeof value !== "string" || !CONVERSATION_KEY.test(value))
    return `attrs.conversation_key ${shown(value)} is not a conversation key. Use "gmail:" followed by the thread id, with no spaces, such as "gmail:18c0ffee12345678".`;
  return null;
}

function checkIcsUid(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 255 || CONTROL.test(value))
    return `attrs.ics_uid ${shown(value)} is not an iCalendar UID. Send the event's UID text, 1 to 255 characters with no control characters, or leave it out.`;
  return null;
}

function checkLinks(attrs: Record<string, unknown>): string | null {
  const links = attrs.links;
  if (!Array.isArray(links) || links.length === 0)
    return `attrs.links must be a list of 1 to ${DERIVED_MAX_LINKS} links such as [{"relation": "cancel", "target_fact_id": "${"0".repeat(40)}"}], or left out.`;
  if (links.length > DERIVED_MAX_LINKS)
    return `attrs.links has ${links.length} links; keep at most ${DERIVED_MAX_LINKS}.`;
  const seen = new Set<string>();
  for (const [index, link] of links.entries()) {
    const name = `attrs.links[${index}]`;
    if (!isRecord(link)) return `${name} must be an object {"relation": "cancel", "target_fact_id": "..."}.`;
    const extra = unknownKey(link, ["relation", "target_fact_id"], name);
    if (extra) return extra;
    if (typeof link.relation !== "string" || !(DERIVED_LINK_RELATIONS as readonly string[]).includes(link.relation))
      return `${name}.relation ${shown(link.relation)} is not a relation. Use one of: ${list(DERIVED_LINK_RELATIONS)}.`;
    const target = link.target_fact_id;
    if (typeof target !== "string" || !FACT_ID.test(target))
      return `${name}.target_fact_id ${shown(target)} is not a fact id. It must be 40 lowercase hex characters (the id of the fact this row cancels, moves or repeats).`;
    if (target === attrs.fact_id)
      return `${name} targets the row's own fact_id. A link points at a different fact, never at itself.`;
    const key = `${link.relation}:${target}`;
    if (seen.has(key)) return "attrs.links lists the same link more than once. List each relation and target once.";
    seen.add(key);
  }
  return null;
}

/** The model that read the message: its id, and the Ollama digest when the host reports one. Never a key or a host. */
function checkModel(value: unknown): string | null {
  if (!isRecord(value))
    return 'attrs.model must be an object {"id": "qwen3:14b", "digest": "a1b2c3d4e5f6"}: the pinned model that read the message (digest optional).';
  const extra = unknownKey(value, ["id", "digest"], "attrs.model");
  if (extra) return `${extra} Never send a key or a host.`;
  if (typeof value.id !== "string" || !MODEL_ID.test(value.id))
    return `attrs.model.id ${shown(value.id)} is not a model id. Send the pinned id, 1 to 100 characters with no spaces, such as "qwen3:14b".`;
  if (value.digest !== undefined && (typeof value.digest !== "string" || !MODEL_DIGEST.test(value.digest)))
    return `attrs.model.digest ${shown(value.digest)} is not a model digest. Send up to 100 letters, digits or : . _ - characters, or leave it out.`;
  return null;
}

function checkReviewReason(value: unknown): string | null {
  if (typeof value === "string" && (DERIVED_COMPUTED_REVIEW_REASONS as readonly string[]).includes(value))
    return `attrs.review_reason "${value}" is computed when the fact is read (it follows time, a later row or the daily cap), so it is never stored. Remove attrs.review_reason, or use a reason known at write time: ${list(DERIVED_STORED_REVIEW_REASONS)}.`;
  if (typeof value !== "string" || !(DERIVED_STORED_REVIEW_REASONS as readonly string[]).includes(value))
    return `attrs.review_reason ${shown(value)} is not a stored review reason. Use one of: ${list(DERIVED_STORED_REVIEW_REASONS)}, or leave it out.`;
  return null;
}

/**
 * A model-tier fact (t2, t3) names its model and carries a grounded span: the extractor writes a fact only after its
 * quote matched the message exactly once, so there is no model fact without a span. A t0 fact is code and has no model.
 */
function checkModelTier(attrs: Record<string, unknown>): string | null {
  if ((attrs.span !== undefined || attrs.model !== undefined) && attrs.tier === undefined)
    return `attrs.tier is missing. A fact that carries a span or a model says how it was read: use one of ${list(DERIVED_TIERS)} (t0 code, t2 or t3 a model).`;
  const modelTier = attrs.tier === "t2" || attrs.tier === "t3";
  if (modelTier && attrs.model === undefined)
    return `attrs.model is missing. A ${attrs.tier} fact names the pinned model that read the message, such as "model": {"id": "qwen3:14b"}.`;
  if (!modelTier && attrs.model !== undefined)
    return `attrs.model is set on a ${attrs.tier} fact. Only a model tier names a model; use tier t2 or t3, or remove attrs.model.`;
  if (modelTier && attrs.span === undefined)
    return `attrs.span is missing. A ${attrs.tier} fact is written only after its quote was grounded (found exactly once in the message), so it carries the span locateEvidence returned.`;
  return null;
}

const FACT_ATTR_CHECKS: ReadonlyArray<[string, (value: unknown, attrs: Record<string, unknown>) => string | null]> = [
  ["span", checkSpan],
  ["when", checkWhen],
  ["direction", checkDirection],
  ["who", (_value, attrs) => checkWho(attrs)],
  ["conversation_key", checkConversationKey],
  ["ics_uid", checkIcsUid],
  ["links", (_value, attrs) => checkLinks(attrs)],
  ["model", checkModel],
  ["review_reason", checkReviewReason]
];

function checkFactAttrs(attrs: Record<string, unknown>): string | null {
  const extra = unknownKey(attrs, DERIVED_FACT_ATTR_KEYS, "attrs");
  if (extra) return `${extra} A fact row holds closed values and offsets, never text.`;
  for (const [name, check] of FACT_ATTR_CHECKS) {
    if (attrs[name] === undefined) continue;
    const problem = check(attrs[name], attrs);
    if (problem) return problem;
  }
  return checkModelTier(attrs);
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
  return checkTier(attrs) ?? checkFactAttrs(attrs);
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

/** The answers whose shape is closed: `fact_types` is a set of fact types (`[]` is "none"), `sensitive` a boolean. */
function labelAnswerProblem(labelled: string, field: string, answer: unknown): string | null {
  if (labelled !== "message") return null;
  if (field === "fact_types") {
    if (!Array.isArray(answer))
      return `attrs.answer for fact_types must be a list of fact types from: ${list(DERIVED_FACT_TYPES)}. Send [] for "this message holds no fact"; null is not an answer here, because [] is how a message with none is told apart from one not yet labelled.`;
    if (new Set(answer).size !== answer.length)
      return "attrs.answer lists a fact type more than once. A fact_types answer is a set: list each type once.";
    for (const type of answer)
      if (typeof type !== "string" || !(DERIVED_FACT_TYPES as readonly string[]).includes(type))
        return `attrs.answer has ${shown(type)}, which is not a fact type. Use only: ${list(DERIVED_FACT_TYPES)}.`;
  }
  if (field === "sensitive" && typeof answer !== "boolean")
    return `attrs.answer for sensitive must be true or false (true: this message must never go to a hosted model); ${shown(answer)} is neither.`;
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
  const answerProblem = labelAnswerProblem(labelled, field, attrs.answer);
  if (answerProblem) return answerProblem;
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
