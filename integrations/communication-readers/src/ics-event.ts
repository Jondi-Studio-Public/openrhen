import { JSONLD_EVENT_TYPES, classifyMessage, schemaOrgName } from "./classify-message.js";
import { factIdN2 } from "./fact-id-n2.js";
import { instantsAt, rfc3339, validZone, type ResolvedWhen } from "./resolve-when.js";
import { zoneOfTzid } from "./windows-zones.js";

/**
 * `fact-ics` (communication understanding, slice 2b-8): T0 `event` facts from the calendar data the Gmail bridge puts in
 * `attrs.ics` and `attrs.jsonld`. Pure: no clock, no database, no model. The caller (portal/server/derived/fact-ics.ts)
 * looks the stored event up and turns a draft into a row.
 *
 * Trust, in order:
 *   1. Nothing is read unless `attrs.auth` is present, its DMARC result is `pass`, and `auth.dmarc_domain` (the domain
 *      that result was evaluated for) equals the domain of the From address. Absent auth or an absent `dmarc_domain` is
 *      not trusted. SPF and DKIM both passing is NOT enough: they carry no alignment, and an unaligned pass proves only
 *      that the forger controls their own domain.
 *   2. A first invite from a trusted sender is accepted. The fact id carries the authenticated From address and the
 *      uid, so a second sender who copies a uid gets a different event and can never shadow the organizer's.
 *   3. A CANCEL (or STATUS:CANCELLED), and any later invite for a held event (an update), applies only if the
 *      authenticated From address is the original organizer's address (RFC 6047 iMIP), the organizer the message names
 *      (when it names one) is that address too, the uid matches and SEQUENCE is greater than the stored one. Anything
 *      else, including a tie that moves the event, becomes an `unmatched_update` draft: a fact for the owner to review
 *      that carries no time and no link, so it can never close or move anything.
 *   4. The SUMMARY, the JSON-LD name and every other text field are untrusted and are never copied anywhere: the draft
 *      carries closed values and times only, and identity never reads a summary.
 * A reply, counter or refresh (an invitee answering) is not an event and is skipped.
 */

/** The `conversation key` slot of the n2 hash for ICS ids: an event is identified by its uid and sender, not by a thread. */
const ID_SCOPE_EVENT = "ics:event";
const ID_SCOPE_CANCEL = "ics:cancel";
const ID_SCOPE_UNMATCHED = "ics:unmatched";

const DAY_MS = 86_400_000;
const FIELD_MAX = 255;
const CONTROL = /\p{Cc}/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})[+-]\d{2}:\d{2}$/;
/** Methods that start, move or end an event. REPLY, COUNTER, REFRESH, DECLINECOUNTER and ADD are an invitee talking, not an event. */
const EVENT_METHODS: ReadonlySet<string> = new Set(["REQUEST", "PUBLISH", "CANCEL"]);
/** At most this many JSON-LD events become facts in one message. The bridge already keeps at most 5 objects. */
const JSONLD_MAX_EVENTS = 5;
/** The largest SEQUENCE kept: the contract's `ics_sequence` limit (a signed 32-bit integer). */
/** Header reasons (from `classifyMessage`) that mark mail as bulk or machine-sent. */
const BULKISH: ReadonlySet<string> = new Set(["list_id", "unsubscribe_header", "auto_submitted", "noreply_sender"]);
const SEQUENCE_MAX = 2147483647;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

// ---- trust ---------------------------------------------------------------------------------------------------------------

export type IcsAuthReason =
  | "dmarc_pass"
  | "no_auth"
  | "dmarc_not_pass"
  | "alignment_unknown"
  | "domain_unknown"
  | "domain_mismatch"
  | "no_sender";
export interface IcsAuth {
  trusted: boolean;
  /** The lower-case address in the From header; null only when the message names none. */
  sender: string | null;
  reason: IcsAuthReason;
}

const ADDRESS = /^[^\s@<>",;()[\]\\]+@[^\s@<>",;()[\]\\]+$/u;

/**
 * The one mailbox address of a From header, lower case, or null when the header is not exactly one plain mailbox. The
 * header is scanned outside quoted strings: a `<` or `>` inside quotes is display text, not an address, so
 * `"<boss@corp.test>" <bob@evil.test>` is bob's. A header is refused (null, so the message is untrusted) when it holds
 * more than one mailbox (a `,` or `;` outside quotes, or a second angle address), when anything follows the closing `>`,
 * or when the display part holds an `@`, `<` or `>` anywhere, quoted or not, because such a display name exists only to
 * look like another address.
 */
export function fromAddress(from: unknown): string | null {
  const value = text(from);
  if (value === null) return null;
  let quoted = false;
  let open = -1;
  let close = -1;
  let opens = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i]!;
    if (quoted) {
      if (c === "\\") i += 1;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "<") {
      opens += 1;
      open = i;
    } else if (c === ">") close = i;
    else if (c === "," || c === ";") return null;
  }
  if (quoted || opens > 1) return null;
  let address: string;
  if (opens === 0) address = value.trim();
  else {
    if (close < open || value.slice(close + 1).trim() !== "" || /[@<>]/u.test(value.slice(0, open))) return null;
    address = value.slice(open + 1, close).trim();
  }
  address = address.toLowerCase();
  return address.length <= 254 && ADDRESS.test(address) && !CONTROL.test(address) ? address : null;
}

/**
 * Whether the message's From address can be believed. Only when the receiving server reported DMARC `pass` AND the
 * domain that result was evaluated for (`auth.dmarc_domain`, the bridge's lower-case `header.from` of the same result)
 * is the domain of the From address we read. A pass for another domain proves nothing about this sender, and a result
 * with no `dmarc_domain` (older mail, or a header the bridge could not read) is not trusted: the domain is never guessed.
 */
export function icsAuth(attrs: Record<string, unknown>): IcsAuth {
  const auth = attrs.auth;
  const sender = fromAddress(attrs.from);
  if (!isRecord(auth) || Object.values(auth).every((value) => value === undefined))
    return { trusted: false, sender, reason: "no_auth" };
  if (auth.dmarc === undefined) return { trusted: false, sender, reason: "alignment_unknown" };
  if (auth.dmarc !== "pass") return { trusted: false, sender, reason: "dmarc_not_pass" };
  if (sender === null) return { trusted: false, sender, reason: "no_sender" };
  const domain = typeof auth.dmarc_domain === "string" ? auth.dmarc_domain.toLowerCase() : "";
  if (domain === "") return { trusted: false, sender, reason: "domain_unknown" };
  if (domain !== sender.slice(sender.lastIndexOf("@") + 1))
    return { trusted: false, sender, reason: "domain_mismatch" };
  return { trusted: true, sender, reason: "dmarc_pass" };
}

// ---- identity ------------------------------------------------------------------------------------------------------------

export interface IcsEventIdInput {
  uid: string;
  /** RECURRENCE-ID: one instance of a series is its own event. */
  recurrenceId: string | null;
  /** The authenticated From address, lower case. */
  sender: string;
}

/** The fact id of an event: n2 over the uid (the `ics_uid` slot) and the sender. The thread is not part of it. */
export function icsEventFactId(input: IcsEventIdInput): string {
  return factIdN2({
    conversationKey: ID_SCOPE_EVENT,
    sentence: `${input.sender} ${input.recurrenceId ?? "-"}`,
    icsUid: input.uid
  });
}

// ---- reading the ICS attrs -----------------------------------------------------------------------------------------------

interface IcsRead {
  uid: string;
  recurrenceId: string | null;
  sequence: number;
  /** The ORGANIZER the calendar data names (lower case), the string "?" for one that is not an address, null for none. */
  organizer: string | null;
  intent: "invite" | "cancel";
  dtstart: string | null;
  dtend: string | null;
  tzid: string | null;
  tentative: boolean;
}

type IcsReadResult = { ok: true; read: IcsRead } | { ok: false; skip: "no_uid" | "method_not_event" | "bad_sequence" };

function readIcs(ics: Record<string, unknown>): IcsReadResult {
  const method = text(ics.method)?.toUpperCase() ?? null;
  if (method !== null && !EVENT_METHODS.has(method)) return { ok: false, skip: "method_not_event" };
  const uid = ics.uid;
  if (typeof uid !== "string" || uid.length === 0 || uid.length > FIELD_MAX || CONTROL.test(uid))
    return { ok: false, skip: "no_uid" };
  const status = text(ics.status)?.toUpperCase() ?? null;
  // RFC 5545: a missing SEQUENCE is 0. One that is not a whole number from 0 to the cap is refused, not clamped.
  const raw = ics.sequence;
  if (
    raw !== undefined &&
    raw !== null &&
    (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > SEQUENCE_MAX)
  )
    return { ok: false, skip: "bad_sequence" };
  const sequence = typeof raw === "number" ? raw : 0;
  const claimed = text(ics.organizer);
  const organizer = claimed === null ? null : (fromAddress(ics.organizer) ?? "?");
  const recurrence = text(ics.recurrence_id);
  return {
    ok: true,
    read: {
      uid,
      recurrenceId:
        recurrence !== null && recurrence.length <= FIELD_MAX && !CONTROL.test(recurrence) ? recurrence : null,
      sequence,
      organizer,
      intent: method === "CANCEL" || status === "CANCELLED" ? "cancel" : "invite",
      dtstart: text(ics.dtstart),
      dtend: text(ics.dtend),
      tzid: text(ics.tzid),
      tentative: status === "TENTATIVE"
    }
  };
}

// ---- event time ------------------------------------------------------------------------------------------------------------

type Form = "date" | "utc" | "offset" | "local";

function formOf(value: string): Form | null {
  const real = (match: RegExpExecArray | null): boolean => {
    if (match === null) return false;
    const [y, mo, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return false;
    if (match[4] === undefined) return true;
    return Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59;
  };
  if (real(DATE.exec(value))) return "date";
  if (real(UTC.exec(value))) return "utc";
  if (real(LOCAL.exec(value))) return "local";
  if (real(OFFSET.exec(value)) && !Number.isNaN(Date.parse(value))) return "offset";
  return null;
}

const wallUtc = (value: string): number =>
  Date.parse(`${value.slice(0, 19)}${value.length === 10 ? "T00:00:00" : ""}Z`);

interface TimeSpec {
  start: string;
  end: string | null;
  tzid: string | null;
}

/**
 * The `when` of a fact from the start and end the bridge reports, resolved at write like `resolveWhen` does. No zone is
 * guessed: a zone-less (floating) time gives no reading and is `ambiguous`; a TZID that is neither an IANA name nor a common Windows name gives null. A DATE is an all-day
 * event, which a calendar shows on the owner's own day, so it is read in the owner's zone (`ownerTz`, UTC if that is not
 * a zone); it is `ambiguous` like every all-day time and lasts one day when no end is given. Null if the start is not a
 * real date.
 */
function whenOf(spec: TimeSpec, ownerTz: string, refTime: string): ResolvedWhen | null {
  const startForm = formOf(spec.start);
  if (startForm === null) return null;
  const endForm = spec.end === null ? null : formOf(spec.end);
  // An end of another form than the start cannot be read against it (the bridge already withholds those).
  const end = spec.end !== null && endForm === startForm ? spec.end : null;
  const owner = validZone(ownerTz) ? ownerTz : "UTC";
  const base = { ref_time: refTime };

  if (startForm === "utc" || startForm === "offset") {
    const [s, e] = [Date.parse(spec.start), end === null ? NaN : Date.parse(end)];
    return {
      ...base,
      tz: startForm === "utc" ? "UTC" : owner,
      candidates: [{ start: spec.start, ...(e > s ? { end: end as string } : {}) }],
      ambiguous: false
    };
  }

  if (startForm === "date") {
    const first = instantsAt(owner, wallUtc(spec.start)).instants[0]!;
    const last = instantsAt(owner, end === null ? wallUtc(spec.start) + DAY_MS : wallUtc(end)).instants[0]!;
    return {
      ...base,
      tz: owner,
      candidates: [{ start: rfc3339(owner, first), ...(last > first ? { end: rfc3339(owner, last) } : {}) }],
      ambiguous: true
    };
  }

  // Local time. No TZID is a floating time: no zone is guessed and no reading is made. A TZID that is an IANA name or a
  // common Windows name places it; one that is neither cannot be placed, so there is no event time at all.
  if (spec.tzid === null) return { ...base, tz: owner, candidates: [], ambiguous: true };
  const zone = zoneOfTzid(spec.tzid);
  if (zone === null) return null;
  const starts = instantsAt(zone, wallUtc(spec.start));
  const ends = end === null ? null : instantsAt(zone, wallUtc(end));
  const uncertain = starts.gap || starts.instants.length > 1;
  return {
    ...base,
    tz: zone,
    candidates: starts.instants.map((first) => {
      const last = ends?.instants[0];
      return {
        start: rfc3339(zone, first),
        ...(last !== undefined && last > first && !uncertain ? { end: rfc3339(zone, last) } : {})
      };
    }),
    ambiguous: uncertain || (ends !== null && (ends.gap || ends.instants.length > 1))
  };
}

// ---- drafts --------------------------------------------------------------------------------------------------------------

/** The newest event stored under the id a message's calendar data points at. */
export interface StoredIcsEvent {
  /** The highest SEQUENCE seen for the event, its cancels included. A row that never recorded one counts as 0. */
  sequence: number | null;
  /** The authenticated sender the event is held under. */
  organizer: string | null;
  /** The first reading's start and end as stored, to tell a duplicate delivery from a move. */
  start: string | null;
  end: string | null;
}

/**
 * A cancel written as `unmatched_update` earlier (its event was not stored yet), read back so it can be applied once the
 * event exists. Only cancels are held: an update is itself an invite, so one read before the invite it changes is simply
 * the first event stored, and the older invite then reads as the replay it is.
 */
export interface IcsHeldRow {
  /** The event key of the message it came from. */
  sourceKey: string;
  /** That message's time (RFC 3339), the time the resolved row is dated. */
  start: string;
  sequence: number | null;
}

export type IcsSkip =
  | "no_attrs"
  | "no_calendar_data"
  | "untrusted_no_auth"
  | "untrusted_dmarc"
  | "untrusted_no_domain"
  | "untrusted_domain_mismatch"
  | "untrusted_no_sender"
  | "method_not_event"
  | "no_uid"
  | "bad_sequence"
  | "no_time"
  | "duplicate"
  | "bulk_jsonld"
  | "cancelled_jsonld";

export interface IcsFactDraft {
  kind: "event" | "cancel" | "unmatched_update";
  factId: string;
  icsUid: string | null;
  sequence: number | null;
  /** The authenticated sender the event is held under (the organizer key); null for JSON-LD. */
  organizer: string | null;
  confidence?: number;
  /** The resolved time. Never on a cancel or an unmatched update: those carry no time to apply. */
  when?: ResolvedWhen;
  links?: { relation: "cancel"; target_fact_id: string }[];
  reviewReason?: "unmatched_update";
}

/** A row for a message written earlier: its unmatched update, applied now that the event it changes exists. */
export interface IcsResolvedDraft {
  sourceKey: string;
  start: string;
  draft: IcsFactDraft;
}

export interface IcsOutcome {
  drafts: IcsFactDraft[];
  skipped: IcsSkip[];
  /** Held updates and cancels this message's event now lets apply, in SEQUENCE order. Empty unless `drafts` holds an event. */
  resolved: IcsResolvedDraft[];
}

export interface IcsDraftInput {
  /** The message's attrs (gmail shape). */
  attrs: unknown;
  /** `gmail:<thread id>`, the identity scope of a JSON-LD event. */
  conversationKey: string;
  /** The owner's IANA zone, for an all-day date. */
  ownerTz: string;
  /** The message time (RFC 3339), recorded as the time the dates were resolved against. */
  refTime: string;
  /** The event stored under `icsLookupId(attrs)`, or null when none is held. */
  stored: StoredIcsEvent | null;
  /** The unmatched cancels stored under `icsHeldCancelId(attrs)`. Read them only when `drafts` holds an event. */
  held?: readonly IcsHeldRow[];
}

const skipFor = (auth: IcsAuth): IcsSkip =>
  auth.reason === "no_auth"
    ? "untrusted_no_auth"
    : auth.reason === "no_sender"
      ? "untrusted_no_sender"
      : auth.reason === "domain_unknown"
        ? "untrusted_no_domain"
        : auth.reason === "domain_mismatch"
          ? "untrusted_domain_mismatch"
          : "untrusted_dmarc";

/** The fact id of the event a trusted message's calendar data is about, or null when there is none to look up. */
export function icsLookupId(attrs: unknown): string | null {
  if (!isRecord(attrs) || !isRecord(attrs.ics)) return null;
  const auth = icsAuth(attrs);
  if (!auth.trusted || auth.sender === null) return null;
  const read = readIcs(attrs.ics);
  return read.ok
    ? icsEventFactId({ uid: read.read.uid, recurrenceId: read.read.recurrenceId, sender: auth.sender })
    : null;
}

type UnmatchedKind = "cancel" | "invite" | "cancel-foreign" | "invite-foreign";

/**
 * The id an unmatched update or cancel is held under: the sender, uid, recurrence and kind, and nothing of the message.
 * A flood of the same forged cancel is therefore one fact, not one per message. `-foreign` marks calendar data that names
 * an organizer other than its sender; those can never be applied and are never read back.
 */
function unmatchedFactId(uid: string, recurrenceId: string | null, sender: string, kind: UnmatchedKind): string {
  return factIdN2({
    conversationKey: ID_SCOPE_UNMATCHED,
    sentence: `${sender} ${recurrenceId ?? "-"} ${kind}`,
    icsUid: uid
  });
}

/** The id a trusted message's held (unmatched) cancels are stored under, or null when it has no ICS part to resolve. */
export function icsHeldCancelId(attrs: unknown): string | null {
  if (!isRecord(attrs) || !isRecord(attrs.ics)) return null;
  const auth = icsAuth(attrs);
  if (!auth.trusted || auth.sender === null) return null;
  const read = readIcs(attrs.ics);
  return read.ok ? unmatchedFactId(read.read.uid, read.read.recurrenceId, auth.sender, "cancel") : null;
}

/**
 * Whether the update rules are met: the event is held under the sender (the organizer key), the message names no other
 * organizer, and its SEQUENCE is strictly greater than the highest stored (a stored row with none counts as 0).
 */
function updateApplies(read: IcsRead, sender: string, stored: StoredIcsEvent): boolean {
  if (stored.organizer !== sender) return false;
  if (read.organizer !== null && read.organizer !== sender) return false;
  return read.sequence > (stored.sequence ?? 0);
}

/**
 * The fact id of every applied cancel of an event. It has no sequence in it, so one lookup returns them all and the
 * highest is the sequence an older update must beat: a replayed old update cannot bring a cancelled event back.
 */
const cancelId = (uid: string, recurrenceId: string | null, sender: string) =>
  factIdN2({
    conversationKey: ID_SCOPE_CANCEL,
    sentence: `${sender} ${recurrenceId ?? "-"}`,
    icsUid: uid
  });

/** The id the applied cancels of the event a trusted message is about are stored under, or null. */
export function icsCancelFactId(attrs: unknown): string | null {
  if (!isRecord(attrs) || !isRecord(attrs.ics)) return null;
  const auth = icsAuth(attrs);
  if (!auth.trusted || auth.sender === null) return null;
  const read = readIcs(attrs.ics);
  return read.ok ? cancelId(read.read.uid, read.read.recurrenceId, auth.sender) : null;
}

function cancelDraft(
  uid: string,
  recurrenceId: string | null,
  sender: string,
  sequence: number,
  target: string
): IcsFactDraft {
  return {
    kind: "cancel",
    factId: cancelId(uid, recurrenceId, sender),
    icsUid: uid,
    sequence,
    organizer: sender,
    links: [{ relation: "cancel", target_fact_id: target }]
  };
}

/**
 * Applies the cancels held for an event that now exists, in SEQUENCE order, each only if its sequence is
 * greater than the last one applied. This makes the result independent of the order messages were read in: a backfill
 * reads newest first, so a cancel or an update can be read before its invite and is held; when the invite is written,
 * the rules run again against it.
 */
function resolveHeld(
  event: IcsFactDraft,
  uid: string,
  recurrenceId: string | null,
  sender: string,
  held: readonly IcsHeldRow[]
): IcsResolvedDraft[] {
  const out: IcsResolvedDraft[] = [];
  let sequence = event.sequence ?? 0;
  const ordered = [...held].sort(
    (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)
  );
  for (const row of ordered) {
    const next = row.sequence ?? 0;
    if (next <= sequence) continue;
    out.push({
      sourceKey: row.sourceKey,
      start: row.start,
      draft: cancelDraft(uid, recurrenceId, sender, next, event.factId)
    });
    sequence = next;
  }
  return out;
}

function icsDrafts(read: IcsRead, sender: string, input: IcsDraftInput, out: IcsOutcome): void {
  const eventId = icsEventFactId({ uid: read.uid, recurrenceId: read.recurrenceId, sender });
  const { stored } = input;
  // Calendar data that names an organizer other than its own authenticated sender cannot change an event held under
  // that sender: it is the shape of a forged cancel, so it is only ever held for review.
  const foreign = read.organizer !== null && read.organizer !== sender;
  const unmatched = (): IcsFactDraft => ({
    kind: "unmatched_update",
    factId: unmatchedFactId(read.uid, read.recurrenceId, sender, `${read.intent}${foreign ? "-foreign" : ""}`),
    icsUid: read.uid,
    sequence: read.sequence,
    organizer: sender,
    reviewReason: "unmatched_update"
  });

  if (read.intent === "cancel") {
    if (stored === null || !updateApplies(read, sender, stored)) {
      out.drafts.push(unmatched());
      return;
    }
    out.drafts.push(cancelDraft(read.uid, read.recurrenceId, sender, read.sequence, eventId));
    return;
  }

  if (read.dtstart === null) {
    out.skipped.push("no_time");
    return;
  }
  const when = whenOf({ start: read.dtstart, end: read.dtend, tzid: read.tzid }, input.ownerTz, input.refTime);
  if (when === null) {
    out.skipped.push("no_time");
    return;
  }
  const confidence = read.tentative || foreign ? 0.5 : 1;
  if (stored !== null && !updateApplies(read, sender, stored)) {
    const first = when.candidates[0];
    const sameTime = (first?.start ?? null) === stored.start && (first?.end ?? null) === stored.end;
    if (read.sequence === (stored.sequence ?? 0) && sameTime) out.skipped.push("duplicate");
    else out.drafts.push(unmatched());
    return;
  }
  // A first invite is accepted. One that names another organizer than its sender is the on-behalf case (or a forgery
  // of one): it is kept, at half confidence, and nothing later can update it except through that sender.
  const event: IcsFactDraft = {
    kind: "event",
    factId: eventId,
    icsUid: read.uid,
    sequence: read.sequence,
    organizer: sender,
    confidence,
    when
  };
  out.drafts.push(event);
  if (!foreign) out.resolved.push(...resolveHeld(event, read.uid, read.recurrenceId, sender, input.held ?? []));
}

// ---- JSON-LD -------------------------------------------------------------------------------------------------------------

interface LdEvent {
  start: string;
  end: string | null;
  name: string;
  cancelled: boolean;
}

function ldEvents(value: unknown): LdEvent[] {
  if (!Array.isArray(value)) return [];
  const found: LdEvent[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const raw = item["@type"] ?? item.type;
    const types = (Array.isArray(raw) ? raw : [raw]).filter((t): t is string => typeof t === "string");
    if (!types.some((type) => JSONLD_EVENT_TYPES.includes(schemaOrgName(type)))) continue;
    const start = text(item.startDate);
    if (start === null) continue;
    found.push({
      start,
      end: text(item.endDate),
      name: typeof item.name === "string" ? item.name : "",
      cancelled: typeof item.eventStatus === "string" && item.eventStatus.endsWith("EventCancelled")
    });
    if (found.length === JSONLD_MAX_EVENTS) break;
  }
  return found;
}

function jsonLdDrafts(events: readonly LdEvent[], sender: string, input: IcsDraftInput, out: IcsOutcome): void {
  const attrs = input.attrs as Record<string, unknown>;
  // Mail that the headers class as bulk or machine-sent (a list, an unsubscribe link, auto-submitted, a no-reply sender)
  // describes events as marketing does, not as a person arranged them: no T0 event from it.
  if (classifyMessage(attrs).reasons.some((reason) => BULKISH.has(reason))) {
    out.skipped.push("bulk_jsonld");
    return;
  }
  for (const event of events) {
    if (event.cancelled) {
      out.skipped.push("cancelled_jsonld");
      continue;
    }
    const when = whenOf({ start: event.start, end: event.end, tzid: null }, input.ownerTz, input.refTime);
    if (when === null) {
      out.skipped.push("no_time");
      continue;
    }
    out.drafts.push({
      kind: "event",
      factId: factIdN2({
        conversationKey: input.conversationKey,
        sentence: `jsonld ${sender} ${event.start} ${event.end ?? ""} ${event.name}`,
        icsUid: null
      }),
      icsUid: null,
      sequence: null,
      organizer: null,
      confidence: 1,
      when
    });
  }
}

/**
 * The facts a message's calendar data yields, or why it yields none. Deterministic in its input. The order of drafts is
 * the ICS event first, then JSON-LD events in the order the bridge listed them.
 */
export function factIcsDrafts(input: IcsDraftInput): IcsOutcome {
  const out: IcsOutcome = { drafts: [], skipped: [], resolved: [] };
  const attrs = input.attrs;
  if (!isRecord(attrs)) return { drafts: [], skipped: ["no_attrs"], resolved: [] };
  const ics = isRecord(attrs.ics) && Object.keys(attrs.ics).length > 0 ? attrs.ics : null;
  const events = ldEvents(attrs.jsonld);
  if (ics === null && events.length === 0) return { drafts: [], skipped: ["no_calendar_data"], resolved: [] };
  const auth = icsAuth(attrs);
  if (!auth.trusted || auth.sender === null) return { drafts: [], skipped: [skipFor(auth)], resolved: [] };

  if (ics !== null) {
    const read = readIcs(ics);
    if (read.ok) icsDrafts(read.read, auth.sender, input, out);
    else out.skipped.push(read.skip);
  }
  if (events.length > 0) jsonLdDrafts(events, auth.sender, input, out);
  return out;
}

/**
 * Whether `fact-ics` takes this message over, so the model extractor leaves it alone: it is trusted and `fact-ics` writes
 * at least one row for it (an event, a cancel or an unmatched update). A message it skips (untrusted, a reply, no uid or
 * time, bulk JSON-LD) is the model's as usual. Incoming mail only.
 */
export function factIcsHandles(attrs: unknown): boolean {
  if (!isRecord(attrs) || attrs.from_self === true) return false;
  return (
    factIcsDrafts({
      attrs,
      conversationKey: "gmail:-",
      ownerTz: "UTC",
      refTime: "1970-01-01T00:00:00Z",
      stored: null
    }).drafts.length > 0
  );
}
