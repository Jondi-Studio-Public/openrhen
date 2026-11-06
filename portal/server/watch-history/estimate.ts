import { WATCH_SESSION_GAP_MINUTES, type WatchEstimate } from "@openrhen/contracts";

/**
 * Time spent watching, as a range, never a precise number. Pure: instants in, minutes out.
 *
 * Takeout records when a video was started, not how long it was watched, so the length of one watch is
 * bounded by the gap to the next watch:
 * - Events are put in a stable order by `(watchedAt, id)` and split into sessions wherever the gap to the next
 *   exceeds the threshold (120 minutes). The same threshold applies everywhere; it also caps what one watch
 *   can be credited, so a video longer than the threshold is credited at most the threshold.
 * - A watch followed by another in the same session has `gap` minutes to the next one. With its length unknown
 *   (every watch in the first release) it adds `[0, gap]`: it may have been left after a few seconds, or have
 *   filled the whole gap. With a known length `d` it adds `min(gap, d)` to both ends.
 * - The last watch of a session has no next watch to bound it. Unknown length: it adds nothing and is counted in
 *   `unknownCount`. Known length `d`: `[0, min(d, threshold)]`.
 * - Zero gaps (same-second watches) add zero.
 *
 * The high end counts every gap in full, so the estimate leans high (seeks, pauses, background play and
 * rewatches all make the real figure lower or overlap); `midMin` is the midpoint of the range. The range is
 * computed over the instants given, so a day's figure is not the sum of its sessions' parts when a session
 * straddles midnight: callers estimate a whole range, not each day.
 */
export interface EstimateEvent {
  id: string;
  watchedAt: Date;
  /** The video's length in seconds when known; null until a length lookup has filled it. */
  durationS?: number | null;
}

export function estimateWatchTime(
  events: readonly EstimateEvent[],
  gapMinutes = WATCH_SESSION_GAP_MINUTES
): WatchEstimate {
  const thresholdMs = gapMinutes * 60_000;
  const sorted = [...events].sort(
    (a, b) => a.watchedAt.getTime() - b.watchedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  let lowMs = 0;
  let highMs = 0;
  let sessions = 0;
  let unknownCount = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i]!;
    const next = sorted[i + 1];
    const gap = next ? next.watchedAt.getTime() - current.watchedAt.getTime() : Number.POSITIVE_INFINITY;
    const startsSession = i === 0 || current.watchedAt.getTime() - sorted[i - 1]!.watchedAt.getTime() > thresholdMs;
    if (startsSession) sessions += 1;
    const lengthMs = typeof current.durationS === "number" && current.durationS >= 0 ? current.durationS * 1000 : null;
    if (gap <= thresholdMs) {
      if (lengthMs === null) highMs += gap;
      else {
        const credit = Math.min(gap, lengthMs);
        lowMs += credit;
        highMs += credit;
      }
    } else if (lengthMs === null) {
      unknownCount += 1;
    } else {
      highMs += Math.min(lengthMs, thresholdMs);
    }
  }
  const lowMin = Math.round(lowMs / 60_000);
  const highMin = Math.round(highMs / 60_000);
  return { lowMin, highMin, midMin: Math.round((lowMin + highMin) / 2), videos: sorted.length, sessions, unknownCount };
}
