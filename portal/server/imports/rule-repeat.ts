import { normalizeRepeatWeekdays, type CommitmentRepeat, type MonthAnchor } from "@openrhen/contracts";

interface RuleRepeatColumns {
  interval_unit: "days" | "weeks" | "months";
  interval_days: number | null;
  interval_weeks: number | null;
  weekdays: number[] | null;
  interval_months: number | null;
  month_anchor: string | null;
}

/** A stored rule's repeat, or `null` when its repeat columns are incomplete. */
export function repeatOf(row: RuleRepeatColumns): CommitmentRepeat | null {
  if (row.interval_unit === "weeks")
    return row.interval_weeks && row.weekdays?.length
      ? { unit: "weeks", intervalWeeks: row.interval_weeks, weekdays: normalizeRepeatWeekdays(row.weekdays) }
      : null;
  if (row.interval_unit === "months")
    return row.interval_months && row.month_anchor
      ? { unit: "months", intervalMonths: row.interval_months, anchor: row.month_anchor as MonthAnchor }
      : null;
  return row.interval_days ? { unit: "days", intervalDays: row.interval_days } : null;
}
