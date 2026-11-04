import type { CommitmentRepeat, MonthAnchor } from "./commitment-repeat.js";
import { dateOrdinal, daysInMonthOf } from "./cadence-due.js";

// Whether a repeat falls on a date. Schema-free (types only from the schema module) so the calendar feed parser worker
// can use the one rule without loading zod. `commitment-repeat.ts` re-exports `commitmentRepeatFallsOn`.

function dayOfMonth(value: string): number {
  return Number(value.slice(8, 10));
}

/** A comparable, strictly increasing count of calendar months — not a duration, just an index. */
function monthOrdinal(value: string): number {
  const [year, month] = value.split("-").map(Number) as [number, number];
  return year * 12 + (month - 1);
}

/** 0 = Sunday .. 6 = Saturday, read from the calendar date alone. */
function weekdayOf(value: string): number {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Which occurrence (1-based) of its own weekday `value` is, within its own month. */
function weekdayOrdinalInMonth(value: string): number {
  return Math.floor((dayOfMonth(value) - 1) / 7) + 1;
}

/** Whether `value` is the last occurrence of its weekday in its own month. */
function isLastWeekdayOccurrence(value: string): boolean {
  return dayOfMonth(value) + 7 > daysInMonthOf(value);
}

function matchesAnchor(anchor: MonthAnchor, startDate: string, localDate: string): boolean {
  switch (anchor) {
    case "day_of_month":
      // Short months are skipped, never clamped: a February with no 31st matches nothing (Decisions).
      return dayOfMonth(localDate) === dayOfMonth(startDate);
    case "last_day":
      // Reads nothing from the start date but its own month's final day (Desired behaviour table).
      return dayOfMonth(localDate) === daysInMonthOf(localDate);
    case "nth_weekday": {
      // Defined for ordinals 1-4 only; a start date that is the 5th of its weekday falls on nothing,
      // its own start date included — this is what lets invariant 2 reject such a rule outright.
      const startOrdinal = weekdayOrdinalInMonth(startDate);
      if (startOrdinal > 4) return false;
      return weekdayOf(localDate) === weekdayOf(startDate) && weekdayOrdinalInMonth(localDate) === startOrdinal;
    }
    case "last_weekday":
      return weekdayOf(localDate) === weekdayOf(startDate) && isLastWeekdayOccurrence(localDate);
  }
}

/** The ordinal of the Monday that opens `value`'s calendar week (weeks run Monday to Sunday). */
function mondayOrdinal(value: string): number {
  return dateOrdinal(value) - ((weekdayOf(value) + 6) % 7);
}

/** Does `repeat`, first occurring on `startDate`, fall on `localDate`? Both are `YYYY-MM-DD`. */
export function commitmentRepeatFallsOn(repeat: CommitmentRepeat, startDate: string, localDate: string): boolean {
  if (repeat.unit === "days") {
    // The modulo arithmetic moved from `recurrence.ts`/`week-plan.ts` unchanged (invariant 4).
    return (dateOrdinal(localDate) - dateOrdinal(startDate)) % Math.max(1, repeat.intervalDays) === 0;
  }
  if (repeat.unit === "weeks") {
    // the start date's Monday-to-Sunday week is week 0, every `intervalWeeks`th week after it is
    // on, and within an on week the listed weekdays fall. Days before the start date never fall, so a
    // Thursday start with Tuesday listed begins on the Tuesday after, not the one before.
    if (localDate < startDate) return false;
    const weeksBetween = (mondayOrdinal(localDate) - mondayOrdinal(startDate)) / 7;
    if (weeksBetween % Math.max(1, repeat.intervalWeeks) !== 0) return false;
    return repeat.weekdays.includes(weekdayOf(localDate));
  }
  const monthsBetween = monthOrdinal(localDate) - monthOrdinal(startDate);
  if (monthsBetween < 0 || monthsBetween % repeat.intervalMonths !== 0) return false;
  return matchesAnchor(repeat.anchor, startDate, localDate);
}
