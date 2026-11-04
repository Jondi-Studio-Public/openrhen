/**
 * Date handling for the demo seed. Every date in the fixtures is written as it was authored, against
 * a fictional "today" of Tue 2026-10-27 (ANCHOR_DATE). At run time the whole fixture set is moved by
 * the number of days between that anchor and today's date in the demo's zone (TIMEZONE), keeping each local
 * wall-clock time and recomputing the UTC offset (daylight saving moves it). Weekly recurrence
 * weekdays rotate by the same shift so "Wed and Fri" stays the day after "Tue".
 */
export const ANCHOR_DATE = "2026-10-27";
export const TIMEZONE = "America/New_York";
export const LOCALE = "en-US";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 86_400_000;

/** Whole days since 1970-01-01 for a `YYYY-MM-DD` calendar date. */
export function dayNumber(date: string): number {
  const match = DATE_ONLY.exec(date);
  if (!match) throw new Error(`Not a calendar date: ${date}`);
  return Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS);
}

export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** ISO weekday of a calendar date: Monday 1 to Sunday 7. */
export function isoWeekday(date: string): number {
  const day = new Date(dayNumber(date) * DAY_MS).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Today's calendar date where the household lives. */
export function demoDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(instant);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Offset of the demo zone from UTC, in minutes, at an instant. */
export function demoOffsetMinutes(instantMs: number): number {
  const zone =
    new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, timeZoneName: "longOffset" })
      .formatToParts(new Date(instantMs))
      .find((entry) => entry.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(zone);
  if (!match || !match[1]) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

/** The instant a demo-zone wall-clock date and time (`HH:MM` or `HH:MM:SS`) falls on. */
export function localInstant(date: string, time: string): Date {
  const [hours = 0, minutes = 0, seconds = 0] = time.split(":").map(Number);
  const wall = dayNumber(date) * DAY_MS + ((hours * 60 + minutes) * 60 + seconds) * 1000;
  let guess = wall - demoOffsetMinutes(wall) * 60_000;
  guess = wall - demoOffsetMinutes(guess) * 60_000;
  return new Date(guess);
}

/** `2026-11-05T16:00:00-05:00` style string for a demo-zone wall-clock date and time. */
export function localIso(date: string, time: string): string {
  const [hours = 0, minutes = 0, seconds = 0] = time.split(":").map(Number);
  const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  return `${date}T${clock}${formatOffset(demoOffsetMinutes(localInstant(date, time).getTime()))}`;
}

export type Shifter = {
  /** Days between the anchor and today. */
  delta: number;
  /** Today in the demo zone. */
  today: string;
  date(value: string): string;
  /** Moves a `YYYY-MM-DD` or ISO datetime string; anything else comes back unchanged. */
  value(value: string): string;
  /** Deep copy of a fixture with every date and datetime string moved. */
  deep<T>(input: T): T;
  /** Rotates a recurrence rule's weekdays (0 = Sunday to 6 = Saturday) by the shift, sorted ascending as the contract requires. */
  weekdays(days: readonly number[]): number[];
  /** Label for an anchor-relative calendar date in LOCALE, e.g. "Thu Nov 5" or "Friday November 13". */
  label(anchored: string, style?: "short" | "long"): string;
};

export function createShifter(now: Date, anchor: string = ANCHOR_DATE): Shifter {
  const today = demoDate(now);
  const delta = dayNumber(today) - dayNumber(anchor);
  const date = (value: string) => addDays(value, delta);
  const shiftValue = (value: string): string => {
    if (DATE_ONLY.test(value)) return date(value);
    const match = DATE_TIME.exec(value);
    if (!match) return value;
    const dateText = match[1] as string;
    const timeText = match[2] as string;
    return localIso(date(dateText), timeText.length === 5 ? `${timeText}:00` : timeText);
  };
  const deep = <T>(input: T): T => {
    if (typeof input === "string") return shiftValue(input) as T;
    if (Array.isArray(input)) return input.map((item) => deep(item)) as T;
    if (input && typeof input === "object")
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, deep(item)])) as T;
    return input;
  };
  return {
    delta,
    today,
    date,
    value: shiftValue,
    deep,
    weekdays: (days) => days.map((day) => (((day + delta) % 7) + 7) % 7).sort((left, right) => left - right),
    label: (anchored, style = "short") => {
      const moved = new Date(dayNumber(date(anchored)) * DAY_MS);
      const long = style === "long";
      return new Intl.DateTimeFormat(LOCALE, {
        timeZone: "UTC",
        weekday: long ? "long" : "short",
        day: "numeric",
        month: long ? "long" : "short"
      })
        .format(moved)
        .replace(/,/g, "");
    }
  };
}
