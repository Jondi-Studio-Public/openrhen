/**
 * The protected-recovery occurrence a person is in or about to start, named by the local date
 * it STARTS on. That date is what "skip recovery" is saved against and what the engine's capacity
 * checks, so a 23:00 to 06:00 window skipped at 05:00 is still last night's occurrence.
 */
export interface RecoveryOccurrence {
  /** Local date the occurrence starts on. */
  startDate: string;
  /** The occurrence has started; otherwise it is still ahead. */
  running: boolean;
}

const weekdayOf = (date: string) => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

const dayBefore = (date: string) => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
};

/**
 * The occurrence running now, or the next one starting later today, or null when none is left today.
 * `localDate` and `clock` (`HH:MM`) are the person's wall clock. A window whose end is at or before its
 * start is overnight: after midnight and before the end, the occurrence is yesterday's.
 */
export function recoveryOccurrence(input: {
  localDate: string;
  clock: string;
  startTime: string;
  endTime: string;
  weekdays: readonly number[];
}): RecoveryOccurrence | null {
  const { localDate, clock, startTime, endTime, weekdays } = input;
  if (startTime === endTime) return null;
  const overnight = endTime < startTime;
  if (overnight && clock < endTime) {
    const yesterday = dayBefore(localDate);
    if (weekdays.includes(weekdayOf(yesterday))) return { startDate: yesterday, running: true };
  }
  if (!weekdays.includes(weekdayOf(localDate))) return null;
  if (overnight) return { startDate: localDate, running: clock >= startTime };
  if (clock >= endTime) return null;
  return { startDate: localDate, running: clock >= startTime };
}
