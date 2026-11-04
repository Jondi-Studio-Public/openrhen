import type { ActiveSession, PortalState } from "@/state/portal-state";

/**
 * Minutes a session logged when it ends now (or at `endedAt`), as the person would count them: the
 * closed segments, plus the open one if it is still running. The server holds the real total; this is
 * the same sum for the one-line "Logged 42 min" that follows Save.
 */
export function loggedMinutes(session: ActiveSession, now: Date, endedAt?: string): number {
  let seconds = session.activeElapsedSeconds;
  if (endedAt) {
    // A session awaiting feedback closed its last segment at the checkpoint; a given end replaces it.
    const closedAt = session.feedbackRequestedAt ?? session.segmentStartedAt;
    if (closedAt) seconds += (new Date(endedAt).getTime() - new Date(closedAt).getTime()) / 1000;
  } else if (session.status === "running" && session.segmentStartedAt) {
    seconds += (now.getTime() - new Date(session.segmentStartedAt).getTime()) / 1000;
  }
  return Math.max(0, Math.round(seconds / 60));
}

/** How long "Logged 42 min on X" stays: long enough to read, short enough not to sit over the next decision. */
export const LOGGED_TOAST_MS = 10_000;

/** "Logged 42 min on Write the report." */
export function loggedLine(minutes: number, title: string): string {
  return `Logged ${minutes} min on ${title}`;
}

/**
 * The earliest moment a start can be put back to, as the server will accept it: not before the last
 * recorded wake, not inside the end of an earlier session, and, for a recurring occurrence, not before
 * its window opens. Null when nothing bounds it (the 24 hour limit is applied by the caller).
 */
export function startFloor(
  state: Pick<PortalState, "settings" | "lastEndedSessions" | "completedToday" | "occurrences">,
  occurrenceId?: string
): Date | null {
  const moments = [
    state.settings.lastWokeAt,
    ...state.lastEndedSessions.map((ended) => ended.endedAt),
    // Routine and commitment sessions are not in `lastEndedSessions`, but the server refuses an overlap with any.
    ...state.completedToday.map((done) => done.endedAt),
    state.occurrences.find((item) => item.id === occurrenceId)?.windowStartsAt
  ]
    .filter((moment): moment is string => Boolean(moment))
    .map((moment) => new Date(moment).getTime());
  return moments.length ? new Date(Math.max(...moments)) : null;
}
