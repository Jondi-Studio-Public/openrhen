// The calendar feed parser proper: bytes in, bounded list of occurrences in a window out. Pure (no I/O), so it can run
// in a worker. Shape and limits follow design v4 (d), (e), (g).
import { createHash } from "node:crypto";
import { CALENDAR_FEED_SERIES_BATCH_MAX_CHARS } from "@openrhen/contracts/integrations/calendar-feed-limits";
import type { CalendarFeedSeries } from "@openrhen/contracts/integrations/calendar-feed";
import { cleanText, parseIcs, unescapeText, type Prop, type RawEvent } from "./ics.js";
import { BudgetExceeded, dayFields, dayNumber, expandDays, parseRule, validDate, type Rule } from "./rrule.js";
import { buildSeries, type SeriesOverride } from "./series.js";
import { instantToLocal, isIanaZone, localToInstant, resolveZone, type LocalDateTime } from "./zones.js";

export const LIMITS = {
  maxVevents: 5000,
  maxOccurrences: 1500,
  maxPerSeries: 300,
  parseBudgetMs: 4500
} as const;

export interface ParseRequest {
  body: Uint8Array;
  /** ISO instants. Events overlapping [windowStart, windowEnd) are returned. */
  now: string;
  windowStart: string;
  windowEnd: string;
  /** IANA zone for floating times without X-WR-TIMEZONE, and for the midnight of all-day events. */
  ownerTimeZone: string;
}

export interface FeedEvent {
  /** `<encoded UID>` or `<encoded UID>#YYYYMMDD` for a recurrence instance. Never longer than 90 characters. */
  id: string;
  uid: string;
  /** Original occurrence date (YYYYMMDD, series zone) for a recurrence instance, else null. */
  recurrenceDate: string | null;
  title: string;
  location: string;
  description: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  /** All-day only: local dates, end exclusive. */
  startDate: string | null;
  endDate: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  recurring: boolean;
  /** Set only on the first event of a representable repeating UID in the read: the rule descriptor (series.ts). */
  series?: CalendarFeedSeries;
}

export interface SkippedEvent {
  /** The encoded UID, matching `FeedEvent.id` as `id === idPrefix || id.startsWith(idPrefix + "#")`. Null when the event has none. */
  idPrefix: string | null;
  reason: string;
}

export interface ParseResult {
  events: FeedEvent[];
  skipped: SkippedEvent[];
  /** Repeating masters that parsed but cannot be followed as one rule, with a fixed reason (plan path D). They are not in `skipped`. */
  unrepresentableSeries: SkippedEvent[];
  veventCount: number;
  sawBegin: boolean;
  sawEnd: boolean;
  veventCapHit: boolean;
  occurrenceCapHit: boolean;
  timeBudgetHit: boolean;
  /** Parser-only completeness. The transport layer and the linked-id check are ANDed in by the caller. */
  parseComplete: boolean;
}

/**
 * Encode a UID into the id stem. Only `%` (the escape itself), `#` (the instance separator) and `!` (the hash marker) are
 * percent-encoded, so ordinary UIDs such as `abc@google.com` stay readable. Over 80 characters it becomes `!` plus 32 hex
 * of the SHA-256 of the UID; a literal `!` is always escaped, so a hashed stem can never equal an encoded one.
 *
 * A stem never starts with `series:`, `delete:` or `occ:`: the portal names a repeating entry's link `series:<stem>` and a declined
 * removal `delete:<id>` in the same tables as the events' own ids, so a UID that began that way would share a name with
 * them. The first letter of such a UID is percent-encoded (`series:x` becomes `%73eries:x`), which no other UID produces.
 */
export function encodeUid(uid: string): string {
  const hex = (c: string) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
  let encoded = uid.replace(/[%#!]/g, hex);
  if (/^(series|delete|occ):/.test(encoded)) encoded = hex(encoded[0]!) + encoded.slice(1);
  if (encoded.length <= 80) return encoded;
  return `!${createHash("sha256").update(uid).digest("hex").slice(0, 32)}`;
}

type Moment =
  | { kind: "date"; y: number; m: number; d: number }
  | { kind: "utc" | "floating" | "zoned"; local: LocalDateTime; zone: string | null };

const DT = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i;

class Skip extends Error {}

function get(props: Prop[], name: string): Prop | undefined {
  return props.find((p) => p.name === name);
}

function readMoment(prop: Prop, calendarZone: string | null, locations: ReadonlyMap<string, string>): Moment {
  const match = DT.exec(prop.value.trim());
  if (!match) throw new Skip(`unreadable ${prop.name.toLowerCase()}`);
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!validDate(y, m, d)) throw new Skip(`invalid ${prop.name.toLowerCase()} date`);
  const isDate = match[4] === undefined || prop.params.VALUE?.toUpperCase() === "DATE";
  if (isDate) return { kind: "date", y, m, d };
  const [h, mi, s] = [Number(match[4]), Number(match[5]), Number(match[6] ?? 0)];
  if (h > 23 || mi > 59 || s > 60) throw new Skip(`invalid ${prop.name.toLowerCase()} time`);
  const local: LocalDateTime = { y, m, d, h, mi, s: Math.min(s, 59) };
  if (match[7]) return { kind: "utc", local, zone: "UTC" };
  const tzid = prop.params.TZID;
  if (tzid !== undefined) {
    const zone = resolveZone(tzid, locations);
    if (!zone) throw new Skip("unknown zone");
    return { kind: "zoned", local, zone };
  }
  return { kind: "floating", local, zone: calendarZone };
}

function readDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim());
  if (!m || value.trim().replace(/^[+-]?P/i, "") === "") return null;
  const n = (i: number) => Number(m[i] ?? 0);
  const ms = (((n(2) * 7 + n(3)) * 24 + n(4)) * 60 + n(5)) * 60_000 + n(6) * 1000;
  return m[1] === "-" ? -ms : ms;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const ymd = (y: number, m: number, d: number) => `${pad(y, 4)}${pad(m)}${pad(d)}`;
const isoDate = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

interface Model {
  uid: string;
  stem: string;
  props: Prop[];
  seq: number;
  modified: string;
  title: string;
  location: string;
  description: string;
  status: "confirmed" | "tentative" | "cancelled";
  start: Moment;
  startZone: string; // series zone; owner zone for all-day
  allDay: boolean;
  /** Timed: duration in ms. All-day: whole days. */
  length: number;
  rule: Rule | null;
  exdates: Set<string>; // local YYYYMMDD in the series zone
  recurrenceKey: string | null; // YYYYMMDD in the series zone
  thisAndFuture: boolean;
  recurrenceProp: Prop | undefined;
}

function momentToUtc(m: Moment, ownerZone: string): number {
  if (m.kind === "date") return localToInstant(ownerZone, { y: m.y, m: m.m, d: m.d, h: 0, mi: 0, s: 0 });
  if (m.kind === "utc") return localToInstant("UTC", m.local);
  return localToInstant(m.zone ?? ownerZone, m.local);
}

/** The YYYYMMDD of a moment seen in `zone`. */
function dateKeyIn(m: Moment, zone: string, ownerZone: string): string {
  if (m.kind === "date") return ymd(m.y, m.m, m.d);
  if (m.kind === "floating" || m.kind === "zoned") {
    if ((m.zone ?? ownerZone) === zone) return ymd(m.local.y, m.local.m, m.local.d);
  }
  const l = instantToLocal(zone, momentToUtc(m, ownerZone));
  return ymd(l.y, l.m, l.d);
}

function buildModel(
  raw: RawEvent,
  calendarZone: string | null,
  ownerZone: string,
  locations: ReadonlyMap<string, string>
): Model {
  const props = raw.props;
  const uidProp = get(props, "UID");
  const uid = (uidProp?.value ?? "").trim();
  if (!uid) throw new Skip("no uid");
  const stem = encodeUid(uid);
  try {
    const startProp = get(props, "DTSTART");
    if (!startProp) throw new Skip("no start");
    const floatingZone = calendarZone && isIanaZone(calendarZone) ? calendarZone : ownerZone;
    const start = readMoment(startProp, floatingZone, locations);
    const allDay = start.kind === "date";
    const startZone = start.kind === "date" ? ownerZone : (start.zone ?? ownerZone);
    const startUtc = momentToUtc(start, ownerZone);

    let length: number;
    const endProp = get(props, "DTEND") ?? get(props, "DUE");
    const durProp = get(props, "DURATION");
    if (endProp) {
      const end = readMoment(endProp, floatingZone, locations);
      if (allDay) {
        if (end.kind !== "date") throw new Skip("start and end differ in kind");
        const days =
          dayNumber(end.y, end.m, end.d) -
          dayNumber((start as { y: number }).y, (start as { m: number }).m, (start as { d: number }).d);
        length = days >= 1 ? days : 1; // some exports write DTEND equal to DTSTART for a one-day event
      } else {
        if (end.kind === "date") throw new Skip("start and end differ in kind");
        length = momentToUtc(end, ownerZone) - startUtc;
        if (length <= 0) throw new Skip("no end");
      }
    } else if (durProp) {
      const ms = readDuration(durProp.value);
      if (ms === null) throw new Skip("unreadable duration");
      if (allDay) length = Math.max(1, Math.ceil(ms / 86_400_000));
      else {
        if (ms <= 0) throw new Skip("no end");
        length = ms;
      }
    } else if (allDay) length = 1;
    else throw new Skip("no end");

    const rruleProp = get(props, "RRULE");
    let rule: Rule | null = null;
    if (rruleProp) {
      const parsed = parseRule(rruleProp.value);
      if ("reason" in parsed) throw new Skip(parsed.reason);
      rule = parsed.rule;
    }
    if (get(props, "RDATE")) throw new Skip("unsupported recurrence dates");
    if (get(props, "EXRULE")) throw new Skip("unsupported exception rule");

    const exdates = new Set<string>();
    for (const p of props) {
      if (p.name !== "EXDATE") continue;
      for (const piece of p.value.split(",")) {
        if (!piece.trim()) continue;
        let m: Moment;
        try {
          m = readMoment({ ...p, value: piece }, floatingZone, locations);
        } catch {
          throw new Skip("unreadable exception date");
        }
        exdates.add(dateKeyIn(m, startZone, ownerZone));
      }
    }

    const recurrenceProp = get(props, "RECURRENCE-ID");
    let recurrenceKey: string | null = null;
    if (recurrenceProp) {
      let rm: Moment;
      try {
        rm = readMoment(recurrenceProp, floatingZone, locations);
      } catch (error) {
        throw error instanceof Skip && error.message === "unknown zone" ? error : new Skip("unreadable recurrence id");
      }
      recurrenceKey = dateKeyIn(rm, startZone, ownerZone);
    }

    const statusRaw = (get(props, "STATUS")?.value ?? "").trim().toUpperCase();
    const status = statusRaw === "CANCELLED" ? "cancelled" : statusRaw === "TENTATIVE" ? "tentative" : "confirmed";
    const text = (name: string, max: number, nl = false) =>
      cleanText(unescapeText(get(props, name)?.value ?? ""), max, nl);
    return {
      uid,
      stem,
      props,
      seq: Number.parseInt(get(props, "SEQUENCE")?.value ?? "0", 10) || 0,
      modified: (get(props, "LAST-MODIFIED")?.value ?? get(props, "DTSTAMP")?.value ?? "").trim(),
      title: text("SUMMARY", 300) || "(no title)",
      location: text("LOCATION", 200),
      description: text("DESCRIPTION", 500, true),
      status,
      start,
      startZone,
      allDay,
      length,
      rule,
      exdates,
      recurrenceKey,
      thisAndFuture: recurrenceProp?.params.RANGE?.toUpperCase() === "THISANDFUTURE",
      recurrenceProp
    };
  } catch (error) {
    if (error instanceof Skip) throw Object.assign(new Skip(error.message), { stem });
    throw error;
  }
}

function emit(
  model: Model,
  id: string,
  recurrenceDate: string | null,
  startDay: { y: number; m: number; d: number } | null,
  startUtc: number,
  ownerZone: string,
  recurring: boolean
): FeedEvent {
  if (model.allDay) {
    const s = startDay!;
    const e = dayFields(dayNumber(s.y, s.m, s.d) + model.length);
    const from = localToInstant(ownerZone, { ...s, h: 0, mi: 0, s: 0 });
    const to = localToInstant(ownerZone, { ...e, h: 0, mi: 0, s: 0 });
    return {
      id,
      uid: model.uid,
      recurrenceDate,
      title: model.title,
      location: model.location,
      description: model.description,
      startsAt: new Date(from).toISOString(),
      endsAt: new Date(to).toISOString(),
      allDay: true,
      startDate: isoDate(s.y, s.m, s.d),
      endDate: isoDate(e.y, e.m, e.d),
      status: model.status,
      recurring
    };
  }
  return {
    id,
    uid: model.uid,
    recurrenceDate,
    title: model.title,
    location: model.location,
    description: model.description,
    startsAt: new Date(startUtc).toISOString(),
    endsAt: new Date(startUtc + model.length).toISOString(),
    allDay: false,
    startDate: null,
    endDate: null,
    status: model.status,
    recurring
  };
}

function better(a: Model, b: Model): boolean {
  // true when `a` should replace `b`: higher SEQUENCE, then later LAST-MODIFIED/DTSTAMP, then the later one in the file.
  if (a.seq !== b.seq) return a.seq > b.seq;
  return a.modified >= b.modified;
}

export function parseFeed(request: ParseRequest, nowMs: () => number = Date.now): ParseResult {
  const started = nowMs();
  const deadline = started + LIMITS.parseBudgetMs;
  const ctx = {
    checkBudget() {
      if (nowMs() > deadline) throw new BudgetExceeded();
    }
  };
  const ownerZone = isIanaZone(request.ownerTimeZone) ? request.ownerTimeZone : "UTC";
  const windowStart = Date.parse(request.windowStart);
  const windowEnd = Date.parse(request.windowEnd);
  const now = Date.parse(request.now);
  if (!(windowEnd > windowStart) || Number.isNaN(now)) throw new RangeError("bad window");

  const doc = parseIcs(request.body, LIMITS.maxVevents);
  const skipped: SkippedEvent[] = [];
  const unrepresentableSeries: SkippedEvent[] = [];
  const builtSeries = new Map<string, CalendarFeedSeries>(); // by UID
  const thisAndFutureUids = new Set<string>();
  const masters = new Map<string, Model>();
  const overrides = new Map<string, Model>(); // `${uid}\u0000${key}`
  let timeBudgetHit = false;

  const overlaps = (s: number, e: number) => s < windowEnd && e > windowStart;

  for (const raw of doc.events) {
    if (nowMs() > deadline) {
      timeBudgetHit = true;
      break;
    }
    let model: Model;
    try {
      model = buildModel(raw, doc.calendarZone, ownerZone, doc.zoneLocations);
    } catch (error) {
      if (error instanceof Skip)
        skipped.push({ idPrefix: (error as { stem?: string }).stem ?? null, reason: error.message });
      else skipped.push({ idPrefix: null, reason: "unreadable event" });
      continue;
    }
    if (model.thisAndFuture) {
      thisAndFutureUids.add(model.uid);
      skipped.push({ idPrefix: model.stem, reason: "unsupported this-and-future change" });
      continue;
    }
    if (model.recurrenceKey) {
      const k = `${model.uid}\u0000${model.recurrenceKey}`;
      const prev = overrides.get(k);
      if (!prev || better(model, prev)) overrides.set(k, model);
    } else {
      const prev = masters.get(model.uid);
      if (!prev || better(model, prev)) masters.set(model.uid, model);
    }
  }

  const out: FeedEvent[] = [];
  let occurrenceCapHit = false;
  const keepNearest = (list: FeedEvent[], cap: number): FeedEvent[] => {
    if (list.length <= cap) return list;
    occurrenceCapHit = true;
    return [...list]
      .sort((a, b) => Math.abs(Date.parse(a.startsAt) - now) - Math.abs(Date.parse(b.startsAt) - now))
      .slice(0, cap);
  };

  for (const model of masters.values()) {
    if (nowMs() > deadline) {
      timeBudgetHit = true;
      break;
    }
    const mine: FeedEvent[] = [];
    try {
      if (!model.rule) {
        const s = model.start;
        const startUtc = momentToUtc(s, ownerZone);
        const sd = s.kind === "date" ? { y: s.y, m: s.m, d: s.d } : null;
        const ev = emit(model, model.stem, null, sd, startUtc, ownerZone, false);
        if (overlaps(Date.parse(ev.startsAt), Date.parse(ev.endsAt))) mine.push(ev);
      } else {
        const s = model.start;
        const zone = model.startZone;
        const local = s.kind === "date" ? { y: s.y, m: s.m, d: s.d, h: 0, mi: 0, s: 0 } : s.local;
        const startDay = dayNumber(local.y, local.m, local.d);
        const spanDays = model.allDay ? model.length : Math.ceil(model.length / 86_400_000) + 1;
        const fromDay = Math.floor(windowStart / 86_400_000) - spanDays - 2;
        let toDay = Math.floor(windowEnd / 86_400_000) + 2;
        const until = model.rule.until;
        // An UNTIL day bounds the walk; the exact instant is checked per occurrence below.
        if (until) toDay = Math.min(toDay, dayNumber(until.y, until.m, until.d) + 1);
        const expansion = expandDays(model.rule, startDay, fromDay, toDay, ctx);
        if (expansion.capped) {
          skipped.push({ idPrefix: model.stem, reason: "recurrence too long to expand" });
          continue;
        }
        const untilMs = until ? untilInstant(until, model, ownerZone) : null;
        let seen = 0;
        for (const day of expansion.days) {
          if (++seen % 256 === 0) ctx.checkBudget();
          const f = dayFields(day);
          const key = ymd(f.y, f.m, f.d);
          const startUtc = model.allDay ? 0 : localToInstant(zone, { ...f, h: local.h, mi: local.mi, s: local.s });
          if (model.allDay) {
            if (until && day > untilDay(until, model)) continue;
          } else if (untilMs !== null && startUtc > untilMs) continue;
          if (model.exdates.has(key)) continue;
          const override = overrides.get(`${model.uid}\u0000${key}`);
          if (override) {
            continue; // the override is emitted below at its own time
          }
          const ev = emit(model, `${model.stem}#${key}`, key, f, startUtc, ownerZone, true);
          if (overlaps(Date.parse(ev.startsAt), Date.parse(ev.endsAt))) mine.push(ev);
        }
        // The same master as one rule for the portal, or the reason it cannot be (the instances above are emitted either way).
        const own: SeriesOverride[] = [];
        for (const [k, o] of overrides) {
          if (!k.startsWith(`${model.uid}\u0000`)) continue;
          own.push({
            key: k.slice(k.indexOf("\u0000") + 1),
            status: o.status,
            title: o.title,
            location: o.location,
            allDay: o.allDay,
            startUtc: momentToUtc(o.start, ownerZone),
            length: o.length
          });
        }
        const outcome = buildSeries(
          {
            uid: model.uid,
            stem: model.stem,
            title: model.title,
            location: model.location,
            status: model.status,
            startKind: s.kind,
            zone,
            startLocal: local,
            length: model.length,
            rule: model.rule,
            exdates: model.exdates,
            overrides: own,
            hasThisAndFuture: thisAndFutureUids.has(model.uid)
          },
          now,
          ctx
        );
        if ("series" in outcome) builtSeries.set(model.uid, outcome.series);
        else unrepresentableSeries.push({ idPrefix: model.stem, reason: outcome.reason });
      }
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        timeBudgetHit = true;
        break;
      }
      skipped.push({ idPrefix: model.stem, reason: "unreadable event" });
      continue;
    }
    out.push(...keepNearest(mine, LIMITS.maxPerSeries));
  }

  // Overrides: each at its own final start, whether or not its master is in the feed or its original date is in the window.
  for (const [k, model] of overrides) {
    const s = model.start;
    const startUtc = momentToUtc(s, ownerZone);
    const sd = s.kind === "date" ? { y: s.y, m: s.m, d: s.d } : null;
    const key = k.slice(k.indexOf("\u0000") + 1);
    const ev = emit(model, `${model.stem}#${key}`, key, sd, startUtc, ownerZone, true);
    if (overlaps(Date.parse(ev.startsAt), Date.parse(ev.endsAt))) out.push(ev);
  }

  const events = keepNearest(out, LIMITS.maxOccurrences);
  events.sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : a.id < b.id ? -1 : 1));

  // Each descriptor rides on the first event of its UID in this read. Series with no event in the window carry none.
  // Together they stay under the batch cap; the rest (in UID order, so the choice is stable) are reported, not dropped silently.
  const carriers = new Map<string, FeedEvent>();
  for (const event of events)
    if (builtSeries.has(event.uid) && !carriers.has(event.uid)) carriers.set(event.uid, event);
  let batchChars = 0;
  for (const uid of [...carriers.keys()].sort()) {
    const series = builtSeries.get(uid)!;
    const size = JSON.stringify(series).length;
    if (batchChars + size > CALENDAR_FEED_SERIES_BATCH_MAX_CHARS) {
      unrepresentableSeries.push({ idPrefix: series.idPrefix, reason: "too many repeating events in one read" });
      continue;
    }
    batchChars += size;
    carriers.get(uid)!.series = series;
  }
  unrepresentableSeries.sort((a, b) => ((a.idPrefix ?? "") < (b.idPrefix ?? "") ? -1 : 1));
  const complete = doc.sawBegin && doc.sawEnd && !doc.veventCapHit && !occurrenceCapHit && !timeBudgetHit;
  return {
    events,
    skipped,
    unrepresentableSeries,
    veventCount: doc.veventCount,
    sawBegin: doc.sawBegin,
    sawEnd: doc.sawEnd,
    veventCapHit: doc.veventCapHit,
    occurrenceCapHit,
    timeBudgetHit,
    parseComplete: complete
  };
}

/** Last local day (all-day series) an UNTIL allows. A UTC UNTIL is read as its UTC date. */
function untilDay(until: NonNullable<Rule["until"]>, _model: Model): number {
  return dayNumber(until.y, until.m, until.d);
}

/** Instant of an UNTIL for a timed series: date-only is the end of that local day in the series zone, floating is in the series zone, Z is absolute. */
function untilInstant(until: NonNullable<Rule["until"]>, model: Model, ownerZone: string): number {
  if (until.kind === "utc") return Date.UTC(until.y, until.m - 1, until.d, until.h, until.mi, until.s);
  const zone = model.allDay ? ownerZone : model.startZone;
  return localToInstant(zone, { y: until.y, m: until.m, d: until.d, h: until.h, mi: until.mi, s: until.s });
}
