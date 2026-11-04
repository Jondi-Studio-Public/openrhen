import { zonedDateAndTime } from "./local-time.js";

/**
 * Pure scheduling logic for the daily plan-map sweep: due once per
 * local calendar day, at or after `localTime`, the same date arithmetic as every daily trigger so a DST
 * day neither skips nor repeats it. The sweep itself is advisory housekeeping run by the portal.
 */
export interface PlanMapSweepDueInput {
  now: Date;
  timezone: string;
  /** The wall-clock time of day the sweep becomes due, `HH:MM` (24-hour). */
  localTime: string;
  /** The local date (`YYYY-MM-DD`) the last sweep happened on, or null if it has never run. */
  lastRunLocalDate: string | null;
}

export function planMapSweepDue({ now, timezone, localTime, lastRunLocalDate }: PlanMapSweepDueInput): {
  due: boolean;
  localDate: string;
} {
  const { date: localDate, time } = zonedDateAndTime(now, timezone);
  return { due: lastRunLocalDate !== localDate && time >= localTime, localDate };
}
