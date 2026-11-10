import { createHash } from "node:crypto";
import {
  angleIds,
  decodeBytes,
  decodeEncodedWords,
  decodeTransfer,
  headerOf,
  headersOf,
  hex,
  htmlToText,
  parseAddressList,
  parseEnvelopeDate,
  parseHeaderBlock,
  parseMailDate,
  parseParams,
  plainLine,
  type Header,
  type ParsedDate
} from "../mail-mime.js";
import {
  count,
  detail,
  ImportReadError,
  skip,
  warn,
  type ActivityEventDraft,
  type ByteSource,
  type Stats
} from "../types.js";

/**
 * A standards-only mail file importer: `.mbox` (mboxrd and mboxo: `From ` separator lines, `>From ` unescaping) and
 * single `.eml` (RFC 5322 / MIME). Each message becomes one `message@1` event keyed by the contracts' rules. The key
 * functions are injected (`MailKeying`) because this package imports no workspace package; the CLI passes the real
 * ones. Nothing here names a mail provider or a source: the caller chooses the source name.
 *
 * Strict by design: a file that is not mbox, garbage where a header should be, a multipart with no closing boundary,
 * an unknown transfer encoding or charset, and a message over the size cap all throw `ImportReadError` naming the
 * file, the message and its byte offset. A message is held in memory only while it is parsed (at most
 * `maxMessageBytes`); the file is read as a stream. Attachments are counted and never read.
 */

export interface MailKeying {
  normaliseMessageId(raw: string): string;
  isRfcMessageId(id: string): boolean;
  /** The contracts' `canonicalMessageKey`. */
  canonicalMessageKey(input: {
    messageId?: string;
    sender: string;
    tsStart: Date;
    content: string | null;
  }): string | undefined;
  /** The longest `attrs.message_id` an event may carry. */
  messageIdMaxChars: number;
  /** The most bytes of `content` one event may carry. */
  contentMaxBytes: number;
}

export interface MailOptions {
  /** The source every event carries; chosen by the caller. */
  source: string;
  keying: MailKeying;
  /** Hard bound on one message's raw size; a larger message is an error. */
  maxMessageBytes: number;
  /** Addresses that are the owner's own, lower-case; mail from them is `from_self`, `direction: "out"`. */
  selfAddresses?: readonly string[];
  now?: Date;
  /**
   * Off by default: any message that cannot be read stops the import. On: such a message (bad charset or transfer
   * encoding, unclosed multipart, damaged headers, over the size cap) is skipped, counted, and named in `stats.details`.
   * A file that is not mbox at all, or empty, still stops the import.
   */
  skipUnreadable?: boolean;
  /** Message-ID digests already emitted in this import, shared by every file of it. */
  seen: Set<string>;
}

export interface MailFile {
  /** The file's path inside its container, for messages. */
  name: string;
}

export const MAIL_DEFAULT_MAX_MESSAGE_BYTES = 128 * 1024 * 1024;
export const MAIL_HARD_MAX_MESSAGE_BYTES = 512 * 1024 * 1024;
const HEADER_FLOOR = new Date("1990-01-01T00:00:00.000Z");
const MAX_DEPTH = 25;
const MAX_PARTS = 5000;
const SUBJECT_MAX = 200;
const SENDER_MAX = 200;
const CHANNEL_MAX = 128;
const THREAD_MAX = 200;
const TO_MAX = 20;

const ENVELOPE = /^From (\S+)[ \t]+(.*?)\r?\n?$/;
function envelopeOf(line: Buffer): string | null {
  if (
    line.length < 7 ||
    line[0] !== 0x46 ||
    line[1] !== 0x72 ||
    line[2] !== 0x6f ||
    line[3] !== 0x6d ||
    line[4] !== 0x20
  )
    return null;
  const text = line.subarray(0, 400).toString("latin1");
  const match = ENVELOPE.exec(text);
  if (!match || !/\d{1,2}:\d{2}/.test(match[2]!) || !/[A-Za-z]{3}/.test(match[2]!)) return null;
  return match[2]!;
}

const baseOf = (name: string) => name.slice(name.lastIndexOf("/") + 1);
const stemOf = (name: string) => baseOf(name).replace(/\.[^.]*$/, "");

interface Pending {
  index: number;
  offset: number;
  envelope: string | null;
  chunks: Buffer[];
  size: number;
  /** Set (skip mode only) when the message went over the cap: its text is dropped as it streams past. */
  discard?: string;
}

/** Streams `source` and yields one event per message. See the module comment for what throws. */
export async function* parseMailFile(
  source: ByteSource,
  file: MailFile,
  options: MailOptions,
  stats: Stats
): AsyncGenerator<ActivityEventDraft> {
  let mode: "mbox" | "eml" | null = null;
  let current = null as Pending | null;
  let index = 0;
  let offset = 0;
  let carry: Buffer[] = [];
  let carryLength = 0;
  let dropping = false;
  const isEml = baseOf(file.name).toLowerCase().endsWith(".eml");

  // Over the cap: strict mode stops; skip mode drops what was held and ignores the rest of the message.
  const overCap = (m: Pending, extra: number) => {
    if (m.size + extra <= options.maxMessageBytes) return;
    const inner = `is larger than the per-message cap of ${options.maxMessageBytes} bytes. Nothing was truncated. Raise the cap with --max-message-mib <n> (at most ${MAIL_HARD_MAX_MESSAGE_BYTES / 1048576}) or remove that message from the file, then run the import again.`;
    if (!options.skipUnreadable) throw new ImportReadError(wrap(file, m, inner));
    m.discard = inner;
    m.chunks = [];
    m.size = 0;
  };

  // Returns the finished message when this line starts the next one.
  const feed = (line: Buffer): Pending | null => {
    let finished: Pending | null = null;
    if (mode === null) {
      const envelope = envelopeOf(line);
      if (envelope !== null) mode = "mbox";
      else if (isEml) mode = "eml";
      else
        throw new ImportReadError(
          `${file.name}: not an mbox file: byte 0 does not start with a "From " separator line (it starts with bytes ${hex(line)}). If this is a single message, give it the .eml extension. If it should be an mbox, check it was not converted, compressed or saved from a viewer.`
        );
    }
    if (mode === "mbox") {
      const envelope = envelopeOf(line);
      if (envelope !== null) {
        finished = current;
        index += 1;
        current = { index, offset, envelope, chunks: [], size: 0 };
        offset += line.length;
        return finished;
      }
    } else if (current === null) {
      index = 1;
      current = { index, offset, envelope: null, chunks: [], size: 0 };
    }
    const m = current!;
    if (m.discard) {
      offset += line.length;
      return null;
    }
    // mboxrd/mboxo: one level of ">" is removed from every ">...>From " line.
    const text = mode === "mbox" && line[0] === 0x3e ? line.subarray(0, 400).toString("latin1") : "";
    const body = text !== "" && /^>+From /.test(text) ? line.subarray(1) : line;
    overCap(m, body.length);
    if (!m.discard) {
      m.chunks.push(body);
      m.size += body.length;
    }
    offset += line.length;
    return null;
  };

  const handle = function* (m: Pending): Generator<ActivityEventDraft> {
    if (m.discard) {
      stats.read += 1;
      unreadable(stats, file, m, m.discard);
      return;
    }
    const event = parseMessage(Buffer.concat(m.chunks), m, file, options, stats);
    if (event) yield event;
  };

  for await (const chunk of source) {
    const buf =
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (let nl = buf.indexOf(10, start); nl >= 0; nl = buf.indexOf(10, start)) {
      if (dropping) {
        dropping = false;
        offset += nl + 1 - start;
        start = nl + 1;
        continue;
      }
      const part = buf.subarray(start, nl + 1);
      const line = carry.length > 0 ? Buffer.concat([...carry, part]) : Buffer.from(part);
      carry = [];
      carryLength = 0;
      start = nl + 1;
      const done = feed(line);
      if (done) yield* handle(done);
    }
    if (start < buf.length) {
      if (dropping) continue;
      carry.push(Buffer.from(buf.subarray(start)));
      carryLength += buf.length - start;
      if (current && !current.discard && current.size + carryLength > options.maxMessageBytes)
        overCap(current, carryLength);
      if (current?.discard && carryLength > 65536) {
        // A line with no end inside a message already being dropped: drop it as it arrives.
        offset += carryLength;
        carry = [];
        carryLength = 0;
        dropping = true;
      }
      if (mode === null && carryLength > 1 << 20) feed(Buffer.concat(carry));
    }
  }
  if (carry.length > 0) {
    const done = feed(Buffer.concat(carry));
    if (done) yield* handle(done);
  }
  if (mode === null || current === null)
    throw new ImportReadError(
      `${file.name}: the file is empty or holds no message. Check that it downloaded completely; an empty mailbox should not be imported.`
    );
  yield* handle(current);
}

const SKIP_HINT =
  " To import everything else and list the unreadable messages in the summary, run again with --skip-unreadable.";
const wrap = (file: MailFile, m: Pending, inner: string) =>
  `${file.name}: message ${m.index} (starts at byte ${m.offset}): ${inner}${SKIP_HINT}`;

/** Counts and names a message skipped in skip mode; the reason bucket is fixed, the detail has the specifics. */
function unreadable(stats: Stats, file: MailFile, m: Pending, inner: string): void {
  const bucket = /charset/.test(inner)
    ? "unknown charset"
    : /Content-Transfer-Encoding|base64/.test(inner)
      ? "unknown or damaged transfer encoding"
      : /boundary|multipart/.test(inner)
        ? "multipart damaged or cut off"
        : /per-message cap/.test(inner)
          ? "over the per-message size cap"
          : /header/.test(inner)
            ? "garbage where a header should be"
            : "damaged message";
  skip(stats, `unreadable message skipped (--skip-unreadable): ${bucket}`);
  detail(stats, `${file.name} message ${m.index} (byte ${m.offset}): ${inner.split(/\.\s/)[0]!.slice(0, 200)}`);
}

function parseMessage(
  raw: Buffer,
  m: Pending,
  file: MailFile,
  options: MailOptions,
  stats: Stats
): ActivityEventDraft | null {
  try {
    return buildEvent(raw, m, file, options, stats);
  } catch (error) {
    if (!(error instanceof ImportReadError)) throw error;
    if (options.skipUnreadable) {
      unreadable(stats, file, m, error.message);
      return null;
    }
    throw new ImportReadError(wrap(file, m, error.message));
  }
}

interface Extracted {
  kind: "plain" | "html";
  text: string;
}

interface Walk {
  stats: Stats;
  parts: number;
}

function buildEvent(
  rawBytes: Buffer,
  m: Pending,
  file: MailFile,
  options: MailOptions,
  stats: Stats
): ActivityEventDraft | null {
  const { keying } = options;
  const now = options.now ?? new Date();
  stats.read += 1;
  const text = rawBytes.toString("latin1");
  const { headers, bodyStart } = parseHeaderBlock(text, 0, stats);
  if (headers.length === 0)
    throw new ImportReadError("the message has no headers. The file may be damaged or not mail.");

  // Sender.
  const decode = (value: string) => decodeEncodedWords(value, stats);
  const fromBox = headersOf(headers, "from").flatMap(parseAddressList)[0];
  let sender = fromBox ? plainLine(fromBox.address || decode(fromBox.name), stats) : "";
  if (sender === "") {
    skip(stats, "no sender (the From header is missing or empty)");
    return null;
  }
  if (Array.from(sender).length > SENDER_MAX) {
    sender = Array.from(sender).slice(0, SENDER_MAX).join("");
    warn(stats, "the sender was cut to 200 characters");
  }

  // Message-ID.
  const idHeaders = headersOf(headers, "message-id");
  if (idHeaders.length > 1) warn(stats, "more than one Message-ID header; the first was used");
  const rawId = idHeaders[0] ? angleIds(idHeaders[0])[0] : undefined;
  const normalised = rawId === undefined ? "" : keying.normaliseMessageId(rawId);
  const rfcValid =
    normalised !== "" &&
    !/\s/u.test(normalised) &&
    normalised.length <= keying.messageIdMaxChars &&
    keying.isRfcMessageId(normalised);
  if (rfcValid) {
    const digest = createHash("sha256").update(normalised).digest("base64").slice(0, 22);
    if (options.seen.has(digest)) {
      stats.ignored += 1;
      count(stats, "duplicate Message-ID in this import (first copy kept)");
      return null;
    }
  }

  // Time.
  const now1 = now.getTime() + 24 * 3_600_000;
  const plausible = (p: ParsedDate | null) => p !== null && p.date >= HEADER_FLOOR && p.date.getTime() <= now1;
  const dateHeader = headerOf(headers, "date");
  let when = dateHeader === undefined ? null : parseMailDate(dateHeader);
  let approximate = false;
  if (!plausible(when)) {
    const why =
      dateHeader === undefined || dateHeader.trim() === ""
        ? "is missing"
        : when === null
          ? /(?:^|\s)[+-](?:[01]\d|2\d)\d\d\s*(?:\(.*\))?$/.test(dateHeader) && !/:\d\d\s*$/.test(dateHeader)
            ? "has a time zone beyond +-14:00"
            : "cannot be parsed"
          : "is absurd (before 1990 or in the future)";
    const envelope = m.envelope === null ? null : parseEnvelopeDate(m.envelope);
    const received = headersOf(headers, "received").at(-1);
    const hop = received === undefined ? null : parseMailDate(received.slice(received.lastIndexOf(";") + 1));
    if (plausible(envelope)) {
      when = envelope;
      warn(stats, `Date header ${why}; the separator line's date was used`);
    } else if (plausible(hop)) {
      when = hop;
      warn(stats, `Date header ${why}; the Received header's date was used`);
    } else {
      skip(stats, "no usable date in the Date header, the separator line or Received");
      return null;
    }
    approximate = true;
  } else if (when?.zoneUnknown) {
    warn(stats, "Date header names a time zone this importer does not know; it was read as UTC");
  }

  // Body.
  const walk: Walk = { stats, parts: 0 };
  const body = extractEntity(headers, text, bodyStart, text.length, 0, walk);
  let content: string | undefined;
  if (body && body.text !== "") {
    let out = body.text.replace(/\r\n?/g, "\n").trim();
    if (Buffer.byteLength(out) > keying.contentMaxBytes) {
      out = Buffer.from(out).subarray(0, keying.contentMaxBytes).toString("utf8").replace(/�+$/u, "");
      warn(stats, `text was cut to ${keying.contentMaxBytes} bytes, the most one event holds`);
    }
    if (out !== "") content = out;
  }

  // Key: the Message-ID when it has the RFC shape, else the text fingerprint, else (no text) the odd id itself.
  let messageId: string | undefined = rfcValid ? normalised : undefined;
  const keyFor = () =>
    keying.canonicalMessageKey({
      ...(messageId === undefined ? {} : { messageId }),
      sender,
      tsStart: when!.date,
      content: content ?? null
    });
  let id = keyFor();
  if (!rfcValid && rawId !== undefined) {
    if (id !== undefined) warn(stats, "Message-ID is not RFC-shaped; keyed by sender, minute and text");
    else if (normalised !== "" && !/\s/u.test(normalised) && normalised.length <= keying.messageIdMaxChars) {
      messageId = normalised;
      id = keyFor();
      warn(
        stats,
        "Message-ID is not RFC-shaped and there is no text; keyed by the id (unique only inside this source)"
      );
    }
  }
  if (id === undefined) {
    skip(stats, "no Message-ID and no text, so there is nothing to key it on");
    return null;
  }

  // Attrs.
  const attrs: Record<string, unknown> = { from: sender };
  if (messageId !== undefined) attrs.message_id = messageId;
  const recipients: string[] = [];
  for (const value of [...headersOf(headers, "to"), ...headersOf(headers, "cc")])
    for (const box of parseAddressList(value)) {
      const party = plainLine(box.address || decode(box.name), stats);
      if (party === "" || recipients.includes(party)) continue;
      if (Array.from(party).length > SENDER_MAX) {
        warn(stats, "a recipient longer than 200 characters was dropped");
        continue;
      }
      recipients.push(party);
    }
  if (recipients.length > TO_MAX) {
    warn(stats, "recipients beyond the first 20 were dropped");
    recipients.length = TO_MAX;
  }
  if (recipients.length > 0) attrs.to = recipients;
  if (options.selfAddresses && options.selfAddresses.length > 0) {
    const mine = options.selfAddresses.includes(sender.toLowerCase());
    attrs.from_self = mine;
    attrs.direction = mine ? "out" : "in";
  }
  const channel = plainLine(stemOf(file.name), stats);
  if (channel !== "") attrs.channel = Array.from(channel).slice(0, CHANNEL_MAX).join("");
  const refs = [
    ...(headerOf(headers, "references") ? angleIds(headerOf(headers, "references")!) : []),
    ...(headerOf(headers, "in-reply-to") ? angleIds(headerOf(headers, "in-reply-to")!) : [])
  ]
    .map((r) => keying.normaliseMessageId(r))
    .filter((r) => r !== "" && !/\s/u.test(r));
  const thread = refs[0] ?? (rfcValid ? normalised : undefined);
  if (thread !== undefined) {
    if (thread.length <= THREAD_MAX && !/[\p{Cc}]/u.test(thread)) attrs.thread_id = thread;
    else warn(stats, "a thread id longer than 200 characters was left out");
  }
  const subjectRaw = headerOf(headers, "subject");
  if (subjectRaw !== undefined) {
    let subject = plainLine(decode(subjectRaw), stats);
    if (Array.from(subject).length > SUBJECT_MAX) {
      subject = Array.from(subject).slice(0, SUBJECT_MAX).join("");
      warn(stats, "a subject was cut to 200 characters");
    }
    if (subject !== "") attrs.subject = subject;
  }

  if (rfcValid) options.seen.add(createHash("sha256").update(normalised).digest("base64").slice(0, 22));
  stats.emitted += 1;
  return {
    id,
    source: options.source,
    kind: "message",
    start: when!.date.toISOString(),
    ...(when!.offsetMin === null ? {} : { tzOffsetMin: when!.offsetMin }),
    ...(approximate ? { approximate: true } : {}),
    attrs,
    ...(content === undefined ? {} : { content })
  };
}

const header = (headers: Header[], name: string) => headerOf(headers, name);

/** The readable text of one MIME entity (`text[start, end)`), or null when it holds none. Attachments are counted. */
function extractEntity(
  headers: Header[],
  text: string,
  start: number,
  end: number,
  depth: number,
  walk: Walk
): Extracted | null {
  const { stats } = walk;
  if (depth > MAX_DEPTH)
    throw new ImportReadError(
      `MIME parts are nested more than ${MAX_DEPTH} deep, which no real message is. The file may be damaged.`
    );
  if (++walk.parts > MAX_PARTS)
    throw new ImportReadError(
      `the message has more than ${MAX_PARTS} MIME parts, which no real message has. The file may be damaged.`
    );
  const ct = parseParams(header(headers, "content-type") ?? "text/plain");
  const type = ct.type === "" ? "text/plain" : ct.type;
  const encoding = (header(headers, "content-transfer-encoding") ?? "7bit").trim().toLowerCase();
  if (!["7bit", "8bit", "binary", "quoted-printable", "base64"].includes(encoding)) decodeTransfer("", encoding, stats);
  const disposition = parseParams(header(headers, "content-disposition") ?? "").type;

  if (type.startsWith("multipart/")) {
    if (!["7bit", "8bit", "binary"].includes(encoding))
      throw new ImportReadError(
        `a ${type} part is encoded as ${encoding}, which the MIME standard forbids. The file may be damaged.`
      );
    const boundary = ct.params.boundary;
    if (!boundary)
      throw new ImportReadError(
        `a ${type} part has no boundary parameter, so its parts cannot be found. The file may be damaged.`
      );
    const parts = splitMultipart(text, start, end, boundary);
    const subtype = type.slice(10);
    const results: (Extracted | null)[] = [];
    if (subtype === "encrypted") {
      warn(stats, "encrypted content cannot be read; the message has no text");
      return null;
    }
    parts.forEach((range, i) => {
      if (subtype === "signed" && i > 0) {
        count(stats, "attachments ignored");
        return;
      }
      const block = parseHeaderBlock(text, range[0], stats);
      results.push(extractEntity(block.headers, text, Math.min(block.bodyStart, range[1]), range[1], depth + 1, walk));
    });
    const found = results.filter((r): r is Extracted => r !== null && r.text !== "");
    if (subtype === "alternative")
      return found.find((r) => r.kind === "plain") ?? found.find((r) => r.kind === "html") ?? null;
    if (found.length === 0) return null;
    return {
      kind: found.some((r) => r.kind === "plain") ? "plain" : "html",
      text: found.map((r) => r.text).join("\n\n")
    };
  }

  const isText = type === "text/plain" || type === "text/html";
  if (!isText || disposition === "attachment") {
    count(stats, "attachments ignored");
    return null;
  }
  const data = decodeTransfer(text.slice(start, end), encoding, stats);
  const label = ct.params.charset?.trim();
  let decoded: string;
  if (label) decoded = decodeBytes(data, label, stats);
  else {
    if (data.some((b) => b >= 0x80)) warn(stats, "8-bit text with no charset was read as UTF-8, else windows-1252");
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      decoded = new TextDecoder("windows-1252").decode(data);
    }
  }
  if (decoded.includes("\u0000"))
    throw new ImportReadError(
      "a text part holds NUL bytes, so it is binary data, not text. The file may be damaged or the message mislabelled."
    );
  return type === "text/html"
    ? {
        kind: "html",
        text: htmlToText(decoded, (note) =>
          warn(
            stats,
            note === "quote"
              ? "an HTML tag with an unbalanced quote was closed at the next >"
              : "HTML ended inside a comment or tag; the rest of it was dropped"
          )
        )
      }
    : { kind: "plain", text: decoded };
}

/** The `[start, end)` ranges of a multipart body's parts. A missing closing boundary is an error (the message is cut off). */
function splitMultipart(text: string, start: number, end: number, boundary: string): [number, number][] {
  const dash = `--${boundary}`;
  const ranges: [number, number][] = [];
  let partStart = -1;
  let closed = false;
  let pos = start;
  while (pos < end) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl < 0 || nl >= end ? end : nl;
    const next = nl < 0 || nl >= end ? end : nl + 1;
    if (text.startsWith(dash, pos)) {
      const rest = text.slice(pos + dash.length, lineEnd).trimEnd();
      if (rest === "" || rest === "--") {
        if (partStart >= 0) {
          let partEnd = pos;
          if (text[partEnd - 1] === "\n") partEnd -= 1;
          if (text[partEnd - 1] === "\r") partEnd -= 1;
          ranges.push([partStart, Math.max(partStart, partEnd)]);
        }
        if (rest === "--") {
          closed = true;
          break;
        }
        partStart = next;
      }
    }
    pos = next;
  }
  if (partStart < 0)
    throw new ImportReadError(
      `a multipart body (boundary "${boundary.slice(0, 60)}") has no boundary line at all, so it is damaged or cut off. Re-export the file or remove that message, then run the import again.`
    );
  if (!closed)
    throw new ImportReadError(
      `a multipart body (boundary "${boundary.slice(0, 60)}") has no closing boundary "--${boundary.slice(0, 60)}--", so the message is cut off. Re-export the file or remove that message, then run the import again.`
    );
  return ranges;
}
