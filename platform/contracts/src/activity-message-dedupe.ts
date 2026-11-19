/**
 * Cross-source copies of one message (cross-source dedupe). The same message can reach the store twice by different routes (a
 * collector and a paste, or two collectors), under different keys. Two `message@1` rows are copies of one message when
 * they come from different sources and either carry the same canonical `mid:` key (only when the source's own id has
 * the RFC 5322 shape (one `@` between a local part and a domain), so it is globally unique; a bare chat id such as "12" is only unique inside its own
 * source) or carry the same server-computed `attrs.fp` with sent times at most
 * `MESSAGE_FINGERPRINT_TIME_TOLERANCE_SECONDS` apart. `fp` has no time in it, so the time check is not optional: an
 * equal `fp` and far-apart times are two messages. Two rows of one source are never copies of each other here: that
 * is the unique key's job, and a source's own ids are trusted. Pure and vendor-neutral; the store gathers the held
 * rows and applies the verdict. See docs/operations/posting-messages.md and docs/architecture/activity-store.md.
 */
import {
  MESSAGE_FINGERPRINT_ATTR,
  MESSAGE_FINGERPRINT_TIME_TOLERANCE_SECONDS,
  normaliseMessageId
} from "./activity-message.js";

/** How a copy was recognised. */
export type MessageDuplicateBy = "message_id" | "fingerprint";

/** The one end state a dropped copy ends in: the same word the reconciler's five end states use. */
export const MESSAGE_DUPLICATE_END_STATE = "duplicate" as const;

/** A copy that was not stored, and the row that stands for it. */
export interface MessageDuplicate {
  /** The dropped event's position in the batch. */
  index: number;
  /** The dropped event's own source and key. */
  source: string;
  key: string;
  /** The row that was kept: another source's held row, or an earlier event of this batch (then `index` says which). */
  of: { source: string; key: string; index?: number };
  by: MessageDuplicateBy;
  /** Always `duplicate`: the dropped copy is decided, and is not a row waiting to be. */
  endState: typeof MESSAGE_DUPLICATE_END_STATE;
}

/** An event of the batch, as the comparison needs it. */
export interface MessageCopyProbe {
  index: number;
  source: string;
  key: string;
  tsStart: Date;
  attrs: Readonly<Record<string, unknown>>;
}

/**
 * A row the store already holds. `fp` is its `attrs.fp`, null when it has none. The rest is what supersession needs
 * (`findThinReplacements`); `findMessageDuplicates` ignores it: `id` the row's id, `thin` it holds no text, `viaImport`
 * it came from an explicit file import, `family` its source is in the `message@1` family, `messageId` its
 * `attrs.message_id` as the store normalised it (null when it has none).
 */
export interface HeldMessageRef {
  source: string;
  key: string;
  tsStart: Date;
  fp: string | null;
  id?: string;
  thin?: boolean;
  viaImport?: boolean;
  family?: boolean;
  messageId?: string | null;
}

const TOLERANCE_MS = MESSAGE_FINGERPRINT_TIME_TOLERANCE_SECONDS * 1000;

/** The `attrs.fp` of an event, undefined when it has none. */
export function probeFingerprint(probe: Pick<MessageCopyProbe, "attrs">): string | undefined {
  const fp = probe.attrs[MESSAGE_FINGERPRINT_ATTR];
  return typeof fp === "string" && fp !== "" ? fp : undefined;
}

const ATEXT = "[\\p{L}\\p{N}!#$%&'*+/=?^_`{|}~-]+";
const LOCAL_PART = new RegExp(`^${ATEXT}(?:\\.${ATEXT})*$`, "u");
const DOMAIN_LABEL = "[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?";
const DOMAIN = new RegExp(`^${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+$`, "u");
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_LITERAL = new RegExp(`^\\[${OCTET}(?:\\.${OCTET}){3}\\]$`);

/**
 * Whether an id has the RFC 5322 `Message-ID` shape (`id-left "@" id-right`) that makes it globally unique, judged on
 * the id as stored (after the server has stripped one pair of angle brackets; one pair is also accepted here). The
 * rule: exactly one `@`; a local part of dot-atoms (letters, digits and the RFC `atext` symbols, with single dots only
 * between them, no leading, trailing or doubled dot; non-ASCII letters allowed as in RFC 6532); and a domain that is
 * either a name of at least two dot-separated labels (letters, digits and inner hyphens) or an IPv4 domain literal such
 * as `[192.0.2.1]`. Refused: nested or unbalanced brackets, whitespace, quoted local parts, a dot-less domain such as
 * `user@host/12` or `user@localhost` (a host-local name is not unique), an empty side, and a handle such as
 * `@alice-17`. An id that fails is only unique inside its own source.
 */
export function isRfcMessageId(id: string): boolean {
  const bare = id.startsWith("<") && id.endsWith(">") ? id.slice(1, -1) : id;
  const at = bare.indexOf("@");
  if (at <= 0 || at !== bare.lastIndexOf("@")) return false;
  const local = bare.slice(0, at);
  const domain = bare.slice(at + 1);
  return LOCAL_PART.test(local) && (DOMAIN.test(domain) || IPV4_LITERAL.test(domain));
}

/** Whether the event's `mid:` key may be matched across sources: its own id has the RFC `Message-ID` shape. */
export function probeSharesMessageId(probe: Pick<MessageCopyProbe, "key" | "attrs">): boolean {
  const id = probe.attrs.message_id;
  return probe.key.startsWith("mid:") && typeof id === "string" && isRfcMessageId(id);
}

/** True when the event has something the cross-source check could match on. */
export function isMessageCopyCandidate(probe: Pick<MessageCopyProbe, "key" | "attrs">): boolean {
  return probeFingerprint(probe) !== undefined || probeSharesMessageId(probe);
}

const withinTolerance = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) <= TOLERANCE_MS;
const order = (a: { source: string; key: string }, b: { source: string; key: string }) =>
  a.source.localeCompare(b.source) || a.key.localeCompare(b.key);

/**
 * Which events of a batch are copies. `events` are the batch's `message@1` events in batch order, each one already
 * unique by (source, key); `held` are rows the store holds (a superset is fine, the rules are re-applied here). Held
 * rows are compared first, so a copy always points at the oldest thing the store has; then earlier kept events of the
 * same batch (the first wins). A matched event is not compared against later ones, so the verdict never chains
 * through a copy. A message-id match wins over a fingerprint match.
 */
export function findMessageDuplicates(
  events: readonly MessageCopyProbe[],
  held: readonly HeldMessageRef[]
): MessageDuplicate[] {
  const duplicates: MessageDuplicate[] = [];
  const kept: MessageCopyProbe[] = [];
  for (const event of events) {
    const fp = probeFingerprint(event);
    const sharesId = probeSharesMessageId(event);
    const verdict = (by: MessageDuplicateBy, of: MessageDuplicate["of"]): MessageDuplicate => ({
      index: event.index,
      source: event.source,
      key: event.key,
      of,
      by,
      endState: MESSAGE_DUPLICATE_END_STATE
    });
    let found: MessageDuplicate | undefined;
    if (sharesId) {
      const row = held.filter((r) => r.source !== event.source && r.key === event.key).sort(order)[0];
      if (row) found = verdict("message_id", { source: row.source, key: row.key });
    }
    if (!found && fp !== undefined) {
      const row = held
        .filter((r) => r.source !== event.source && r.fp === fp && withinTolerance(r.tsStart, event.tsStart))
        .sort((a, b) => a.tsStart.getTime() - b.tsStart.getTime() || order(a, b))[0];
      if (row) found = verdict("fingerprint", { source: row.source, key: row.key });
    }
    if (!found && sharesId) {
      const row = kept.find((r) => r.source !== event.source && r.key === event.key);
      if (row) found = verdict("message_id", { source: row.source, key: row.key, index: row.index });
    }
    if (!found && fp !== undefined) {
      const row = kept.find(
        (r) => r.source !== event.source && probeFingerprint(r) === fp && withinTolerance(r.tsStart, event.tsStart)
      );
      if (row) found = verdict("fingerprint", { source: row.source, key: row.key, index: row.index });
    }
    if (found) duplicates.push(found);
    else kept.push(event);
  }
  return duplicates;
}

/** Which side of a supersession an incoming event is: an import row holding text, or a thin row holding none. */
export type ThinReplacementRole = "superseder" | "thin";

/** An incoming event the supersession check looks at. `superseder`: from an explicit import, with text after the gate. `thin`: a mail-like row outside the family with no text after the gate. */
export interface ThinReplacementProbe extends MessageCopyProbe {
  role: ThinReplacementRole;
}

/** One link to write: the incoming event either replaces a thin held row, or is itself replaced by a held import row. */
export interface ThinReplacement {
  /** The incoming event's position in the batch. */
  index: number;
  source: string;
  key: string;
  role: "replaces" | "replaced_by";
  /** The held row on the other side of the link; `id` is for the store and is not reported. */
  other: { source: string; key: string; id: string };
  by: MessageDuplicateBy;
}

/**
 * The message id an event may be matched on across sources, normalised the way the key is (`normaliseMessageId`):
 * `attrs.message_id` when it has the RFC shape, else the id inside a `mid:` key. Undefined for anything else, so a bare
 * chat id is never matched across sources. Raw mail ids arrive unnormalised, which is why this normalises.
 */
export function matchedMessageId(probe: Pick<MessageCopyProbe, "key" | "attrs">): string | undefined {
  const raw = probe.attrs.message_id;
  if (typeof raw === "string") {
    const id = normaliseMessageId(raw);
    if (isRfcMessageId(id)) return id;
  }
  if (probe.key.startsWith("mid:")) {
    const id = normaliseMessageId(probe.key.slice(4));
    if (isRfcMessageId(id)) return id;
  }
  return undefined;
}

function heldMessageId(row: HeldMessageRef): string | undefined {
  if (typeof row.messageId === "string") {
    const id = normaliseMessageId(row.messageId);
    return isRfcMessageId(id) ? id : undefined;
  }
  return row.key.startsWith("mid:") && isRfcMessageId(normaliseMessageId(row.key.slice(4)))
    ? normaliseMessageId(row.key.slice(4))
    : undefined;
}

const byAge = (a: HeldMessageRef, b: HeldMessageRef) => a.tsStart.getTime() - b.tsStart.getTime() || order(a, b);

/**
 * Which held copies an incoming event replaces, or is replaced by (supersession: a text-bearing copy from an explicit
 * file import stands in for a thin copy that holds no text, in a different source). Per event, in batch order:
 *
 * - `superseder` (an import row with text): every held *thin* row of another source with the same message id (RFC shape
 *   only) or the same `fp` within the time tolerance (for an `fp` only the single nearest in time, so two identical short messages are not both
 *   covered by one import row). If a visible non-thin copy in the family matches, nothing is
 *   returned: that is `findMessageDuplicates`' case and the import copy is dropped as before. A non-thin row outside the
 *   family is not compared with anything, so it neither blocks nor is linked.
 * - `thin` (no text): the oldest held import row with text, of another source, with the same message id. By message id
 *   only: a thin row outside the family has no `fp`.
 *
 * `held` must already exclude rows that are superseded, so a superseded row is never matched and a chain cannot form.
 * Pure; the store writes the links. Rows of one source are never compared: a source's own ids are trusted.
 */
export function findThinReplacements(
  events: readonly ThinReplacementProbe[],
  held: readonly HeldMessageRef[]
): ThinReplacement[] {
  const out: ThinReplacement[] = [];
  for (const event of events) {
    const id = matchedMessageId(event);
    const fp = probeFingerprint(event);
    const other = (row: HeldMessageRef) => ({ source: row.source, key: row.key, id: row.id ?? "" });
    const base = { index: event.index, source: event.source, key: event.key };
    if (event.role === "thin") {
      if (id === undefined) continue;
      const row = held
        .filter((r) => r.source !== event.source && r.viaImport === true && r.thin !== true && heldMessageId(r) === id)
        .sort(byAge)[0];
      if (row) out.push({ ...base, role: "replaced_by", other: other(row), by: "message_id" });
      continue;
    }
    const matches: { row: HeldMessageRef; by: MessageDuplicateBy }[] = [];
    for (const row of held) {
      if (row.source === event.source) continue;
      if (id !== undefined && heldMessageId(row) === id) matches.push({ row, by: "message_id" });
      else if (fp !== undefined && row.fp === fp && withinTolerance(row.tsStart, event.tsStart))
        matches.push({ row, by: "fingerprint" });
    }
    if (matches.some(({ row }) => row.thin !== true && row.family === true)) continue;
    const thinMatches = matches.filter(({ row }) => row.thin === true);
    // Every thin row of the same message id is the same message. A fingerprint is only the same text: two identical
    // short messages ("ok" twice within a minute) must not both disappear behind one import row, so a fingerprint
    // match covers the single thin row nearest in time to the import row (earliest, then lowest key, on a tie).
    const byId = thinMatches.filter((item) => item.by === "message_id");
    const nearest = thinMatches
      .filter((item) => item.by === "fingerprint")
      .sort(
        (a, b) =>
          Math.abs(a.row.tsStart.getTime() - event.tsStart.getTime()) -
            Math.abs(b.row.tsStart.getTime() - event.tsStart.getTime()) || byAge(a.row, b.row)
      )
      .slice(0, 1);
    [...byId, ...nearest]
      .sort((a, b) => byAge(a.row, b.row))
      .forEach(({ row, by }) => out.push({ ...base, role: "replaces", other: other(row), by }));
  }
  return out;
}
