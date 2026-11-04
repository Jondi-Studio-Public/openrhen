import { cadenceEligibleLocalDate, daysInMonthOf, isCadenceDueToday } from "@openrhen/contracts";
import type { ActionCadence } from "../model/types.js";
import { zonedDateTime } from "@openrhen/contracts";
import { addLocalDays, dateOrdinal, localDate } from "./recurrence.js";

/**
 * A cadence is measured in whole local days: "every 3 days" means the third day after it was
 * last done, not 72 hours. A never-done series is due from its start date, so it presses from day
 * one instead of waiting a full interval to be noticed.
 *
 * A rule may instead carry a `period` (a block of days counted off from the series' start date, or
 * the calendar month) with a `targetOccurrences` count — "twice this week, any two days" or "once a
 * calendar month" — in which case the plain `intervalDays` math below is bypassed entirely in favour
 * of the period functions further down. A rule without `period` behaves exactly as before; nothing
 * here changes for it.
 */

/** The local date the next cycle falls due. Only meaningful for a plain-interval rule. */
export function cadenceDueLocalDate(cadence: ActionCadence, now: Date): string {
  if (cadence.period) return cadencePeriodDueLocalDate(cadence, now);
  return cadence.lastCompletedLocalDate
    ? addLocalDays(cadence.lastCompletedLocalDate, cadence.intervalDays)
    : cadence.startDate;
}

/**
 * Days past due as a fraction of the interval, measured on the local calendar at `now`: 0 on the
 * completion day itself, `1/interval` the day after, and 1 on the due day. Negative before the
 * series starts. A period rule does not use this ratio — its pressure comes from
 * `cadencePeriodPressure` instead.
 */
export function cadenceDueRatio(cadence: ActionCadence, now: Date): number {
  const today = dateOrdinal(localDate(now, cadence.timezone));
  const interval = Math.max(1, cadence.intervalDays);
  if (cadence.lastCompletedLocalDate) return (today - dateOrdinal(cadence.lastCompletedLocalDate)) / interval;
  // Never done: the start date is the due date, so the ratio reaches 1 exactly there.
  return (today - dateOrdinal(cadence.startDate)) / interval + 1;
}

/** Whole days past the due date at `now`; zero on the due day or before it. */
export function cadenceDaysOverdue(cadence: ActionCadence, now: Date): number {
  if (cadence.period) return cadencePeriodDaysOverdue(cadence, now);
  return Math.max(0, dateOrdinal(localDate(now, cadence.timezone)) - dateOrdinal(cadenceDueLocalDate(cadence, now)));
}

/**
 * How hard the cadence presses, from 0 to 1: half on the due day and saturating one full interval
 * late, so a neglected series keeps climbing for a while and then stops shouting. Importance scales
 * it elsewhere; this is only about time. A period rule never calls this — see `cadencePeriodPressure`.
 */
export function cadencePressure(dueRatio: number): number {
  return Math.min(1, Math.max(0, dueRatio / 2));
}

/**
 * How many occurrences a cadence rule wants per local day, on average — the plain interval's
 * `1/intervalDays`, or a period rule's `targetOccurrences` spread across the period's own length (the
 * days-unit block length, or the current calendar month's). Feeds week-level demand estimates
 * without duplicating the period-length arithmetic at each call site.
 */
export function cadenceOccurrencesPerDay(cadence: ActionCadence, now: Date): number {
  if (!cadence.period) return 1 / Math.max(1, cadence.intervalDays);
  const target = Math.max(1, cadence.targetOccurrences ?? 1);
  if (cadence.period.unit === "days") return target / Math.max(1, cadence.period.length);
  return target / daysInMonthOf(localDate(now, cadence.timezone));
}

/**
 * The instant a cycle may next be suggested: midnight local on the day after the last completion,
 * or the series start if that is later. Done once today means not again today, whatever the score.
 * A period rule folds in whether this period's target is already met, and both branches then apply
 * `minSpacingDays` and `eligibleWeekdays` the same way — the local-date arithmetic for all of this
 * lives in `@openrhen/contracts`'s `cadenceEligibleLocalDate`, shared with platform's own
 * cadence-linked-step gate; this function only supplies "today" and converts the shared result to a
 * zoned instant, since callers here (unlike platform's) need an actual `Date`.
 */
export function cadenceEligibleFrom(cadence: ActionCadence, now: Date): Date {
  const today = localDate(now, cadence.timezone);
  return zonedDateTime(cadenceEligibleLocalDate(cadence, today), "00:00", cadence.timezone);
}

/**
 * Whether a cadence action's next cycle is due at or before `now` — the day-granular "is it due" check
 * a routine step standing in for a cadence action needs before it can be materialised onto a routine
 * instance (a wake instance's preset steps, `deriveWakeInstances` in `engine/core/src/engine.ts`).
 * Delegates entirely to the shared `isCadenceDueToday`, which platform's own gate for
 * cadence-linked commitment routine steps (`isCadenceStepEligibleToday`,
 * `platform/database/src/planning/cadence-step-gate.ts`) calls too, so the two can no longer drift —
 * `platform/` still cannot import this package, but both now import the same day-granular math from
 * `@openrhen/contracts`.
 */
export function cadenceStepDueToday(cadence: ActionCadence, now: Date): boolean {
  return isCadenceDueToday(cadence, now);
}

/**
 * The bounds (inclusive) of the period containing `today`: the calendar month, or — for a days unit
 * — the `length`-day block containing it, counting off in fixed blocks from `cadence.startDate` (the
 * same way a plain interval counts cycles from its start). This is what gives the period a genuine
 * "early" and "late": a rolling window with no fixed start would never run out, so "twice this week"
 * would have no day six to feel urgent on.
 */
function cadencePeriodBounds(cadence: ActionCadence, today: string): { start: string; end: string } {
  const period = cadence.period!;
  if (period.unit === "month") {
    const [year, month] = today.split("-").map(Number) as [number, number];
    const pad = (value: number) => String(value).padStart(2, "0");
    return { start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(daysInMonthOf(today))}` };
  }
  const length = Math.max(1, period.length);
  const cycles = Math.floor((dateOrdinal(today) - dateOrdinal(cadence.startDate)) / length);
  const start = addLocalDays(cadence.startDate, cycles * length);
  return { start, end: addLocalDays(start, length - 1) };
}

/** The completion log a period rule counts against: the per-date list if loaded, else just the last date. */
function cadenceCompletionDates(cadence: ActionCadence): string[] {
  if (cadence.completionLocalDates) return cadence.completionLocalDates;
  return cadence.lastCompletedLocalDate ? [cadence.lastCompletedLocalDate] : [];
}

export interface CadencePeriodStatus {
  start: string;
  end: string;
  /** Whole days left in the period, counting today (so 2 with 2 days left is fully pressed). */
  daysLeft: number;
  done: number;
  remaining: number;
  /** The local date this becomes (or stays) eligible: today while `remaining > 0`, else the day after
   *  this period ends — the next block, or next calendar month. */
  nextEligibleLocalDate: string;
}

/**
 * The count still wanted this period, and the period's own bounds. Exposed as one function so score,
 * outlook and eligibility all agree on the same count instead of each re-deriving it.
 */
export function cadencePeriodStatus(cadence: ActionCadence, now: Date): CadencePeriodStatus {
  if (!cadence.period) throw new Error("cadencePeriodStatus requires a cadence rule with a period.");
  const today = localDate(now, cadence.timezone);
  const { start, end } = cadencePeriodBounds(cadence, today);
  const inPeriod = cadenceCompletionDates(cadence).filter((date) => date >= start && date <= today);
  const target = Math.max(1, cadence.targetOccurrences ?? 1);
  const remaining = Math.max(0, target - inPeriod.length);
  const daysLeft = Math.max(1, dateOrdinal(end) - dateOrdinal(today) + 1);
  const nextEligibleLocalDate = remaining > 0 ? today : addLocalDays(end, 1);
  return { start, end, daysLeft, done: inPeriod.length, remaining, nextEligibleLocalDate };
}

/**
 * Pressure for a period/target rule: 0 once the target is met for the period, however many days are
 * left; otherwise how tight the remaining days are against the remaining count — two occurrences
 * still wanted with two days left in the period is fully pressed, one wanted with a week left barely
 * presses at all. Unlike `cadencePressure`, this is not halved at the due point: a period target has
 * no single "due day" to be half-pressed on, only a period that runs out.
 */
export function cadencePeriodPressure(cadence: ActionCadence, now: Date): number {
  const status = cadencePeriodStatus(cadence, now);
  if (status.remaining <= 0) return 0;
  return Math.min(1, Math.max(0, status.remaining / status.daysLeft));
}

/** The local date a period rule is due from: the period's start while still short, else when it next isn't. */
export function cadencePeriodDueLocalDate(cadence: ActionCadence, now: Date): string {
  const status = cadencePeriodStatus(cadence, now);
  return status.remaining > 0 ? status.start : status.nextEligibleLocalDate;
}

/** Days elapsed since the period began while still short of target; zero once the target is met. */
export function cadencePeriodDaysOverdue(cadence: ActionCadence, now: Date): number {
  const status = cadencePeriodStatus(cadence, now);
  if (status.remaining <= 0) return 0;
  const today = localDate(now, cadence.timezone);
  return Math.max(0, dateOrdinal(today) - dateOrdinal(status.start));
}
