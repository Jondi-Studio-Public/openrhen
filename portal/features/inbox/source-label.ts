import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { PARTS_LOCALE } from "@openrhen/contracts";
/**
 * The source line under an Inbox card ("Manual capture · 27 Oct, 12:15 am"), formatted here once rather
 * than by a CSS `text-transform`, which capitalised every word, the "am" included.
 */

/** "manual_capture" → "Manual capture": underscores to spaces and only the first letter raised. */
export function sentenceCase(value: string): string {
  const spaced = value.replaceAll("_", " ").trim();
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : spaced;
}

/** When an item arrived: "27 Oct, 12:15 am", with the year only when it is not this year's. */
export function inboxWhen(value: string | Date, now: Date = new Date(), timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const yearOf = (at: Date) =>
    dateTimeFormat(PARTS_LOCALE, { year: "numeric", ...(timeZone ? { timeZone } : {}) }).format(at);
  const formatter = dateTimeFormat(displayLocale(), {
    day: "numeric",
    month: "short",
    ...(yearOf(date) === yearOf(now) ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
    ...(timeZone ? { timeZone } : {})
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const day = parts.year ? `${parts.day} ${parts.month} ${parts.year}` : `${parts.day} ${parts.month}`;
  return `${day}, ${parts.hour}:${parts.minute} ${(parts.dayPeriod ?? "").toLowerCase()}`.trim();
}

/** "Manual capture · 27 Oct, 12:15 am". */
export function sourceLine(sourceType: string, at: string | Date, now?: Date, timeZone?: string): string {
  return `${sentenceCase(sourceType)} · ${inboxWhen(at, now, timeZone)}`;
}
