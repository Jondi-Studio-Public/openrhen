/**
 * The neutral message family `message@1`: the one kind (`message`), the attrs it may carry, the two canonical key rules,
 * the content fingerprint `attrs.fp`, and the pure validator `validateActivityEvent` applies to every source whose
 * registry `family` is `message@1` (the way it applies `describePhysiologyProblem` to `physiology`). Pure, never throws.
 * The reasons name the field and the exact fix, because the poster is often an automation. It names no vendor: a
 * collector maps its own mailbox, chat or notification feed onto these fields and posts them. Information only: nothing
 * here may change what the plan allows, and the engine never imports this module. The grandfathered mail source is not
 * in this family and is untouched; its rows relate to the family as docs/operations/posting-messages.md says. See
 * docs/architecture/activity-store.md.
 */
import { sha256Hex } from "./sha256.js";

export const MESSAGE_FAMILY = "message@1";
export const MESSAGE_KIND = "message";

export const MESSAGE_ID_MAX_CHARS = 200;
export const MESSAGE_SENDER_MAX_CHARS = 200;
export const MESSAGE_TO_MAX = 20;
export const MESSAGE_CHANNEL_MAX_CHARS = 128;
export const MESSAGE_THREAD_ID_MAX_CHARS = 200;
export const MESSAGE_SUBJECT_MAX_CHARS = 200;
/** Only the first this-many characters (code points) of the normalised text are hashed. */
export const MESSAGE_FINGERPRINT_TEXT_MAX_CHARS = 8192;
/** `attrs.fp` is this many hex characters (128 bits of sha256). */
export const MESSAGE_FINGERPRINT_HEX_CHARS = 32;
/** A `fp:` key carries this many hex characters, as does the hashed form of a long `mid:` key. */
export const MESSAGE_KEY_HASH_HEX_CHARS = 40;
export const MESSAGE_DIRECTIONS = ["in", "out"] as const;
/** What a collector may send in `attrs`. `fp` is not among them: the server computes it. */
export const MESSAGE_ATTRS = [
  "message_id",
  "from",
  "to",
  "from_self",
  "direction",
  "channel",
  "thread_id",
  "subject"
] as const;
/** A message sent before this is a bad clock or a bad parse (the same floor as a coverage window). */
export const MESSAGE_START_FLOOR = new Date("1990-01-01T00:00:00.000Z");
/**
 * The window in which two rows with the same `attrs.fp` count as one message when the store compares them. `fp` has no
 * time in it, so this range check is part of the contract, not an option; it is applied by the cross-source lookup
 * (slice B2), which does not exist yet.
 */
export const MESSAGE_FINGERPRINT_TIME_TOLERANCE_SECONDS = 60;
/** The server-computed attr: a hash of the normalised sender and normalised text. */
export const MESSAGE_FINGERPRINT_ATTR = "fp";
const KEY_MAX_CHARS = 200;

type Attrs = Record<string, unknown>;

/**
 * Characters no party, subject, channel, thread or id may hold: controls and line or paragraph separators, and the
 * format characters that hide text or reorder it (zero-width space, word joiner, byte order mark, bidirectional
 * embeddings, overrides and isolates, the tag block). These fields reach agent-facing output. ZWNJ, ZWJ and the
 * directional marks stay legal: Persian, Arabic, Indic and Hebrew text needs them.
 */
export const HIDDEN_OR_CONTROL_CHARS =
  /[\p{Cc}\p{Zl}\p{Zp}\u200B\u2060\uFEFF\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/u;
const PLAIN_TEXT_FIX =
  "It must be plain text on one line: no newline, control, zero-width or text-reordering characters (ZWNJ and ZWJ are fine).";

const ZERO_WIDTH = /[​-‍⁠﻿]/g;

/** Unicode NFKC, lower-case, zero-width characters and BOM removed, every run of whitespace one space, trimmed. */
function foldText(text: string): string {
  return text.normalize("NFKC").replace(ZERO_WIDTH, "").toLowerCase().replace(/\s+/gu, " ").trim();
}

/** The text a fingerprint is taken over: folded, then cut to its first `MESSAGE_FINGERPRINT_TEXT_MAX_CHARS` code points. Empty means "no usable text". */
export function normaliseMessageText(text: string): string {
  const folded = foldText(text);
  const points = Array.from(folded);
  return points.length > MESSAGE_FINGERPRINT_TEXT_MAX_CHARS
    ? points.slice(0, MESSAGE_FINGERPRINT_TEXT_MAX_CHARS).join("").trim()
    : folded;
}

/** The sender as hashed: the same folding as text, so a display name and an address both compare case-insensitively. */
export function normaliseMessageSender(sender: string): string {
  return foldText(sender);
}

/**
 * The source's own message id as keyed: trimmed; one pair of angle brackets stripped; the part after the last `@`
 * lower-cased (local parts are case-sensitive); an id with no `@` as given. Empty means "no id".
 */
export function normaliseMessageId(raw: string): string {
  let id = raw.trim();
  if (id.startsWith("<") && id.endsWith(">")) id = id.slice(1, -1).trim();
  const at = id.lastIndexOf("@");
  return at < 0 ? id : `${id.slice(0, at)}@${id.slice(at + 1).toLowerCase()}`;
}

/**
 * `attrs.fp`: 32 hex characters of sha256 over the normalised sender and normalised text. Time is deliberately not in
 * it: a time bucket would split one message across a bucket edge or an offset, so the fingerprint is only a candidate
 * key and any lookup MUST also require the sent times to lie within `MESSAGE_FINGERPRINT_TIME_TOLERANCE_SECONDS`
 * (slice B2). Two rows with an equal fp and far-apart times are different messages. Returns undefined when the text normalises to nothing, so a message with no text has no fp.
 */
export function messageFingerprint(sender: string, text: string): string | undefined {
  const normalisedText = normaliseMessageText(text);
  if (normalisedText === "") return undefined;
  return sha256Hex(JSON.stringify([normaliseMessageSender(sender), normalisedText])).slice(
    0,
    MESSAGE_FINGERPRINT_HEX_CHARS
  );
}

export interface MessageKeyInput {
  /** The source's own message id as sent (normalised here); absent or blank when the source has none. */
  messageId?: string | undefined;
  sender: string;
  tsStart: Date;
  /** The raw message text, when the event carries it. */
  content: string | null;
}

/**
 * The one canonical key: `mid:<normalised id>` (its sha256 first 40 hex when that would pass the 200 character key
 * limit), else `fp:<40 hex>` of sha256 over (normalised sender, the sent time floored to the UTC minute, normalised
 * text). Undefined when the event has neither an id nor usable text.
 */
export function canonicalMessageKey(input: MessageKeyInput): string | undefined {
  const id = input.messageId === undefined ? "" : normaliseMessageId(input.messageId);
  if (id !== "") {
    const key = `mid:${id}`;
    return key.length <= KEY_MAX_CHARS ? key : `mid:${sha256Hex(id).slice(0, MESSAGE_KEY_HASH_HEX_CHARS)}`;
  }
  const text = input.content === null ? "" : normaliseMessageText(input.content);
  if (text === "") return undefined;
  const minute = new Date(Math.floor(input.tsStart.getTime() / 60_000) * 60_000).toISOString();
  return `fp:${sha256Hex(JSON.stringify([normaliseMessageSender(input.sender), minute, text])).slice(0, MESSAGE_KEY_HASH_HEX_CHARS)}`;
}

export interface MessageEventInput {
  id: string;
  kind: string;
  tsStart: Date;
  tsEnd: Date | null;
  /** The event's free `content` (the message text), before any content gate. */
  content: string | null;
  attrs: Attrs;
}

export type MessageVerdict = { ok: true; attrs: Attrs } | { ok: false; reason: string };

const bad = (reason: string): MessageVerdict => ({ ok: false, reason });
const isAddress = (value: string) => value.includes("@") && !/\s/u.test(value);
/** An address is lower-cased whole; anything else (a display name, a chat handle) is kept as sent, trimmed. */
const tidyParty = (value: string) => (isAddress(value.trim()) ? value.trim().toLowerCase() : value.trim());
const listOf = (values: readonly string[]) => values.join(", ");

/**
 * What is wrong with a `message@1` event, or the attrs to store: the sent ones tidied (message_id normalised,
 * addresses lower-cased) plus the computed `fp` when the event carries text. The fingerprint is taken here, from the
 * raw `content`, so it exists even when the source's content gate later drops the text. Events whose kind is not
 * `message` (for example `correction`) are not this validator's.
 */
export function describeMessageProblem(event: MessageEventInput): MessageVerdict {
  if (event.kind !== MESSAGE_KIND) return { ok: true, attrs: event.attrs };
  const { attrs } = event;
  if (event.tsEnd !== null)
    return bad("A message is an instant (the time it was sent). Leave end out and send the sent time as start.");
  if (event.tsStart.getTime() <= MESSAGE_START_FLOOR.getTime())
    return bad(
      `A message's start (${event.tsStart.toISOString()}) must be after ${MESSAGE_START_FLOOR.toISOString().slice(0, 10)}. Send the time it was sent, not an unset or zero clock.`
    );
  if (Object.hasOwn(attrs, MESSAGE_FINGERPRINT_ATTR)) return bad("attrs.fp is computed by the server; leave fp out.");
  const extra = Object.keys(attrs).find((name) => !(MESSAGE_ATTRS as readonly string[]).includes(name));
  if (extra !== undefined)
    return bad(`attrs "${extra.slice(0, 60)}" is not allowed on a message. Allowed: ${listOf(MESSAGE_ATTRS)}.`);

  // Returns the trimmed text, undefined when absent and not required, null when it is the wrong type, blank or too long.
  // A hidden or control character is a separate, named refusal (see `plain`).
  const text = (name: string, max: number, required: boolean): string | undefined | null => {
    const value = attrs[name];
    if (value === undefined) return required ? null : undefined;
    if (typeof value !== "string" || value.trim() === "") return null;
    // Caps count code points, not UTF-16 units: a 100-emoji subject is 100 characters, not 200.
    if (Array.from(value.trim()).length > max) return null;
    return value.trim();
  };
  const plain = (name: string, value: string): MessageVerdict | undefined => {
    if (!HIDDEN_OR_CONTROL_CHARS.test(value)) return undefined;
    const reason = `attrs.${name} holds a character that is not allowed. ${PLAIN_TEXT_FIX}`;
    if (/[\r\n]/u.test(value))
      return bad(
        name === "subject"
          ? `${reason} A subject read from a folded header is on several lines: unfold the header (join its lines into one line with a single space where each break was) and send it again.`
          : `${reason} Join its lines into one line with a single space where each break was, then send it again.`
      );
    return bad(reason);
  };
  const from = text("from", MESSAGE_SENDER_MAX_CHARS, true);
  if (from === null || from === undefined)
    return bad(
      `attrs.from is required: the sender as the source names it, 1 to ${MESSAGE_SENDER_MAX_CHARS} characters of text. Send attrs {"from": "alex@example.com"}.`
    );
  const fromProblem = plain("from", from);
  if (fromProblem) return fromProblem;
  const out: Attrs = { from: tidyParty(from) };

  const messageId = text("message_id", MESSAGE_ID_MAX_CHARS, false);
  if (messageId === null)
    return bad(
      `attrs.message_id must be the source's own message id, 1 to ${MESSAGE_ID_MAX_CHARS} characters of text, or left out.`
    );
  let normalisedId: string | undefined;
  if (messageId !== undefined) {
    const idProblem = plain("message_id", messageId);
    if (idProblem) return idProblem;
    if (/\s/u.test(messageId))
      return bad(
        "attrs.message_id must not contain spaces or other whitespace (it becomes part of the event key). Send the id exactly as the source gives it, such as <4f2a91@mail.example.com>."
      );
    normalisedId = normaliseMessageId(messageId);
    if (normalisedId === "")
      return bad("attrs.message_id is empty once its angle brackets are removed. Send the id, or leave it out.");
    out.message_id = normalisedId;
  }

  if (attrs.to !== undefined) {
    const to = attrs.to;
    if (
      !Array.isArray(to) ||
      to.length > MESSAGE_TO_MAX ||
      to.some(
        (item) =>
          typeof item !== "string" || item.trim() === "" || Array.from(item.trim()).length > MESSAGE_SENDER_MAX_CHARS
      )
    )
      return bad(
        `attrs.to must be a list of at most ${MESSAGE_TO_MAX} recipients, each 1 to ${MESSAGE_SENDER_MAX_CHARS} characters of text, or left out.`
      );
    for (const item of to as string[]) {
      const toProblem = plain("to", item);
      if (toProblem) return toProblem;
    }
    out.to = (to as string[]).map(tidyParty);
  }
  if (attrs.from_self !== undefined) {
    if (typeof attrs.from_self !== "boolean") return bad("attrs.from_self must be true or false, or left out.");
    out.from_self = attrs.from_self;
  }
  if (attrs.direction !== undefined) {
    if (!(MESSAGE_DIRECTIONS as readonly unknown[]).includes(attrs.direction))
      return bad(`attrs.direction must be one of: ${listOf(MESSAGE_DIRECTIONS)}, or left out.`);
    out.direction = attrs.direction;
  }
  for (const [name, max] of [
    ["channel", MESSAGE_CHANNEL_MAX_CHARS],
    ["thread_id", MESSAGE_THREAD_ID_MAX_CHARS],
    ["subject", MESSAGE_SUBJECT_MAX_CHARS]
  ] as const) {
    const value = text(name, max, false);
    if (value === null) return bad(`attrs.${name} must be text of 1 to ${max} characters, or left out.`);
    if (value !== undefined) {
      const problem = plain(name, value);
      if (problem) return problem;
      out[name] = value;
    }
  }

  const expected = canonicalMessageKey({
    messageId: normalisedId,
    sender: from,
    tsStart: event.tsStart,
    content: event.content
  });
  if (expected === undefined)
    return bad(
      "A message needs something to be keyed on: send attrs.message_id (the source's own message id), or send the text in content. With neither there is nothing to tell this message from another."
    );
  if (event.id !== expected)
    return bad(
      `id "${event.id.slice(0, 60)}" is not this message's key. The key is derived from ${normalisedId === undefined ? "the sender, the sent time to the minute and the text" : "attrs.message_id"}; send id "${expected}".`
    );

  if (event.content !== null) {
    const fp = messageFingerprint(from, event.content);
    if (fp !== undefined) out[MESSAGE_FINGERPRINT_ATTR] = fp;
  }
  return { ok: true, attrs: out };
}
