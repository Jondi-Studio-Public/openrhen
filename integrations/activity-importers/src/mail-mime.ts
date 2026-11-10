import { ImportReadError, warn, type Stats } from "./types.js";

/**
 * Small, strict pieces of RFC 5322 / MIME the mail importer needs: header parsing and unfolding, RFC 2047 encoded
 * words, address lists, dates, transfer and charset decoding, and HTML to text. Everything works on "latin1 strings"
 * (one character per byte) until a charset is applied, so no byte is lost on the way. Anything not recognised throws
 * `ImportReadError`; the caller adds the file and message position.
 */

export type Header = [name: string, value: string];

export function hex(bytes: Uint8Array, count = 8): string {
  return Array.from(bytes.subarray(0, count), (b) => b.toString(16).padStart(2, "0")).join(" ");
}

/** A decoder for a charset label, or an error naming the label. Never guesses a replacement. */
export function decoderFor(label: string, fatal: boolean): TextDecoder {
  try {
    return new TextDecoder(label.trim().toLowerCase(), { fatal });
  } catch {
    throw new ImportReadError(
      `unknown charset "${label.slice(0, 40)}". This importer reads only the charsets the WHATWG encoding standard names (UTF-8, ISO-8859-x, windows-125x, GB18030, Big5, Shift_JIS, EUC-KR and so on). Convert that message to UTF-8 or remove it from the file, then run the import again.`
    );
  }
}

/** Bytes (as a latin1 string) to text in `charset`; invalid bytes become U+FFFD and are counted. */
export function decodeBytes(data: Buffer, charset: string, stats: Stats): string {
  const strict = decoderFor(charset, true);
  try {
    return strict.decode(data);
  } catch {
    warn(stats, "text had bytes that are not valid in its charset (replaced with U+FFFD)");
    return decoderFor(charset, false).decode(data);
  }
}

/** Header bytes: UTF-8 when valid (RFC 6532), else windows-1252, counted. */
export function headerText(latin1: string, stats: Stats): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000]/.test(latin1))
    throw new ImportReadError("a header holds a NUL byte, so it is not mail text. The file may be damaged.");
  if (!/[\u0080-ÿ]/.test(latin1)) return latin1;
  const data = Buffer.from(latin1, "latin1");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    warn(stats, "8-bit header bytes that are not UTF-8 were read as windows-1252");
    return new TextDecoder("windows-1252").decode(data);
  }
}

/** Parses a header block starting at `pos`; returns the headers (unfolded, undecoded) and where the body starts. */
export function parseHeaderBlock(text: string, pos: number, stats: Stats): { headers: Header[]; bodyStart: number } {
  const headers: Header[] = [];
  let line = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl < 0 ? text.length : nl;
    const raw = text.slice(pos, end).replace(/\r$/, "");
    pos = nl < 0 ? text.length : nl + 1;
    line += 1;
    if (raw === "") return { headers, bodyStart: pos };
    if (/^[ \t]/.test(raw)) {
      const last = headers[headers.length - 1];
      if (!last)
        throw new ImportReadError(
          `header line ${line} starts with whitespace but follows no header. The file may be damaged or not mail.`
        );
      last[1] += ` ${raw.trim()}`;
      continue;
    }
    const match = /^([!-9;-~]+)[ \t]*:(.*)$/.exec(raw);
    if (!match)
      throw new ImportReadError(
        `header line ${line} is not a "Name: value" header (it starts with bytes ${hex(Buffer.from(raw, "latin1"))}). That is not valid mail text; the file may be damaged or not an mbox. Remove or repair that part of the file and run the import again.`
      );
    headers.push([match[1]!.toLowerCase(), headerText(match[2]!.trim(), stats)]);
  }
  return { headers, bodyStart: text.length };
}

export const headerOf = (headers: Header[], name: string): string | undefined =>
  headers.find((h) => h[0] === name)?.[1];
export const headersOf = (headers: Header[], name: string): string[] =>
  headers.filter((h) => h[0] === name).map((h) => h[1]);

/** RFC 2047 encoded words; whitespace between two adjacent encoded words is dropped. A malformed word is left as it is, counted. */
export function decodeEncodedWords(value: string, stats: Stats): string {
  const word = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
  let out = "";
  let last = 0;
  let previousWasWord = false;
  for (const match of value.matchAll(word)) {
    const between = value.slice(last, match.index);
    const [whole, rawCharset, mode, payload] = match as unknown as [string, string, string, string];
    let data: Buffer;
    if (mode.toLowerCase() === "b") {
      if (/[^A-Za-z0-9+/=]/.test(payload)) {
        warn(stats, "an encoded word in a header was malformed and left as written");
        out += between + whole;
        last = match.index + whole.length;
        previousWasWord = false;
        continue;
      }
      data = Buffer.from(payload, "base64");
    } else {
      const bytes: number[] = [];
      for (let i = 0; i < payload.length; i++) {
        const c = payload[i]!;
        if (c === "_") bytes.push(0x20);
        else if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(payload.slice(i + 1, i + 3))) {
          bytes.push(parseInt(payload.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(c.charCodeAt(0) & 0xff);
      }
      data = Buffer.from(bytes);
    }
    const charset = rawCharset.split("*")[0]!;
    out += (previousWasWord && /^\s*$/.test(between) ? "" : between) + decodeBytes(data, charset, stats);
    last = match.index + whole.length;
    previousWasWord = true;
  }
  return out + value.slice(last);
}

const HIDDEN = /[​⁠﻿‪-‮⁦-⁩\u{E0000}-\u{E007F}]/gu;
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/** One plain line for an attr: hidden and reordering characters removed, controls and runs of space one space. */
export function plainLine(text: string, stats: Stats): string {
  const cleaned = text.replace(HIDDEN, "");
  if (cleaned !== text) warn(stats, "hidden or text-reordering characters were removed from a header");
  return cleaned.replace(CONTROL, " ").replace(/\s+/gu, " ").trim();
}

export interface Mailbox {
  name: string;
  address: string;
}

/** Splits an address list on top-level commas; quotes, comments, angle brackets and groups are honoured. */
export function parseAddressList(value: string): Mailbox[] {
  const out: Mailbox[] = [];
  let current = "";
  let quote = false;
  let angle = false;
  let comment = 0;
  const flush = () => {
    const segment = current.trim();
    current = "";
    if (segment === "") return;
    out.push(mailboxOf(segment));
  };
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote) {
      current += c;
      if (c === "\\" && i + 1 < value.length) current += value[++i]!;
      else if (c === '"') quote = false;
    } else if (comment > 0) {
      current += c;
      if (c === "\\" && i + 1 < value.length) current += value[++i]!;
      else if (c === "(") comment += 1;
      else if (c === ")") comment -= 1;
    } else if (c === '"') {
      quote = true;
      current += c;
    } else if (c === "(") {
      comment = 1;
      current += c;
    } else if (c === "<") {
      angle = true;
      current += c;
    } else if (c === ">") {
      angle = false;
      current += c;
    } else if (!angle && (c === "," || c === ";")) flush();
    else if (!angle && c === ":") current = "";
    else current += c;
  }
  flush();
  return out;
}

function unquote(text: string): string {
  const t = text.trim();
  return t.startsWith('"') && t.endsWith('"') && t.length >= 2 ? t.slice(1, -1).replace(/\\(.)/g, "$1") : t;
}

function mailboxOf(segment: string): Mailbox {
  const noComments = segment.replace(/\((?:\\.|[^()\\])*\)/g, " ");
  const angled = /<([^<>]*)>/.exec(noComments);
  if (angled) {
    const address = angled[1]!.replace(/^[^:]*:(?=.*@)/, "").trim();
    const name = unquote(noComments.slice(0, angled.index) + noComments.slice(angled.index + angled[0].length));
    return { name: name.trim(), address: address.includes("@") ? address.toLowerCase() : "" };
  }
  const token = noComments.trim();
  if (token.includes("@") && !/\s/.test(unquote(token))) return { name: "", address: unquote(token).toLowerCase() };
  const bare = /([^\s<>"]+@[^\s<>"]+)/.exec(noComments);
  if (bare) return { name: unquote(noComments.replace(bare[1]!, "")), address: bare[1]!.toLowerCase() };
  return { name: unquote(noComments), address: "" };
}

/** The ids inside `<...>` of a Message-ID, References or In-Reply-To value, in order; a lone bare id when there are no brackets. */
export function angleIds(value: string): string[] {
  const ids = Array.from(value.replace(/\((?:\\.|[^()\\])*\)/g, " ").matchAll(/<([^<>]*)>/g), (m) => m[1]!.trim());
  if (ids.length > 0) return ids;
  const bare = value.replace(/\((?:\\.|[^()\\])*\)/g, " ").trim();
  return bare !== "" && !/\s/.test(bare) ? [bare] : [];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ZONES: Record<string, number> = {
  ut: 0,
  utc: 0,
  gmt: 0,
  z: 0,
  est: -300,
  edt: -240,
  cst: -360,
  cdt: -300,
  mst: -420,
  mdt: -360,
  pst: -480,
  pdt: -420
};

export interface ParsedDate {
  date: Date;
  /** Minutes east of UTC when the header names a non-UTC zone; null for UTC or an unknown zone. */
  offsetMin: number | null;
  /** The header named no zone, or a name this importer does not know; the time was read as UTC. */
  zoneUnknown?: boolean;
}

/** The most the contract allows for `tzOffsetMin`; a Date header with a zone past it is unreadable, not clamped. */
export const MAX_ZONE_MINUTES = 840;

function build(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  offsetMin: number
): ParsedDate | null {
  if (mo < 0 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const check = new Date(Date.UTC(y, mo, d));
  if (check.getUTCMonth() !== mo || check.getUTCDate() !== d) return null;
  const date = new Date(Date.UTC(y, mo, d, h, mi, Math.min(s, 59)) - offsetMin * 60_000);
  return Number.isNaN(date.getTime()) ? null : { date, offsetMin: offsetMin === 0 ? null : offsetMin };
}

/** An RFC 5322 date (with the obsolete zone names and two-digit years), or null. */
export function parseMailDate(value: string): ParsedDate | null {
  const text = value.replace(/\((?:\\.|[^()\\])*\)/g, " ").trim();
  const m =
    /^(?:[A-Za-z]{3,9}\s*,?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,5})?$/.exec(
      text
    );
  if (!m) return null;
  let year = Number(m[3]);
  if (m[3]!.length === 2) year += year >= 50 ? 1900 : 2000;
  else if (m[3]!.length === 3) year += 1900;
  const zone = m[7];
  let offset = 0;
  let zoneUnknown = false;
  if (zone && /^[+-]\d{4}$/.test(zone)) {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(3, 5));
    if (minutes > 59 || hours > 23) return null;
    offset = (zone[0] === "-" ? -1 : 1) * (hours * 60 + minutes);
    if (Math.abs(offset) > MAX_ZONE_MINUTES) return null;
  } else if (zone && ZONES[zone.toLowerCase()] !== undefined) offset = ZONES[zone.toLowerCase()]!;
  else zoneUnknown = true;
  const parsed = build(
    year,
    MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()),
    Number(m[1]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
    offset
  );
  return parsed && zoneUnknown ? { ...parsed, zoneUnknown } : parsed;
}

/** The date of an mbox `From ` line: `Mon Jan  5 10:00:00 2026`, with an optional numeric zone. */
export function parseEnvelopeDate(value: string): ParsedDate | null {
  const m =
    /([A-Za-z]{3})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(?:([+-]\d{4})\s+)?(?:[A-Z]{3,4}\s+)?(\d{4})/.exec(
      value
    );
  if (!m) return null;
  const zone = m[7];
  const offset = zone ? (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5))) : 0;
  const parsed = build(
    Number(m[8]),
    MONTHS.indexOf(m[2]!.toLowerCase()),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    offset
  );
  return parsed ? { date: parsed.date, offsetMin: null } : null;
}

export interface ContentType {
  type: string;
  params: Record<string, string>;
}

export function parseParams(value: string): ContentType {
  const parts: string[] = [];
  let current = "";
  let quote = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote) {
      current += c;
      if (c === "\\" && i + 1 < value.length) current += value[++i]!;
      else if (c === '"') quote = false;
    } else if (c === '"') {
      quote = true;
      current += c;
    } else if (c === ";") {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    if (name !== "" && !(name in params)) params[name] = unquote(part.slice(eq + 1));
  }
  return { type: parts[0]!.trim().toLowerCase(), params };
}

/** Undoes a Content-Transfer-Encoding. The input is a latin1 string; the output is the decoded bytes. */
export function decodeTransfer(body: string, encoding: string, stats: Stats): Buffer {
  switch (encoding) {
    case "7bit":
    case "8bit":
    case "binary":
      return Buffer.from(body, "latin1");
    case "base64": {
      const clean = body.replace(/\s+/g, "");
      if (/[^A-Za-z0-9+/=]/.test(clean))
        throw new ImportReadError(
          "a base64 part holds characters outside the base64 alphabet, so it is damaged. Repair or remove that message and run the import again."
        );
      return Buffer.from(clean, "base64");
    }
    case "quoted-printable": {
      if (/=(?![0-9A-Fa-f]{2})(?![ \t]*\r?\n)(?!$)/.test(body))
        warn(stats, "quoted-printable text had an invalid escape (left as written)");
      return Buffer.from(
        body
          .replace(/=[ \t]*\r?\n/g, "")
          .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
        "latin1"
      );
    }
    default:
      throw new ImportReadError(
        `unknown Content-Transfer-Encoding "${encoding.slice(0, 40)}". This importer reads 7bit, 8bit, binary, quoted-printable and base64. Convert that message to one of them or remove it from the file, then run the import again.`
      );
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  trade: "™",
  deg: "°",
  times: "×",
  laquo: "«",
  raquo: "»"
};

function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return code === 0xa0 ? " " : String.fromCodePoint(code);
    }
    return ENTITIES[body] ?? ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const BLOCK = new Set([
  "p",
  "div",
  "tr",
  "li",
  "ul",
  "ol",
  "table",
  "blockquote",
  "pre",
  "hr",
  "br",
  "section",
  "article",
  "header",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6"
]);

/** A tag longer than this is taken to have a stray quote (room for an inline image in a src). */
const MAX_TAG_CHARS = 262_144;

export type HtmlNote = "quote" | "unterminated";

/** HTML to plain text with one linear scan: tags dropped, script, style and head content skipped, blocks as line breaks, entities decoded. */
export function htmlToText(html: string, note: (reason: HtmlNote) => void = () => {}): string {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      if (close < 0) {
        note("unterminated");
        break;
      }
      i = close + 3;
      continue;
    }
    const tag = /^<(\/?)([A-Za-z][A-Za-z0-9]*)/.exec(html.slice(lt, lt + 40));
    if (!tag) {
      if (/^<[!?]/.test(html.slice(lt, lt + 2))) {
        const close = html.indexOf(">", lt);
        if (close < 0) {
          note("unterminated");
          break;
        }
        i = close + 1;
      } else {
        out += "<";
        i = lt + 1;
      }
      continue;
    }
    let end = lt + tag[0].length;
    let quote = "";
    let stray = false;
    while (end < html.length) {
      const c = html[end]!;
      // Inside a quote "<" is legal (title="a<b", a wrapped style, a data: image), so quotes alone never make a tag
      // stray. Outside one, "<" never belongs in a tag; and a tag longer than the bound is not a tag.
      if (end - lt > MAX_TAG_CHARS || (!quote && c === "<")) {
        stray = true;
        break;
      }
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      end += 1;
    }
    if (stray || end >= html.length) {
      // A stray quote hid the closing ">": close the tag at the first ">" instead of dropping the rest of the message.
      const plain = html.indexOf(">", lt);
      if (plain < 0) {
        note("unterminated");
        break;
      }
      end = plain;
      note("quote");
    }
    const name = tag[2]!.toLowerCase();
    i = end + 1;
    if (tag[1] === "") {
      if (name === "script" || name === "style" || name === "head") {
        const close = lower.indexOf(`</${name}`, i);
        if (close < 0) {
          if (name === "head") continue;
          note("unterminated");
          break;
        }
        const closeEnd = html.indexOf(">", close);
        i = closeEnd < 0 ? html.length : closeEnd + 1;
        continue;
      }
    }
    if (BLOCK.has(name)) out += "\n";
    else if (name === "td" || name === "th") out += tag[1] === "/" ? " " : "";
  }
  return decodeEntities(out)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]*\r?\n[ \t\f\v]*/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
