import type { Sql } from "./sql-pool";

/**
 * A session command's "now", which never runs backwards across that session's own history.
 *
 * Commands stamp their writes with `new Date()`, and the wall clock can step back between two of them
 * (an NTP correction, WSL resyncing with its Windows host). Closing the open segment at a moment
 * before it started then trips `session_segments_time_check` and aborts the whole save.
 * So the command's clock is the wall clock, or one millisecond past the session's latest recorded
 * boundary (its start and every segment start and end), whichever is later. One millisecond because
 * the check is strict: a segment must end *after* it starts. Every write in the command then uses
 * this one value, so a close can't precede its open and the next segment starts where the last ended.
 *
 * Call it after the session row is locked, and before any write that uses the time.
 */
export async function sessionClock(tx: Sql, sessionId: string, now: Date): Promise<Date> {
  const rows = await tx<
    { latest: Date | null }[]
  >`SELECT GREATEST(s.started_at,MAX(g.started_at),MAX(g.ended_at)) latest FROM sessions s LEFT JOIN session_segments g ON g.session_id=s.id WHERE s.id=${sessionId} GROUP BY s.started_at`;
  const latest = rows[0]?.latest;
  if (!latest || latest.getTime() < now.getTime()) return now;
  return new Date(latest.getTime() + 1);
}
