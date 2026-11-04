import { dateTimeFormat } from "@/shared/locale";
import { PARTS_LOCALE } from "@openrhen/contracts";
/**
 * `datetime-local` inputs speak local wall-clock time with no zone attached, so a stored instant has
 * to be converted to and from that wall-clock text in the *planning* timezone — not the browser's.
 * The two used to be shifted by `Date.prototype.getTimezoneOffset()`, the browser's own offset, which
 * happened to agree with the planning zone only when the two coincided and was silently wrong
 * whenever they did not (finding 30). This was also duplicated near-verbatim in
 * `features/plan/plan-formatting.ts`; that copy now re-exports these instead of keeping its own.
 * Keeping both directions in one place is what stops an edit from quietly moving an event.
 */
export function dateInput(value: string | undefined, timezone: string): string {
  if (!value) return "";
  const { year, month, day, hour, minute } = zonedParts(new Date(value), timezone);
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`;
}

// No trailing offset or `Z` — that is exactly what distinguishes a `datetime-local` input's own value
// (always bare wall-clock text) from an already-absolute ISO string, which always carries one.
const DATETIME_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;

/**
 * The inverse of `dateInput`: a `datetime-local` value, read as wall-clock time in `timezone` and
 * converted to the instant it names. Also tolerant of an already-absolute ISO string (one that
 * carries its own offset or `Z`), so callers that sometimes hand back a value untouched by an editor
 * still get a normalized instant rather than a throw.
 */
export function iso(value: string, timezone: string): string {
  const match = DATETIME_LOCAL.exec(value);
  if (!match) return new Date(value).toISOString();
  const [, year, month, day, hour, minute] = match.map(Number) as unknown as [
    number,
    number,
    number,
    number,
    number,
    number
  ];
  return zonedDateTimeToUtc(year, month, day, hour, minute, timezone).toISOString();
}

/** A calendar day ("YYYY-MM-DD") in `timezone` — `dateOnly(new Date(...), "Europe/London")`. */
export function dateOnly(date: Date, timezone: string): string {
  const { year, month, day } = zonedParts(date, timezone);
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

/**
 * A calendar day in the planning timezone, as instants. Everything the day timeline lays out is
 * measured from `startsAt` in real elapsed minutes, so a day on which the clocks change is 23 or 25
 * hours long rather than being squeezed or stretched to fit 24. The browser's own zone is never
 * consulted: the day is the person's, wherever the machine happens to be.
 */
export interface ZonedDayBounds {
  dayKey: string;
  startsAt: Date;
  endsAt: Date;
}

export interface HourMark {
  at: Date;
  /** Real minutes since the day began; the vertical position of the mark. */
  minuteOffset: number;
  /** The local hour of the day, 0–23; repeats or skips on a clock-change day. */
  hour: number;
  label: string;
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDayKey(dayKey: string): [number, number, number] {
  const match = DAY_KEY.exec(dayKey);
  if (!match) throw new Error(`Not a local day key: ${dayKey}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The following calendar day, computed on the proleptic calendar so month and year ends roll over. */
export function nextDayKey(dayKey: string, days = 1): string {
  const [year, month, day] = parseDayKey(dayKey);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Local midnight at the start of `dayKey` in `timezone`. */
export function zonedDayStart(dayKey: string, timezone: string): Date {
  const [year, month, day] = parseDayKey(dayKey);
  return zonedDateTimeToUtc(year, month, day, 0, 0, timezone);
}

/** Local midnight to the next local midnight, half-open. */
export function zonedDayBounds(dayKey: string, timezone: string): ZonedDayBounds {
  return { dayKey, startsAt: zonedDayStart(dayKey, timezone), endsAt: zonedDayStart(nextDayKey(dayKey), timezone) };
}

/** A wall-clock time such as the daily horizon "22:00" placed on a particular local day. */
export function zonedWallTimeOnDay(dayKey: string, wallTime: string, timezone: string): Date {
  const [year, month, day] = parseDayKey(dayKey);
  const [hour = 0, minute = 0] = wallTime.split(":").map(Number);
  return zonedDateTimeToUtc(year, month, day, hour, minute, timezone);
}

/**
 * One mark per real hour from the start of the day, labelled with the local hour it falls on. On
 * the day daylight saving ends the same local hour is labelled twice; on the day it begins one hour
 * is missing. Both are the truth of that day rather than an artefact to hide.
 */
export function hourMarks(bounds: ZonedDayBounds, timezone: string): HourMark[] {
  const marks: HourMark[] = [];
  const formatter = dateTimeFormat(PARTS_LOCALE, { timeZone: timezone, hour: "numeric", hourCycle: "h23" });
  for (let at = bounds.startsAt.getTime(); at < bounds.endsAt.getTime(); at += 60 * 60_000) {
    const date = new Date(at);
    const hour = Number(formatter.formatToParts(date).find((part) => part.type === "hour")?.value ?? "0");
    marks.push({ at: date, minuteOffset: (at - bounds.startsAt.getTime()) / 60_000, hour, label: hourLabel(hour) });
  }
  return marks;
}

function hourLabel(hour: number): string {
  if (hour === 0) return "12 am";
  if (hour === 12) return "12 pm";
  return hour < 12 ? `${hour} am` : `${hour - 12} pm`;
}

function zonedParts(date: Date, timezone: string) {
  const parts = dateTimeFormat(PARTS_LOCALE, {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)!.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour") % 24,
    minute: value("minute"),
    second: value("second")
  };
}

/**
 * The instant at which a zone's clocks read the given wall time. Found by correcting a UTC guess
 * against what the zone actually shows there, which converges in one step away from a transition
 * and settles on a consistent instant across one; a wall time that never occurs (inside a
 * spring-forward gap) lands within an hour of the jump rather than throwing.
 */
function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(timestamp), timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    if (actualAsUtc === desired) break;
    timestamp += desired - actualAsUtc;
  }
  return new Date(timestamp);
}
