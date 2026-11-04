import { dateTimeFormat, displayLocale } from "@/shared/locale";

type DateWidth = "short" | "long";

function dateParts(value: string | Date, timezone: string, locale: string, dateWidth?: DateWidth) {
  const formatter = dateTimeFormat(locale, {
    timeZone: timezone,
    ...(dateWidth ? { weekday: dateWidth, day: "numeric", month: dateWidth } : {}),
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12"
  });
  return Object.fromEntries(formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
}

export function formatZonedTime(value: string | Date, timezone: string, locale: string = displayLocale()): string {
  const parts = dateParts(value, timezone, locale);
  return `${parts.hour}:${parts.minute} ${parts.dayPeriod!.toLowerCase()}`;
}

export function formatZonedDateTime(value: string | Date, timezone: string, locale: string = displayLocale()): string {
  const parts = dateParts(value, timezone, locale, "short");
  return `${parts.weekday}, ${parts.day} ${parts.month} at ${parts.hour}:${parts.minute} ${parts.dayPeriod!.toLowerCase()}`;
}

export function formatZonedDate(value: string | Date, timezone: string, locale: string = displayLocale()): string {
  const formatter = dateTimeFormat(locale, {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long"
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.weekday}, ${parts.day} ${parts.month}`;
}

const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g;

/**
 * Text a server wrote with raw ISO instants in it ("Overlaps Dentist (2026-09-03T09:00:00.000Z–…)"),
 * read as the zone's own day and time instead. Anything that does not parse is left as written.
 */
export function localiseIsoText(text: string, timezone: string, locale: string = displayLocale()): string {
  return text.replace(ISO_INSTANT, (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : formatZonedDateTime(date, timezone, locale);
  });
}

function zonedDayKey(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(value);
}

/**
 * A moment in the person's own clock for an error line: "2:56 pm" on the same local day as `now`,
 * otherwise with the day ("Mon 26 Oct, 11:40 pm").
 */
export function formatZonedMoment(
  value: string | Date,
  timezone: string,
  now: Date,
  locale: string = displayLocale()
): string {
  const at = new Date(value);
  const time = formatZonedTime(at, timezone, locale);
  if (zonedDayKey(at, timezone) === zonedDayKey(now, timezone)) return time;
  const parts = dateParts(at, timezone, locale, "short");
  return `${parts.weekday} ${parts.day} ${parts.month}, ${time}`;
}

/** How far from now a date still reads without its year: about six weeks either side. */
const YEAR_FREE_DAYS = 42;

/**
 * The one short date: "Thu 12 Nov" within about six weeks of `now`, with the year ("Thu 31 Dec 2026")
 * beyond that. Plain dates on the plan and its rows read through this, so they cannot disagree.
 */
export function formatShortDate(
  value: string | Date,
  timezone: string,
  now: Date,
  locale: string = displayLocale()
): string {
  const at = new Date(value);
  const near = Math.abs(at.getTime() - now.getTime()) <= YEAR_FREE_DAYS * 86_400_000;
  const parts = Object.fromEntries(
    dateTimeFormat(locale, { timeZone: timezone, weekday: "short", day: "numeric", month: "short", year: "numeric" })
      .formatToParts(at)
      .map((part) => [part.type, part.value])
  );
  return `${parts.weekday} ${parts.day} ${parts.month}${near ? "" : ` ${parts.year}`}`;
}
