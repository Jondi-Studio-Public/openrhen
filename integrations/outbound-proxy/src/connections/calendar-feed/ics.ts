// Content-line layer of the calendar feed parser: unfold on bytes, decode, split into properties, collect VEVENTs.
// Tolerant on purpose: CRLF, LF or lone CR line ends, a BOM, folds that split a multibyte character, bad lines skipped.

export interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface RawEvent {
  props: Prop[];
}

export interface IcsDocument {
  events: RawEvent[];
  /** TZID to X-LIC-LOCATION from VTIMEZONE blocks, a fallback for names that are not IANA or Windows. */
  zoneLocations: Map<string, string>;
  sawBegin: boolean;
  sawEnd: boolean;
  /** Count of VEVENT blocks seen, including ones past the cap. */
  veventCount: number;
  veventCapHit: boolean;
  badLines: number;
  /** Calendar-level X-WR-TIMEZONE (Google), used for floating times. */
  calendarZone: string | null;
}

/** A logical line longer than this is cut: a 5 MB single line would double in memory as UTF-16. */
export const MAX_LINE_BYTES = 65_536;

/** Unfold on bytes (a fold may split a UTF-8 sequence), then decode. Returns logical lines. */
export function unfoldLines(body: Uint8Array): string[] {
  const out: Uint8Array[] = [];
  let start = 0;
  const chunks: Uint8Array[] = [];
  const push = () => {
    if (chunks.length === 0) return;
    let total = 0;
    for (const c of chunks) total += c.length;
    const joined = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      joined.set(c, at);
      at += c.length;
    }
    out.push(joined);
    chunks.length = 0;
  };
  let i = start;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) i = start = 3;
  const n = body.length;
  while (i <= n) {
    // find end of the physical line
    let end = i;
    while (end < n && body[end] !== 0x0a && body[end] !== 0x0d) end++;
    const line = body.subarray(i, end);
    // step over the terminator: CRLF, LF or CR
    let next = end;
    if (next < n) {
      if (body[next] === 0x0d && body[next + 1] === 0x0a) next += 2;
      else next += 1;
    } else next = n + 1;
    const folded = chunks.length > 0 && line.length > 0 && (line[0] === 0x20 || line[0] === 0x09);
    if (folded) chunks.push(line.subarray(1));
    else {
      push();
      if (line.length > 0) chunks.push(line);
    }
    i = next;
  }
  push();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return out.map((bytes) => decoder.decode(bytes.length > MAX_LINE_BYTES ? bytes.subarray(0, MAX_LINE_BYTES) : bytes));
}

/** Split `NAME;P=v;P2="q:uoted":value` honouring quotes. Returns null for a line with no colon or no name. */
export function parseProp(line: string): Prop | null {
  let i = 0;
  let inQuote = false;
  let colon = -1;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts: string[] = [];
  let buf = "";
  let quoted = false;
  for (const ch of head) {
    if (ch === '"') {
      quoted = !quoted;
      buf += ch;
    } else if (ch === ";" && !quoted) {
      parts.push(buf);
      buf = "";
    } else buf += ch;
  }
  parts.push(buf);
  const name = (parts[0] ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) return null;
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    // A parameter may repeat or carry a list; the first value is the one every property here uses.
    if (!(key in params)) params[key] = val;
  }
  return { name, params, value };
}

export function parseIcs(body: Uint8Array, maxEvents: number): IcsDocument {
  const doc: IcsDocument = {
    events: [],
    zoneLocations: new Map(),
    sawBegin: false,
    sawEnd: false,
    veventCount: 0,
    veventCapHit: false,
    badLines: 0,
    calendarZone: null
  };
  let inCalendar = false;
  let eventProps: Prop[] | null = null;
  let eventDepth = 0; // nested components (VALARM) inside a VEVENT
  let zoneId: string | null = null;
  let zoneLocation: string | null = null;
  let inZone = false;
  for (const line of unfoldLines(body)) {
    const prop = parseProp(line);
    if (!prop) {
      if (line.trim()) doc.badLines++;
      continue;
    }
    const { name, value } = prop;
    const upper = value.trim().toUpperCase();
    if (name === "BEGIN") {
      if (eventProps && upper === "VEVENT") {
        // A VEVENT opened before the last one closed: the earlier one ended.
        doc.events.push({ props: eventProps });
        eventProps = null;
        eventDepth = 0;
      }
      if (upper === "VCALENDAR") {
        inCalendar = true;
        doc.sawBegin = true;
      } else if (eventProps) eventDepth++;
      else if (upper === "VEVENT") {
        doc.veventCount++;
        if (doc.veventCount > maxEvents) {
          doc.veventCapHit = true;
          eventProps = null;
          eventDepth = -1;
        } else {
          eventProps = [];
          eventDepth = 0;
        }
      } else if (upper === "VTIMEZONE") {
        inZone = true;
        zoneId = null;
        zoneLocation = null;
      }
      continue;
    }
    if (name === "END") {
      if (upper === "VCALENDAR") {
        doc.sawEnd = true;
        inCalendar = false;
      } else if (eventDepth === -1 && upper === "VEVENT") eventDepth = 0;
      else if (eventProps && eventDepth > 0) eventDepth--;
      else if (eventProps && upper === "VEVENT") {
        doc.events.push({ props: eventProps });
        eventProps = null;
      } else if (inZone && upper === "VTIMEZONE") {
        if (zoneId && zoneLocation) doc.zoneLocations.set(zoneId, zoneLocation);
        inZone = false;
      }
      continue;
    }
    if (eventProps && eventDepth === 0) eventProps.push(prop);
    else if (!eventProps && !inZone && inCalendar && name === "X-WR-TIMEZONE" && doc.calendarZone === null)
      doc.calendarZone = value.trim();
    else if (inZone) {
      if (name === "TZID" && zoneId === null) zoneId = value.trim();
      else if (name === "X-LIC-LOCATION") zoneLocation = value.trim();
    }
  }
  return doc;
}

// Control (Cc) and format (Cf: bidi marks and overrides, zero-width, BOM) characters.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

/** RFC 5545 TEXT unescape: \n \N newline, \, \; \\ literal. */
export function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_m, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

/** Strip control and bidi characters (newlines and tabs become spaces), collapse space runs, cut to `max`. */
export function cleanText(value: string, max: number, keepNewlines = false): string {
  let text = value.replace(/\r\n?/g, "\n");
  text = keepNewlines ? text.replace(/[\t]/g, " ") : text.replace(/[\n\t]/g, " ");
  text = text.replace(CONTROL_OR_FORMAT, (ch) => (keepNewlines && ch === "\n" ? ch : ""));
  if (!keepNewlines) text = text.replace(/ {2,}/g, " ");
  text = text.trim();
  return [...text].slice(0, max).join("");
}
