import { localDateOf } from "./cadence-due.js";
import { offsetMinutesAt } from "./pulse-public.js";

/** Used when a person has no preferred wake time or quiet-hours start stored. */
export const DEFAULT_PUSH_WAKE_TIME = "08:00";
export const DEFAULT_PUSH_QUIET_FROM = "22:00";

function wallMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/** The instant `wallTime` (HH:MM) falls on, on the local date `localDate` (YYYY-MM-DD) in `timezone`. */
function wallTimeOn(localDate: string, wallTime: string, timezone: string): Date {
  const [year, month, day] = localDate.split("-").map(Number);
  const naive = Date.UTC(year!, month! - 1, day!) + wallMinutes(wallTime) * 60_000;
  // Two passes, so a wall time on a day the clocks change lands on that day's own offset.
  const first = naive - offsetMinutesAt(new Date(naive), timezone) * 60_000;
  return new Date(naive - offsetMinutesAt(new Date(first), timezone) * 60_000);
}

/**
 * When a push the person does not need at once should be delivered: now during the day, or at their next wake
 * time when now falls in the night (from `quietFrom`, the planning horizon's end, to `wakeTime`). The night
 * usually crosses midnight (22:00 to 07:00) but may start after it (00:30 to 07:00). A wake later than the
 * quiet start on the same clock (a night shift sleeping 08:00 to 15:00) reads as that same-day interval too.
 * The sweeps that queue these run at 03:30, so without this they would buzz the phone in the middle of the night.
 */
export function nextDaytimeDelivery(
  now: Date,
  timezone: string,
  wakeTime: string | null = DEFAULT_PUSH_WAKE_TIME,
  quietFrom: string | null = DEFAULT_PUSH_QUIET_FROM
): Date {
  const wake = wakeTime ?? DEFAULT_PUSH_WAKE_TIME;
  const quiet = quietFrom ?? DEFAULT_PUSH_QUIET_FROM;
  const today = localDateOf(now, timezone);
  const todayWake = wallTimeOn(today, wake, timezone);
  const todayQuiet = wallTimeOn(today, quiet, timezone);
  if (wallMinutes(quiet) <= wallMinutes(wake)) {
    // The night sits inside one calendar day.
    return now >= todayQuiet && now < todayWake ? todayWake : now;
  }
  if (now < todayWake) return todayWake;
  if (now < todayQuiet) return now;
  const [year, month, day] = today.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10);
  return wallTimeOn(tomorrow, wake, timezone);
}
