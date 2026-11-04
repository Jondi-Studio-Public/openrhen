import { InvalidCommandError } from "./command-errors";
import type { Sql } from "./sql-pool";

type SleepSessionEdit = { startedAt: Date; endedAt?: Date } | { remove: true };

/**
 * Keeps the `sessions`/`session_segments` rows linked to a sleep plan in sync with an edit made
 * through the sleep log or the wake command.
 *
 * A night recorded live via Start/Stop on Now has one `sessions` row (`target_type='sleep'`,
 * `target_id=sleepPlanId`, see activity-commands.ts) and one `session_segments` row under it per stretch
 * slept: a sleep paused and resumed has several, and the gaps between them are the pauses. A new start moves
 * only the earliest segment's start and a new end only the latest segment's end, so the pauses stay where
 * they were and `active_minutes` stays the sum of the segments. A start alone on a session already closed keeps
 * the end it was closed with and recounts the segments. A start after the first pause began, or an end
 * before the last stretch began, would swallow a segment whole, so it is refused; so is a start alone past the
 * pause that ended a sleep of one stretch. A hand-logged
 * (`input_version='manual'`) night never has a session, so this is a no-op for it — there is nothing to look up.
 *
 * This deliberately makes sleep sessions mutable, unlike every other session — which
 * portal/app/history/page.tsx describes as immutable planning evidence. The trade-off is accepted
 * on purpose: a wrong sleep record actively degrades future planning, because it feeds
 * completedSleepMinutesEndingAt/deriveSleepPlans in engine/core/src/engine.ts. Leaving a bad night on
 * the books would be worse than bending the immutability rule for this one target type.
 */
export async function syncSleepSession(
  tx: Sql,
  userId: string,
  sleepPlanId: string,
  edit: SleepSessionEdit
): Promise<void> {
  const rows = await tx<
    { id: string; ended_at: Date | null }[]
  >`SELECT id,ended_at FROM sessions WHERE user_id=${userId} AND target_type='sleep' AND target_id=${sleepPlanId} FOR UPDATE`;
  const session = rows[0];
  if (!session) return;
  if ("remove" in edit) {
    // session_segments cascades via its own FK (schema.ts, session_segments.session_id, onDelete: "cascade").
    await tx`DELETE FROM sessions WHERE id=${session.id}`;
    return;
  }
  const segments = await tx<
    { id: string; started_at: Date; ended_at: Date | null }[]
  >`SELECT id,started_at,ended_at FROM session_segments WHERE session_id=${session.id} ORDER BY started_at FOR UPDATE`;
  const first = segments[0];
  const last = segments.at(-1);
  const paused = segments.length > 1;
  // One stretch given both ends moves as a whole; otherwise the first stretch keeps the end it has.
  const whole = !paused && edit.endedAt !== undefined;
  if (!whole && first?.ended_at && edit.startedAt.getTime() >= first.ended_at.getTime())
    throw new InvalidCommandError(
      paused
        ? "This sleep was paused and resumed, so it cannot have started after its first pause began. Give an earlier start."
        : "This sleep was paused, so it cannot have started after the pause began. Give an earlier start."
    );
  if (paused && edit.endedAt && last && edit.endedAt.getTime() <= last.started_at.getTime())
    throw new InvalidCommandError(
      "This sleep was paused and resumed, so it cannot have ended before its last stretch began. Give a later wake."
    );
  // In one statement, so a night moved past its old wake (01:00-02:00 to 03:00-04:00) never stands with its start
  // after its end, which `session_segments_time_check` refuses.
  if (whole && first)
    await tx`UPDATE session_segments SET started_at=${edit.startedAt},ended_at=${edit.endedAt!} WHERE id=${first.id}`;
  else {
    if (first) await tx`UPDATE session_segments SET started_at=${edit.startedAt} WHERE id=${first.id}`;
    if (edit.endedAt && last) await tx`UPDATE session_segments SET ended_at=${edit.endedAt} WHERE id=${last.id}`;
  }
  const endedAt = edit.endedAt ?? session.ended_at;
  if (endedAt) {
    const totals = await tx<
      { seconds: number }[]
    >`SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at-started_at))),0)::int seconds FROM session_segments WHERE session_id=${session.id} AND ended_at IS NOT NULL`;
    const activeMinutes = Math.max(0, Math.round((totals[0]?.seconds ?? 0) / 60));
    await tx`UPDATE sessions SET started_at=${edit.startedAt},ended_at=${endedAt},active_minutes=${activeMinutes},updated_at=CURRENT_TIMESTAMP WHERE id=${session.id}`;
  } else {
    await tx`UPDATE sessions SET started_at=${edit.startedAt},updated_at=CURRENT_TIMESTAMP WHERE id=${session.id}`;
  }
}
