export function localDayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

/** Half-open comparison: two intervals that only touch at a boundary do not collide. */
export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return new Date(aStart) < new Date(bEnd) && new Date(aEnd) > new Date(bStart);
}

/**
 * The day's capacity from the engine's slots, clipped to the local day `[dayStart, dayEnd)`. The
 * detailed band runs a week, so summing every slot would state a week as if it were today. A slot
 * straddling a boundary contributes its capacity in proportion to the part that falls inside.
 * `usable` is the whole day's capacity, or null when the slots do not reach back to the start of the day; `remaining` is the part not yet over.
 */
export function dayCapacityMinutes(
  slots: ReadonlyArray<{ startsAt: Date; endsAt: Date; capacityMinutes: number }>,
  dayStart: Date,
  dayEnd: Date,
  now: Date
): { usable: number | null; remaining: number } {
  const within = (slot: { startsAt: Date; endsAt: Date; capacityMinutes: number }, from: Date) => {
    const length = slot.endsAt.getTime() - slot.startsAt.getTime();
    if (length <= 0) return 0;
    const start = Math.max(slot.startsAt.getTime(), from.getTime());
    const end = Math.min(slot.endsAt.getTime(), dayEnd.getTime());
    return end > start ? (slot.capacityMinutes * (end - start)) / length : 0;
  };
  let usable = 0;
  let remaining = 0;
  // Slots begin at the plan run's own "now", so once that is past local midnight the engine holds
  // nothing about the hours already gone: no whole-day figure exists, and `usable` is null.
  const wholeDay = slots.some((slot) => slot.startsAt.getTime() <= dayStart.getTime());
  for (const slot of slots) {
    usable += within(slot, dayStart);
    remaining += within(slot, new Date(Math.max(now.getTime(), dayStart.getTime())));
  }
  return { usable: wholeDay ? usable : null, remaining };
}
