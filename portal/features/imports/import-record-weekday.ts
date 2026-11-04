import { dateTimeFormat, displayLocale } from "@/shared/locale";
import type { ImportEntityType, ImportRecord } from "@openrhen/contracts";
import { pluralWeekdayNames } from "@/features/imports/import-weekdays";

/**
 * A calendar batch reads as a column of ISO dates, and nobody checking a fortnight of imported events
 * can see that 2026-09-03 is a Thursday. So the day is named beside the record's title — derived from
 * the date the record holds right now, never written into the title itself: the stored title is what
 * The calendar provider sync compares against the remote calendar's, and a decorated one would read as an edit
 * on every pull. Deriving it also means an edited date renames its own day as it is typed.
 */

/** The field each record dates itself by: a commitment starts at an instant, a series from a day. */
const dateFields: Partial<Record<ImportEntityType, string>> = {
  fixed_commitment: "startsAt",
  fixed_commitment_recurrence: "startDate"
};

/** Whether this is the field whose day the record is read by, and so the one worth annotating. */
export function isImportWeekdayField(entityType: ImportEntityType, name: string): boolean {
  return dateFields[entityType] === name;
}

/** A reading that carries no zone of its own: a calendar day, with or without a wall clock after it. */
const ZONELESS_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?$/;
/** A reading that places itself: a full timestamp with an offset or a `Z` on the end of it. */
const INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * "Wednesday" for the day a record falls on — "Wednesdays" for a weekly series, which is not one
 * Wednesday but every one of them — or null when there is no day to name: a record with no date
 * field, an empty or half-typed value, or a date nobody could have meant. Nothing is shown rather
 * than an "Invalid Date", because a review reads the fields it can trust and ignores the rest.
 */
export function importRecordWeekday(
  record: Pick<ImportRecord, "entityType" | "fields">,
  timezone?: string
): string | null {
  const name = dateFields[record.entityType];
  if (!name) return null;
  const value = record.fields[name]?.value;
  if (typeof value !== "string") return null;
  const weekday = weekdayName(value.trim(), timezone);
  if (!weekday) return null;
  // Only the days unit means "every Wednesday" the way `intervalDays: 7` does — a monthly rule
  // anchored to a weekday (nth_weekday/last_weekday) is not a weekly series, even when some stray
  // field made the arithmetic look weekly.
  const unit = record.fields.intervalUnit?.value;
  const weekdays = record.fields.weekdays?.value;
  if (
    unit === "weeks" &&
    Array.isArray(weekdays) &&
    weekdays.length > 0 &&
    weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  )
    return pluralWeekdayNames(weekdays as number[]);
  const isDaysUnit = unit === undefined || unit === null || unit === "days";
  return isDaysUnit && Number(record.fields.intervalDays?.value) === 7 ? `${weekday}s` : weekday;
}

/**
 * A value carrying an offset or a `Z` is an instant, so the day it lands on is the day the batch's
 * zone shows it in. A value carrying neither already names a calendar day, and is read as written
 * rather than through any zone — reading a bare date as UTC midnight would move it a day west.
 *
 * Only these two shapes are read at all. `new Date` will make a Tuesday out of `2026-09-`, a date
 * half typed and still being typed, and half a date is not a day anyone has agreed to yet.
 */
function weekdayName(text: string, timezone: string | undefined): string | null {
  const zoneless = ZONELESS_DATE.exec(text);
  if (zoneless) {
    const [year, month, day] = [Number(zoneless[1]), Number(zoneless[2]), Number(zoneless[3])];
    const at = new Date(Date.UTC(year, month - 1, day));
    // Date.UTC rolls a day that does not exist into the next month; 31 September is a typo, not a day.
    if (at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
    return formatWeekday(at, "UTC");
  }
  if (!INSTANT.test(text)) return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : formatWeekday(at, timezone);
}

const formatWeekday = (at: Date, timezone: string | undefined) =>
  dateTimeFormat(displayLocale(), { timeZone: timezone, weekday: "long" }).format(at);
