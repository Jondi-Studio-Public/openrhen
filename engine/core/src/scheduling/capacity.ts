import { zonedDateTime } from "@openrhen/contracts";
import { addLocalDays, localDate } from "../recurrence/recurrence.js";
import type { CapacityWindow } from "../model/types.js";

const MAX_AUTOMATIC_DAYS = 400;

export interface ResolvePlanningCapacityInput {
  now: Date;
  horizonEnd: Date;
  usableFraction: number;
  /** IANA zone the daily planning window is expressed in. */
  timezone: string;
  /** Wall-clock start of the daily planning window, normally the preferred wake time. */
  dayStartTime: string;
  /** Wall-clock end of the daily planning window, normally the planning horizon end. */
  dayEndTime: string;
  /**
   * Protected recovery: a same-day wall-clock window on the given weekdays (0 Sunday to
   * 6 Saturday), emitted as a `recovery` window that partitions the day window. `skippedDate` is the
   * one local date the person chose to skip, which stays a single ordinary window.
   */
  recovery?: RecoveryWindowSetting | null;
}

export interface RecoveryWindowSetting {
  startTime: string;
  endTime: string;
  weekdays: readonly number[];
  skippedDate?: string | null;
  /** Further skipped start dates; an overnight window is skipped against the date it starts on. */
  skippedDates?: readonly string[];
}

/**
 * Models one capacity window per local day between the daily planning bounds. Night sits outside
 * every window, so protected sleep never has to be subtracted band by band and capacity per day
 * cannot rise as the horizon lengthens.
 */
export function resolvePlanningCapacity(args: ResolvePlanningCapacityInput): CapacityWindow[] {
  if (args.horizonEnd <= args.now) return [];
  const usableFraction = Math.max(0, Math.min(1, args.usableFraction));
  const windows: CapacityWindow[] = [];
  let date = localDate(args.now, args.timezone);

  for (let day = 0; day < MAX_AUTOMATIC_DAYS; day += 1) {
    const dayStart = zonedDateTime(date, args.dayStartTime, args.timezone);
    if (dayStart >= args.horizonEnd) break;
    const sameDayEnd = zonedDateTime(date, args.dayEndTime, args.timezone);
    // A day window ending at or before its start describes an overnight span, such as 07:00 to 02:00.
    const dayEnd =
      sameDayEnd > dayStart ? sameDayEnd : zonedDateTime(addLocalDays(date, 1), args.dayEndTime, args.timezone);
    const recoveries = recoveryRanges(args.recovery, date, args.timezone, dayStart, dayEnd);
    // The recovery windows partition the day rather than overlapping it: `slots.ts` ranks overlapping
    // windows by energy and `recovery` ranks lowest, so an overlap would lose every shared slot.
    const pieces: { id: string; startsAt: Date; endsAt: Date; energy: CapacityWindow["energy"] }[] = [];
    let cursor = dayStart;
    recoveries.forEach((recovery, index) => {
      const gapId = index === 0 ? `automatic:${date}` : `automatic:${date}:between`;
      pieces.push({ id: gapId, startsAt: cursor, endsAt: recovery.startsAt, energy: "unconfirmed" });
      pieces.push({ id: recovery.id, startsAt: recovery.startsAt, endsAt: recovery.endsAt, energy: "recovery" });
      cursor = recovery.endsAt;
    });
    pieces.push({
      id: recoveries.length ? `automatic:${date}:after` : `automatic:${date}`,
      startsAt: cursor,
      endsAt: dayEnd,
      energy: "unconfirmed"
    });
    for (const piece of pieces) {
      const startsAt = new Date(Math.max(piece.startsAt.getTime(), args.now.getTime()));
      const endsAt = new Date(Math.min(piece.endsAt.getTime(), args.horizonEnd.getTime()));
      if (endsAt > startsAt)
        windows.push({ id: piece.id, startsAt, endsAt, energy: piece.energy, contexts: [], usableFraction });
    }
    date = addLocalDays(date, 1);
  }

  return windows;
}

/**
 * The recovery windows that fall inside one local date's day window, in time order and clipped to it.
 * A window whose end time is before its start time is overnight (23:00 to 06:00) and ends on the next
 * local day, so the previous day's window can spill into today's, and is dropped with the day it
 * started on if that day was skipped.
 */
function recoveryRanges(
  setting: RecoveryWindowSetting | null | undefined,
  date: string,
  timezone: string,
  dayStart: Date,
  dayEnd: Date
): { id: string; startsAt: Date; endsAt: Date }[] {
  if (!setting) return [];
  const ranges: { id: string; startsAt: Date; endsAt: Date }[] = [];
  const consider = (startDate: string, id: string) => {
    if (setting.skippedDate === startDate || setting.skippedDates?.includes(startDate)) return;
    const [year, month, day] = startDate.split("-").map(Number) as [number, number, number];
    if (!setting.weekdays.includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay())) return;
    if (setting.startTime === setting.endTime) return;
    const rawStart = zonedDateTime(startDate, setting.startTime, timezone);
    // Overnight by the configured clock times, not the instants: on a spring-forward date both ends of
    // 02:00 to 03:00 can resolve to one instant, and that must not become a day-long window.
    const overnight = setting.endTime < setting.startTime;
    const rawEnd = zonedDateTime(overnight ? addLocalDays(startDate, 1) : startDate, setting.endTime, timezone);
    const startsAt = new Date(Math.max(rawStart.getTime(), dayStart.getTime()));
    const endsAt = new Date(Math.min(rawEnd.getTime(), dayEnd.getTime()));
    if (endsAt > startsAt) ranges.push({ id, startsAt, endsAt });
  };
  consider(addLocalDays(date, -1), `recovery:${date}:spill`);
  consider(date, `recovery:${date}`);
  return ranges.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
