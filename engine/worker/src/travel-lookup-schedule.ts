/**
 * Pure scheduling logic for the travel lookup tick (the travel time model design note, "Spending the
 * budget (T5)"): whether it is due right now, given the elapsed time since the last run. Kept separate
 * from the worker loop (and its network call) so the interval logic can be unit-tested without a live
 * clock or a portal to call — the same shape as `calendar-sync-schedule.ts`.
 */

export interface TravelLookupTickDueInput {
  now: Date;
  /** The timestamp (ms since epoch) the last tick completed at, or 0 if it has never run. */
  lastRanAt: number;
  /** The interval in milliseconds between ticks, e.g. 300_000 for 5 minutes. */
  intervalMs: number;
}

/**
 * Whether the travel lookup tick should run now, based on elapsed time since the last run. Due once
 * every `intervalMs` milliseconds, unconditionally — every one of the plan's own windows (the live
 * check, the 18:00/22:00/23:45 due times) is decided inside the tick itself, by `lookup-plan.ts`, not
 * by this schedule; this only decides how often the worker bothers to ask.
 */
export function travelLookupTickDue({ now, lastRanAt, intervalMs }: TravelLookupTickDueInput): boolean {
  return now.getTime() - lastRanAt >= intervalMs;
}
