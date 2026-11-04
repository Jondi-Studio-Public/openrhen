import { dateTimeFormat, displayLocale } from "@/shared/locale";

/** The plan's zone and the moment "now" is, so a date reads the same wherever the browser is. */
export type ZoneContext = { timezone: string; now: Date };

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_INSTANT_IN_TEXT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const isInstant = (value: unknown): value is string =>
  typeof value === "string" && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
export const isDateOnly = (value: unknown): value is string =>
  typeof value === "string" && DATE_ONLY.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));

function parts(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  return Object.fromEntries(
    dateTimeFormat(displayLocale(), { timeZone, ...options })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
}

const DAY = { weekday: "short", day: "numeric", month: "short" } as const;
const CLOCK = { hour: "numeric", minute: "2-digit", hourCycle: "h12" } as const;

/** "Thu 12 Nov", with the year only when it is not this year in the plan's zone. */
function dayLabel(date: Date, timeZone: string, now: Date): string {
  const p = parts(date, timeZone, DAY);
  const year = parts(date, timeZone, { year: "numeric" }).year;
  const nowYear = parts(now, timeZone, { year: "numeric" }).year;
  return `${p.weekday} ${p.day} ${p.month}${year === nowYear ? "" : ` ${year}`}`;
}

function clock(date: Date, timeZone: string): { time: string; period: string } {
  const p = parts(date, timeZone, CLOCK);
  return { time: `${p.hour}:${p.minute}`, period: (p.dayPeriod ?? "").toLowerCase() };
}

/** "Thu 12 Nov, 4:00 pm" in the plan's zone. */
export function formatInstant(iso: string, { timezone, now }: ZoneContext): string {
  const date = new Date(iso);
  const { time, period } = clock(date, timezone);
  return `${dayLabel(date, timezone, now)}, ${time} ${period}`.trim();
}

/** "Thu 12 Nov" for a calendar date, which has no zone and so is never shifted. */
export function formatCalendarDay(ymd: string, { timezone, now }: ZoneContext): string {
  const date = new Date(`${ymd}T12:00:00Z`);
  const p = parts(date, "UTC", DAY);
  const year = parts(date, "UTC", { year: "numeric" }).year;
  const nowYear = parts(now, timezone, { year: "numeric" }).year;
  return `${p.weekday} ${p.day} ${p.month}${year === nowYear ? "" : ` ${year}`}`;
}

/** "Thu 12 Nov, 4:00-4:45 pm" when both ends fall on one day in the plan's zone; otherwise null. */
export function formatRange(startIso: string, endIso: string, ctx: ZoneContext): string | null {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (end.getTime() <= start.getTime()) return null;
  const a = parts(start, ctx.timezone, { year: "numeric", month: "numeric", day: "numeric" });
  const b = parts(end, ctx.timezone, { year: "numeric", month: "numeric", day: "numeric" });
  if (a.year !== b.year || a.month !== b.month || a.day !== b.day) return null;
  const from = clock(start, ctx.timezone);
  const to = clock(end, ctx.timezone);
  const first = from.period === to.period ? from.time : `${from.time} ${from.period}`;
  return `${dayLabel(start, ctx.timezone, ctx.now)}, ${first}-${to.time} ${to.period}`.trim();
}

/** Text with raw instants in it, each read as the plan's day and time. */
export function localiseInstants(text: string, ctx: ZoneContext): string {
  return text.replace(ISO_INSTANT_IN_TEXT, (iso) => (Number.isNaN(Date.parse(iso)) ? iso : formatInstant(iso, ctx)));
}

/** A zone's offset from UTC in minutes at a moment; null for a name the runtime does not know. */
export function offsetMinutes(timeZone: string, at: Date): number | null {
  try {
    const name = parts(at, timeZone, { timeZoneName: "longOffset" }).timeZoneName ?? "";
    if (name === "GMT") return 0;
    const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!match) return null;
    const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
    return match[1] === "-" ? -minutes : minutes;
  } catch {
    return null;
  }
}
