import type { ClientSlot } from "@/state/portal-provider";

/** The calendar date of an instant in the planning timezone, as YYYY-MM-DD. */
function dayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

/**
 * The rest of today in two numbers, from the plan's own slots: the awake minutes left (everything but
 * time marked unavailable, such as sleep) and how many of them are still free. A slot already under
 * way counts from now. Null when the plan has no slots left today.
 */
export function todayFreeTime(
  slots: readonly ClientSlot[],
  now: Date,
  timezone: string
): { freeMinutes: number; awakeMinutes: number } | null {
  const today = dayKey(now, timezone);
  let free = 0;
  let awake = 0;
  for (const slot of slots) {
    const endsAt = new Date(slot.endsAt).getTime();
    const startsAt = Math.max(new Date(slot.startsAt).getTime(), now.getTime());
    if (endsAt <= startsAt || dayKey(new Date(startsAt), timezone) !== today) continue;
    if (slot.availability === "unavailable") continue;
    const minutes = (endsAt - startsAt) / 60_000;
    awake += minutes;
    if (slot.availability === "free") free += minutes;
  }
  return awake > 0 ? { freeMinutes: Math.round(free), awakeMinutes: Math.round(awake) } : null;
}
