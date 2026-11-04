import { PARTS_LOCALE } from "@openrhen/contracts";
import { CliError, EXIT } from "./errors.js";

/**
 * Turns a `--from`, `--to`, or `--since` value into an instant. Accepts an ISO date or date-time,
 * `now`, `today`, `tomorrow`, `yesterday`, and relative offsets such as `+7d`, `-2h`, `+30m`.
 * Calendar words mean midnight in `timeZone` (the portal's planning timezone) when one is given, so a
 * CLI running on another machine, say a cloud container in UTC, agrees with the portal about which day
 * it is. Without a `timeZone` they fall back to the machine's local midnight.
 */
export function parseWhen(value: string, now: Date, timeZone?: string): Date {
  const text = value.trim().toLowerCase();
  if (text === "now") return new Date(now);
  if (text === "today" || text === "tomorrow" || text === "yesterday") {
    const dayOffset = text === "tomorrow" ? 1 : text === "yesterday" ? -1 : 0;
    if (timeZone !== undefined) return zonedMidnight(now, timeZone, dayOffset);
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + dayOffset);
    return day;
  }
  const relative = /^([+-])(\d+)([dhm])$/.exec(text);
  if (relative) {
    const sign = relative[1] === "-" ? -1 : 1;
    const amount = Number(relative[2]);
    const unit = relative[3] === "d" ? 86_400_000 : relative[3] === "h" ? 3_600_000 : 60_000;
    return new Date(now.getTime() + sign * amount * unit);
  }
  // A date, or a date-time with no offset, names a wall-clock time: read it in the portal's zone, not UTC or the host's.
  const wall =
    timeZone === undefined
      ? null
      : /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(value.trim());
  const parsed = wall
    ? resolveWallClock(
        Date.UTC(
          Number(wall[1]),
          Number(wall[2]) - 1,
          Number(wall[3]),
          Number(wall[4] ?? 0),
          Number(wall[5] ?? 0),
          Number(wall[6] ?? 0),
          Number((wall[7] ?? "0").padEnd(3, "0"))
        ),
        timeZone!
      )
    : new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new CliError(`Cannot read "${value}" as a time. Use an ISO date, now, today, tomorrow, or +7d.`, EXIT.usage);
  return parsed;
}

/** Midnight at the start of the calendar day `dayOffset` days from `now`'s day, as seen in `timeZone`. */
function zonedMidnight(now: Date, timeZone: string, dayOffset: number): Date {
  const today = clockParts(now, timeZone);
  return resolveWallClock(Date.UTC(today.year, today.month - 1, today.day + dayOffset), timeZone);
}

/** The instant whose wall clock in `timeZone` reads like `wallClockAsUtc` read as UTC. */
function resolveWallClock(wallClockAsUtc: number, timeZone: string): Date {
  const first = wallClockAsUtc - timeZoneOffsetMinutes(new Date(wallClockAsUtc), timeZone) * 60_000;
  // Across a daylight-saving change the offset at the first guess can differ from the offset at midnight.
  const second = wallClockAsUtc - timeZoneOffsetMinutes(new Date(first), timeZone) * 60_000;
  return new Date(second);
}

export interface ClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
}

export function clockParts(date: Date, timeZone: string): ClockParts {
  const parts = new Intl.DateTimeFormat(PARTS_LOCALE, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23"
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")) % 24,
    minute: Number(read("minute")),
    weekday: read("weekday")
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * A wall-clock time in the user's planning timezone, as short as the distance from now allows:
 * `14:30` today, `Thu 14:30` within a week, `2026-09-10 14:30` beyond.
 */
export function formatWhen(iso: string | undefined | null, timeZone: string, now: Date): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const target = clockParts(date, timeZone);
  const current = clockParts(now, timeZone);
  const time = `${pad(target.hour)}:${pad(target.minute)}`;
  if (target.year === current.year && target.month === current.month && target.day === current.day) return time;
  const distanceDays = Math.abs(date.getTime() - now.getTime()) / 86_400_000;
  if (distanceDays < 6) return `${target.weekday} ${time}`;
  return `${target.year}-${pad(target.month)}-${pad(target.day)} ${time}`;
}

/** The unambiguous local form for tables: `2026-09-03 15:17` in the planning timezone. */
export function formatClock(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = clockParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** Whether two instants fall on the same calendar day in a timezone. */
export function sameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const left = clockParts(a, timeZone);
  const right = clockParts(b, timeZone);
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

export function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}

/** The zone's offset from UTC, in minutes, at the given instant (positive east of UTC). */
function timeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));
  return Math.round((asUtc - date.getTime()) / 60_000);
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Rewrites an ISO instant to carry the given timezone's own offset instead of whatever offset (or
 * `Z`) it arrived with, e.g. `2026-09-04T08:30:00Z` in `Europe/London` becomes
 * `2026-09-04T09:30:00+01:00`. Machine-parsable and human-readable in one string; not a date is
 * returned unchanged. Milliseconds are kept only when the source instant carried them.
 */
export function localiseInstant(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const offsetMinutes = timeZoneOffsetMinutes(date, timeZone);
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const datePart = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  const timePart = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
  const ms = shifted.getUTCMilliseconds();
  const fraction = ms > 0 ? `.${String(ms).padStart(3, "0")}` : "";
  return `${datePart}T${timePart}${fraction}${formatOffset(offsetMinutes)}`;
}
