import { dateOnly, nextDayKey } from "@/features/today/local-datetime";

/** The three settings that place a planning day on the clock. */
export interface PlanningDaySettings {
  timezone: string;
  preferredWakeTime?: string | null | undefined;
  planningHorizonEnd: string;
}

/**
 * The instant a zone's clocks read `wallTime` on `localDate`, resolved exactly as `zonedDateTime` in
 * `engine/core` does (the portal cannot import it): up to four correction passes against what the zone
 * shows, so a wall time inside a spring-forward gap lands just past the gap (London 2026-03-29 01:30 is
 * 02:30 BST). `zonedWallTimeOnDay` settles such a time an hour earlier, which would put the clamp an
 * hour before the planning day the engine ends. Kept here, not in that shared helper, so every other
 * caller of it keeps its behaviour. The two must stay in step.
 */
function planningWallTime(localDate: string, wallTime: string, timezone: string): Date {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const [hour, minute] = wallTime.split(":").map(Number) as [number, number];
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  let stamp = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = format.formatToParts(new Date(stamp));
    const take = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    const correction =
      desired - Date.UTC(take("year"), take("month") - 1, take("day"), take("hour"), take("minute"), take("second"));
    if (correction === 0) break;
    stamp += correction;
  }
  return new Date(stamp);
}

/** The newest daily-plan override, as the state carries it: which row holds it and the instant it names. */
export interface HeldOverride {
  localDate: string;
  horizonOverrideAt?: string | undefined;
}

/**
 * The wake instant that closes the planning day in progress at `now`: when the next planning day begins.
 * Mirrors `activePlanningDate` in `engine/core` (the portal cannot import it): an overnight end (00:30
 * for a person who wakes at 07:00) keeps the day that began yesterday active until today's wake, so at
 * 05:00 the answer is 07:00 today; otherwise it is tomorrow's wake. So does a promised extension: with a
 * 22:00 end, an override saved at 23:30 for 00:30 keeps that night active after midnight, and its next
 * wake is this morning's, not tomorrow's. A "work later tonight" override must never reach this
 * instant's far side, because `dailyHorizonEnd` accepts one only up to it.
 */
export function nextPlanningWake(now: Date, settings: PlanningDaySettings, held?: HeldOverride | null): Date {
  const { timezone, planningHorizonEnd } = settings;
  const wake = settings.preferredWakeTime?.slice(0, 5) || "00:00";
  const today = dateOnly(now, timezone);
  const wakeToday = planningWallTime(today, wake, timezone);
  const overnight = planningWallTime(today, planningHorizonEnd.slice(0, 5), timezone) <= wakeToday;
  if (now < wakeToday && overnight) return wakeToday;
  if (
    held?.horizonOverrideAt &&
    now < wakeToday &&
    (held.localDate === today || held.localDate === prevDayKey(today))
  ) {
    const promised = new Date(held.horizonOverrideAt);
    if (promised > now && promised <= wakeToday) return wakeToday;
  }
  return planningWallTime(nextDayKey(today), wake, timezone);
}

const prevDayKey = (dayKey: string) => nextDayKey(dayKey, -1);

/** An extension of the planning horizon, held inside the planning day it was made in: no later than the next wake. */
export function clampHorizonOverride(
  override: Date,
  now: Date,
  settings: PlanningDaySettings,
  held?: HeldOverride | null
): Date {
  const wake = nextPlanningWake(now, settings, held);
  return override > wake ? wake : override;
}
