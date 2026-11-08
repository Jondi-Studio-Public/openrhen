import { zonedDateTime } from "../zoned-time.js";
import { addLocalDays, localDateOf } from "./cadence-due.js";
import type { PersonPresence } from "./context-model.js";

/**
 * The start of the owner's next local day after `instant`: the moment a day-scoped "Pete is here" stops
 * being true. Computed on the local calendar, not by adding 24 hours, so a 23- or 25-hour day around a
 * clock change still ends at its own midnight. The owner's timezone decides the day, never UTC.
 */
export function nextLocalMidnight(instant: Date, timeZone: string): Date {
  return zonedDateTime(addLocalDays(localDateOf(instant, timeZone), 1), "00:00", timeZone);
}

/** A fresh server stamp for something the owner just said about a person: now, until the end of their day. */
export function stampPresence(state: PersonPresence["state"], now: Date, timeZone: string): PersonPresence {
  return { state, setAt: now.toISOString(), until: nextLocalMidnight(now, timeZone).toISOString() };
}

/**
 * Whether a stored statement still holds at `now`. It ends at the stored `until` or at the end of the local
 * day it was said on in `timeZone`, whichever is first, so a change of timezone can shorten it but never
 * stretch it into a day the owner did not mean. With no timezone to hand only the stored end applies. A record that does not parse, or ends before it began, holds
 * at no time: an expired or damaged "here" must read as unknown, never as yes.
 */
export function presenceHolds(entry: PersonPresence, now: Date, timeZone?: string): boolean {
  const setAt = Date.parse(entry.setAt);
  const until = Date.parse(entry.until);
  if (Number.isNaN(setAt) || Number.isNaN(until) || until <= setAt) return false;
  // Without a timezone the stored end stands: the server stamped it in the owner's, and guessing UTC here
  // could cut a day short.
  const end = timeZone ? Math.min(until, nextLocalMidnight(new Date(setAt), timeZone).getTime()) : until;
  return now.getTime() >= setAt && now.getTime() < end;
}
