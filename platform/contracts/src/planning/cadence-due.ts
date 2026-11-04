/**
 * the day-granular "is a cadence cycle due" check, shared by two callers that must never
 * drift apart — the engine's gate for a cadence-linked wake/bedtime routine-instance step
 * (`cadenceStepDueToday`, `engine/core/src/recurrence/cadence.ts`) and platform's gate for a
 * cadence-linked commitment routine step, applied once per forecast-persisting sync
 * (`isCadenceStepEligibleToday`, `platform/database/src/planning/cadence-step-gate.ts`). Each used to
 * reimplement the period bounds, remaining-count, `minSpacingDays` and `eligibleWeekdays` math by hand,
 * because `platform/` may not import `@openrhen/engine-*` — not even from a test — the same boundary
 * `routine-step-mootness.ts` documents for its own engine-core twin. Living here, both packages may
 * depend on it.
 *
 * Local-date arithmetic only, never a zoned instant: the one caller that needs an actual `Date`
 * (`cadenceEligibleFrom`, which a period's pressure and other scoring also read) converts the local
 * date this returns using its own timezone utility — nothing here needs to know how.
 */

/** The fields either caller's richer cadence record already carries; nothing about their source. */
export interface CadenceDueRule {
  intervalDays: number;
  timezone: string;
  /** Local date the series began; a never-done action is due from here. */
  startDate: string;
  /** Local date of the last completion, from the completion log. */
  lastCompletedLocalDate?: string;
  /** When present, takes precedence over `intervalDays` for the due check. */
  period?: { unit: "days"; length: number } | { unit: "month" };
  /** Completions wanted per period; defaults to 1 when `period` is set. */
  targetOccurrences?: number;
  /** Minimum days between two completions, so a period's target cannot be met in one sitting. */
  minSpacingDays?: number;
  /** Weekdays (0 = Sunday .. 6 = Saturday) this cadence may be suggested on, if restricted. */
  eligibleWeekdays?: number[];
  /** Local dates of every completion within reach of the current period, from the completion log. */
  completionLocalDates?: string[];
}

/** The local calendar date (`YYYY-MM-DD`) `date` falls on in `timezone`. */
export function localDateOf(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

export function addLocalDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function dateOrdinal(value: string): number {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function daysInMonthOf(value: string): number {
  const [year, month] = value.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function localWeekday(value: string): number {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * The bounds (inclusive) of the period containing `today`: the calendar month, or — for a days unit —
 * the `length`-day block containing it, counting off in fixed blocks from `rule.startDate` (the same
 * way a plain interval counts cycles from its start).
 */
export function cadencePeriodBounds(rule: CadenceDueRule, today: string): { start: string; end: string } {
  const period = rule.period!;
  if (period.unit === "month") {
    const [year, month] = today.split("-").map(Number) as [number, number];
    const pad = (value: number) => String(value).padStart(2, "0");
    return { start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(daysInMonthOf(today))}` };
  }
  const length = Math.max(1, period.length);
  const cycles = Math.floor((dateOrdinal(today) - dateOrdinal(rule.startDate)) / length);
  const start = addLocalDays(rule.startDate, cycles * length);
  return { start, end: addLocalDays(start, length - 1) };
}

/** How many of a period's target occurrences are still wanted, and when it next becomes eligible if not. */
export function cadencePeriodRemaining(
  rule: CadenceDueRule,
  today: string
): { remaining: number; nextEligibleLocalDate: string } {
  const { start, end } = cadencePeriodBounds(rule, today);
  const completions = rule.completionLocalDates ?? (rule.lastCompletedLocalDate ? [rule.lastCompletedLocalDate] : []);
  const inPeriod = completions.filter((date) => date >= start && date <= today);
  const target = Math.max(1, rule.targetOccurrences ?? 1);
  const remaining = Math.max(0, target - inPeriod.length);
  return { remaining, nextEligibleLocalDate: remaining > 0 ? today : addLocalDays(end, 1) };
}

/** Pushes a candidate date out to cover the floor between completions, if the rule carries one. */
function applyMinSpacing(rule: CadenceDueRule, date: string): string {
  if (!rule.minSpacingDays || !rule.lastCompletedLocalDate) return date;
  const floor = addLocalDays(rule.lastCompletedLocalDate, rule.minSpacingDays);
  return floor > date ? floor : date;
}

/** Advances a candidate date to the next day (within a week) whose weekday the rule allows. */
function advanceToEligibleWeekday(date: string, eligibleWeekdays: number[] | undefined): string {
  if (!eligibleWeekdays || !eligibleWeekdays.length) return date;
  let candidate = date;
  for (let step = 0; step < 7; step += 1) {
    if (eligibleWeekdays.includes(localWeekday(candidate))) return candidate;
    candidate = addLocalDays(candidate, 1);
  }
  return date;
}

/**
 * The local date a cycle next becomes eligible: midnight local the day after the last completion (or
 * the series start if that is later) for a plain-interval rule; for a period rule, today while its
 * target is still short, else the day after the period ends. Both branches then apply `minSpacingDays`
 * and `eligibleWeekdays` the same way. Mirrors `cadenceEligibleFrom`'s local-date component
 * (`engine/core/src/recurrence/cadence.ts`); that function converts the result to a zoned instant,
 * which this never needs to.
 */
export function cadenceEligibleLocalDate(rule: CadenceDueRule, today: string): string {
  let earliest: string;
  if (rule.period) {
    const { remaining, nextEligibleLocalDate } = cadencePeriodRemaining(rule, today);
    earliest = remaining > 0 ? (rule.startDate > today ? rule.startDate : today) : nextEligibleLocalDate;
    if (earliest < rule.startDate) earliest = rule.startDate;
    // Never twice in one local day, however much of the target is still outstanding.
    if (rule.lastCompletedLocalDate === today && earliest <= today) earliest = addLocalDays(today, 1);
  } else {
    const dayAfterLast = rule.lastCompletedLocalDate ? addLocalDays(rule.lastCompletedLocalDate, 1) : rule.startDate;
    earliest = dayAfterLast > rule.startDate ? dayAfterLast : rule.startDate;
  }
  earliest = applyMinSpacing(rule, earliest);
  earliest = advanceToEligibleWeekday(earliest, rule.eligibleWeekdays);
  return earliest;
}

/** Whether a cycle is due on or before the local date `today`. */
export function isCadenceDueByLocalDate(rule: CadenceDueRule, today: string): boolean {
  return cadenceEligibleLocalDate(rule, today) <= today;
}

/** Whether a cadence rule's next cycle is due at or before `now`, evaluated to day granularity. */
export function isCadenceDueToday(rule: CadenceDueRule, now: Date): boolean {
  return isCadenceDueByLocalDate(rule, localDateOf(now, rule.timezone));
}
