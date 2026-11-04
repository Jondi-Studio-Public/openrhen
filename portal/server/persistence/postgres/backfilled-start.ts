import { InvalidCommandError, notFound } from "./command-errors";
import { localMomentFormatter } from "./local-moment";
import type { Sql } from "./sql-pool";

/** Same grace as the sleep log's wake: it absorbs the minute-resolution picker and small clock skew. */
export const BACKFILL_FUTURE_GRACE_MS = 5 * 60_000;
export const BACKFILL_MAX_BACK_MS = 24 * 3_600_000;

export interface ResolvedStart {
  /** When the work actually began: `startedAt` when backfilling, otherwise real now. */
  startTime: Date;
  /** True only when the session starts in the past and must carry `started_recorded_at`. */
  backfilled: boolean;
}

/**
 * Validates an optional past `startedAt` and says when the
 * session really starts. Absent: now. Otherwise starts at
 * `startedAt`, stamped `started_recorded_at`.
 */
export async function resolveBackfilledStart(
  tx: Sql,
  userId: string,
  input: { commandId: string; startedAt: string | undefined; targetType: string; targetId: string },
  now: Date
): Promise<ResolvedStart> {
  if (!input.startedAt) return { startTime: now, backfilled: false };
  if (input.targetType === "sleep")
    throw new InvalidCommandError(
      `A sleep cannot be started in the past. Log the night with rhen_save {"entityType":"sleep_log_entry","fields":{"sleepAt":"<ISO time with offset>","wakeAt":"<ISO time with offset>"}}.`
    );
  const { startTime } = await checkBackfilledStart(tx, userId, input.startedAt, now);
  return { startTime, backfilled: startTime.getTime() < now.getTime() };
}

/** Every bound a past start must meet; returns the start to use (clamped to now inside the grace). */
async function checkBackfilledStart(
  tx: Sql,
  userId: string,
  startedAt: string,
  now: Date,
  excludeSessionId?: string
): Promise<{ startTime: Date }> {
  const requested = new Date(startedAt);
  if (requested.getTime() > now.getTime() + BACKFILL_FUTURE_GRACE_MS)
    throw new InvalidCommandError(
      `The start time ${startedAt} cannot be more than 5 minutes in the future. Repeat the call with an earlier time, or leave started-at out for now.`
    );
  if (requested.getTime() < now.getTime() - BACKFILL_MAX_BACK_MS)
    throw new InvalidCommandError(
      `The start time ${startedAt} is more than 24 hours ago, which is the limit. Repeat the call with a later time.`
    );
  const woke = await tx<
    { last_woke_at: Date | null }[]
  >`SELECT last_woke_at FROM user_preferences WHERE user_id=${userId}`;
  const lastWokeAt = woke[0]?.last_woke_at ?? null;
  if (lastWokeAt && requested.getTime() < lastWokeAt.getTime()) {
    const local = await localMomentFormatter(tx, userId, now);
    throw new InvalidCommandError(
      `The start time cannot be before your last recorded wake (${local(lastWokeAt)}). Repeat the call with a later time.`
    );
  }
  const overlap = await tx<
    { id: string; ended_at: Date }[]
  >`SELECT id, ended_at FROM sessions WHERE user_id=${userId} AND ended_at > ${requested} AND id IS DISTINCT FROM ${excludeSessionId ?? null} ORDER BY ended_at DESC LIMIT 1`;
  if (overlap[0]) {
    const local = await localMomentFormatter(tx, userId, now);
    throw new InvalidCommandError(
      `The start time overlaps an earlier session (id ${overlap[0].id}) that ended at ${local(overlap[0].ended_at)}. ` +
        `Repeat the call with started-at later than ${local(overlap[0].ended_at)}` +
        `, or leave started-at out to start now. A finished session cannot be edited; if the earlier one was a wrong write, ` +
        `reverse it with rhen_undo {"list": true} and then rhen_undo {"id": "<its entry>"}.`
    );
  }
  // A start inside the grace after now is clamped so no segment begins in the future.
  return { startTime: requested.getTime() > now.getTime() ? now : requested };
}

export interface CorrectedStart {
  startTime: Date;
  /** How far the start moves (negative: earlier). */
  shiftMs: number;
  /** A running session's planned end moves by the same amount; a paused one's does not. */
  movesPlannedEnd: boolean;
  firstSegmentId: string | null;
}

/**
 * Validates moving the start of the open session `sessionId` to `startedAt` (the design notes,
 * "Correcting a start already made"): the same switch and bounds as a past start, except the session is never
 * its own overlap. Needs the switch on. The caller writes the move (session-commands.ts).
 */
export async function resolveCorrectedStart(
  tx: Sql,
  userId: string,
  command: { sessionId: string; startedAt: string },
  now: Date
): Promise<CorrectedStart> {
  const rows = await tx<
    { target_type: string | null; status: string; started_at: Date | null; planned_end_at: Date }[]
  >`SELECT target_type, status, started_at, planned_end_at FROM sessions WHERE id=${command.sessionId} AND user_id=${userId}`;
  const session = rows[0];
  if (!session?.started_at) throw notFound("session", command.sessionId);
  if (session.target_type === "sleep")
    throw new InvalidCommandError(
      `A sleep's start cannot be corrected here. Log the night with rhen_save {"entityType":"sleep_log_entry","fields":{"sleepAt":"<ISO time with offset>","wakeAt":"<ISO time with offset>"}}.`
    );
  const { startTime } = await checkBackfilledStart(tx, userId, command.startedAt, now, command.sessionId);
  const first = await tx<
    { id: string; ended_at: Date | null }[]
  >`SELECT id, ended_at FROM session_segments WHERE session_id=${command.sessionId} ORDER BY started_at LIMIT 1`;
  if (first[0]?.ended_at && startTime.getTime() >= first[0].ended_at.getTime()) {
    const local = await localMomentFormatter(tx, userId, now);
    throw new InvalidCommandError(
      `The start time must be before the session's first pause or stop (${local(first[0].ended_at)}).`
    );
  }
  return {
    startTime,
    shiftMs: startTime.getTime() - session.started_at.getTime(),
    movesPlannedEnd: session.status === "running",
    firstSegmentId: first[0]?.id ?? null
  };
}
