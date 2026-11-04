import { SPAN_STATE_BOUND_DAYS } from "@openrhen/contracts";
import { nextDayKey, zonedDayStart } from "@/features/today/local-datetime";
import { localDayKey } from "@/features/today/today-view";

/**
 * How far back the two history-bearing collections in the state document reach.
 *
 * Neither was bounded at all, and both are read on every command and every poll, so the document —
 * and the work of building it — grew without limit for the life of the install. A bound is therefore
 * not optional; the only question is where it goes. A single local day would be the tightest reading
 * of `completedToday`'s name, but `/history` and the Schedule tab's backward paging both render
 * straight out of these two collections, so a one-day window would empty both surfaces and read as
 * data loss. A month keeps every surface truthful, keeps the document flat, and is one constant to
 * move if either answer changes.
 *
 * This lives here, not in the server-only read path, because more than one consumer now has to agree
 * on the same boundary: the read itself, the whole-state write-back's own delete scope, and any
 * client component (like `/review`'s series-adherence count) that has to stop expecting evidence the
 * read can no longer see.
 */
export const HISTORY_WINDOW_DAYS = 30;

/**
 * How far forward materialised occurrences are carried. No forward reader needs anything near this:
 * the forecast job only ever materialises fourteen days out (`OCCURRENCE_HORIZON_MS`), and the
 * engine's `prepare()` (`engine/core/src/engine.ts`) — the only thing that turns a pending
 * occurrence into something schedulable — synthesises actions from occurrences seven days out. It
 * sits instead at the engine's own forecast horizon (`horizonEnd` in `buildPlanForecastRequest`),
 * because nothing past that is planned against at all: the read discards nothing any consumer can
 * see today, and still caps a future materialiser that runs away.
 */
export const OCCURRENCE_FUTURE_DAYS = 180;

/**
 * Local midnight, not "now minus N×24h": the day a session belongs to is the calendar day the person
 * lived it in, and a clock change must not shorten or lengthen the window's first day.
 */
export function historyWindowStart(now: Date, timezone: string): Date {
  return zonedDayStart(nextDayKey(localDayKey(now, timezone), -HISTORY_WINDOW_DAYS), timezone);
}

/** The half-open `[from, to)` instant range `/api/state` bounds occurrences to. */
export function occurrenceWindow(now: Date, timezone: string): { from: Date; to: Date } {
  return {
    from: historyWindowStart(now, timezone),
    to: new Date(now.getTime() + OCCURRENCE_FUTURE_DAYS * 86_400_000)
  };
}

/**
 * The inclusive local-day range of spans `/api/state` carries (the design notes, "Read
 * path and bounds"): any span overlapping it is read. Spans are few and small, so this reaches a year
 * either side of today, far past the session window, and a trip older than `HISTORY_WINDOW_DAYS` still
 * shows on the calendar.
 */
export function spanReadRange(now: Date, timezone: string): { from: string; to: string } {
  const today = localDayKey(now, timezone);
  return { from: nextDayKey(today, -SPAN_STATE_BOUND_DAYS), to: nextDayKey(today, SPAN_STATE_BOUND_DAYS) };
}
