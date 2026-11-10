import { InvalidCommandError } from "./command-errors";
import { sessionMomentFormatter } from "./local-moment";
import type { Sql } from "./sql-pool";
import type { WriteSnapshot } from "./write-snapshot";

/**
 * The segment a retroactive end moves, locked: a running session's open one, or the last one of a
 * session awaiting feedback, which `request_feedback` closed at the checkpoint.
 */
async function endingSegment(
  tx: Sql,
  session: { id: string; status: string }
): Promise<{ id: string; started_at: Date; ended_at: Date | null } | undefined> {
  const rows =
    session.status === "awaiting_feedback"
      ? await tx<
          { id: string; started_at: Date; ended_at: Date | null }[]
        >`SELECT id, started_at, ended_at FROM session_segments WHERE session_id=${session.id} ORDER BY started_at DESC LIMIT 1 FOR UPDATE`
      : await tx<
          { id: string; started_at: Date; ended_at: Date | null }[]
        >`SELECT id, started_at, ended_at FROM session_segments WHERE session_id=${session.id} AND ended_at IS NULL FOR UPDATE`;
  return rows[0];
}

/**
 * The latest a session awaiting feedback can be said to have ended, or null when only now bounds it. Its
 * checkpoint segment may run on past where it stopped only when `request_feedback` itself closed it
 * early, at the planned end because the page opened late, while the person may have kept working. A
 * segment closed by a pause (the session still carries its `paused_remaining_seconds`) or at the moment
 * feedback was asked for ended when it was seen to end, so a given time can only move it earlier.
 */
async function checkpointCeiling(tx: Sql, sessionId: string, segmentEnd: Date | null): Promise<Date | null> {
  if (!segmentEnd) return null;
  const rows = await tx<
    { feedback_requested_at: Date | null; paused_remaining_seconds: number | null }[]
  >`SELECT feedback_requested_at, paused_remaining_seconds FROM sessions WHERE id=${sessionId}`;
  const row = rows[0];
  const closedEarly =
    row?.paused_remaining_seconds === null &&
    row.feedback_requested_at !== null &&
    row.feedback_requested_at.getTime() > segmentEnd.getTime();
  return closedEarly ? null : segmentEnd;
}

/**
 * When a finished session really ended (the session reconciliation design note, "Two clocks"
 * and "Bounds"). Absent `endedAt`: real now. Given: it takes over from now everywhere the session's
 * own end is recorded (the segment close, `sessions.ended_at`, `active_minutes`, the target's
 * `last_worked_at`), while now stays on `updated_at` and marks `ended_recorded_at`. It must fall after
 * the start of the segment it ends and no later than now. A running session takes one, closing its open
 * segment there. So does one awaiting feedback, whose last segment `request_feedback` closed at the
 * checkpoint (the planned end if the page opened late): the given time replaces that segment's end
 * (`replaceCheckpointEnd`), and runs past it only after a late checkpoint (`checkpointCeiling`). A paused
 * session cannot: its end is its pause, already recorded, and that holds once it awaits feedback too.
 *
 * Shared by `finish_activity` and the action session's own `finish`, so a past session can be closed
 * through whichever command owns its target, and never through the other one's branch.
 *
 * `endAtPause` (catch-up settling a session forgotten while paused, `catch-up.ts`): with no `endedAt`, a
 * session with no open segment ends where its last segment closed, the pause, rather than now.
 */
export async function resolveRetroactiveEnd(
  tx: Sql,
  session: { id: string; status: string; started_at: Date },
  endedAt: string | undefined,
  now: Date,
  endAtPause = false
): Promise<Date> {
  if (!endedAt) {
    if (!endAtPause) return now;
    const rows = await tx<
      { open: number; paused_at: Date | null }[]
    >`SELECT count(*) FILTER (WHERE ended_at IS NULL)::int AS open, max(ended_at) AS paused_at FROM session_segments WHERE session_id=${session.id}`;
    return rows[0] && rows[0].open === 0 && rows[0].paused_at ? rows[0].paused_at : now;
  }
  if (session.status !== "running" && session.status !== "awaiting_feedback")
    throw new InvalidCommandError(
      session.status === "paused"
        ? "A paused session cannot be given a retroactive end time; its end is the pause, already recorded."
        : "Only a running session, or one awaiting feedback, can be given a retroactive end time."
    );
  const requested = new Date(endedAt);
  const segment = await endingSegment(tx, session);
  const floor = segment?.started_at ?? session.started_at;
  if (requested.getTime() <= floor.getTime()) {
    const local = await sessionMomentFormatter(tx, session.id, now);
    throw new InvalidCommandError(`The end time must be after ${local(floor)}.`);
  }
  if (requested.getTime() > now.getTime()) throw new InvalidCommandError("The end time cannot be later than now.");
  const ceiling =
    session.status === "awaiting_feedback" ? await checkpointCeiling(tx, session.id, segment?.ended_at ?? null) : null;
  if (ceiling && requested.getTime() > ceiling.getTime()) {
    const local = await sessionMomentFormatter(tx, session.id, now);
    throw new InvalidCommandError(
      `The end time cannot be later than ${local(ceiling)}, when this session stopped; give an earlier time or finish without one.`
    );
  }
  return requested;
}

/**
 * Moves the end of the segment a session awaiting feedback closed at the checkpoint to the retroactive
 * end `resolveRetroactiveEnd` accepted, so the minutes its segments sum to follow it. A running session
 * needs none of this: its open segment is closed at the end directly. `snap` is the agent's write
 * snapshot, taken before the row changes.
 */
export async function replaceCheckpointEnd(
  tx: Sql,
  sessionId: string,
  endTime: Date,
  snap?: WriteSnapshot | null
): Promise<void> {
  const segment = await endingSegment(tx, { id: sessionId, status: "awaiting_feedback" });
  if (!segment) return;
  await snap?.before("session_segments", [segment.id]);
  await tx`UPDATE session_segments SET ended_at=${endTime} WHERE id=${segment.id}`;
}

/**
 * Closes the open session `session` at `endTime` and returns the minutes its segments add up to. A running
 * session's open segment ends there; one awaiting feedback has its checkpoint segment moved there when the end was
 * given (`retroactive`). `at` (real now) stays on `updated_at`, and marks `ended_recorded_at` for a given end.
 * Shared by `finish_activity` and the wake command, so a sleep ended by either closes the same way.
 */
export async function closeOpenSession(
  tx: Sql,
  session: { id: string; status: string },
  close: {
    endTime: Date;
    retroactive: boolean;
    terminal: string;
    note: string | null;
    at: Date;
    /** The owner's claimed time for this end and why it was not used (null when it was), kept on the segment. */
    claim?: { at: Date; note: string | null } | undefined;
  }
): Promise<number> {
  if (session.status === "running")
    await tx`UPDATE session_segments SET ended_at=${close.endTime}, end_occurred_at=${close.claim?.at ?? null}, end_occurred_note=${close.claim?.note ?? null} WHERE session_id=${session.id} AND ended_at IS NULL`;
  else if (session.status === "awaiting_feedback" && close.retroactive)
    await replaceCheckpointEnd(tx, session.id, close.endTime);
  const totals = await tx<
    { seconds: number }[]
  >`SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at-started_at))),0)::int seconds FROM session_segments WHERE session_id=${session.id} AND ended_at IS NOT NULL`;
  const minutes = Math.round((totals[0]?.seconds ?? 0) / 60);
  await tx`UPDATE sessions SET status=${close.terminal},ended_at=${close.endTime},active_minutes=${minutes},remaining_after_minutes=0,result_note=${close.note},ended_recorded_at=${close.retroactive ? close.at : null},version=version+1,updated_at=${close.at} WHERE id=${session.id}`;
  return minutes;
}
