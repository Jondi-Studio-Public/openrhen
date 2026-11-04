import { InvalidCommandError } from "./command-errors";
import { reassertLocationOnWake } from "./current-situation";
import { localMomentFormatter } from "./local-moment";
import type { Sql } from "./sql-pool";

/**
 * What a night's sleep record needs, shared by every writer of one: the sleep log (`sleep_log_entry` in
 * entity-commands.ts), finishing a sleep session (activity-commands.ts, the "I'm awake" button) and the wake command
 * (wake-command.ts). One copy of each rule, so a night written by any of them is overlap-checked, sized and
 * counted into the last wake the same way.
 */

/**
 * Refuses a logged night [sleepAt, wakeAt) that overlaps another recorded one (`excludeId` is the row being
 * edited, never its own overlap). A night still being slept has no wake yet, so it runs on from its start and
 * blocks any logged night that ends after it began; touching nights (one ends as the next starts) are fine.
 * Without this a second entry for the same hours double-counts the sleep, and the latest wake is whichever
 * was written last.
 */
export async function refuseOverlappingNight(
  tx: Sql,
  userId: string,
  excludeId: string,
  sleepAt: Date,
  wakeAt: Date
): Promise<void> {
  const other = await overlappingNight(tx, userId, [excludeId], sleepAt, wakeAt);
  if (!other) return;
  const local = await localMomentFormatter(tx, userId, new Date());
  if (other.status === "sleeping")
    throw new InvalidCommandError(
      `A sleep started ${local(other.actual_start_at)} is still running (id ${other.id}), and this night overlaps it. Finish the running sleep instead of logging a second night.`
    );
  throw new InvalidCommandError(
    `This night overlaps one already logged, from ${local(other.actual_start_at)} to ${local(other.actual_wake_at!)} (id ${other.id}). To correct that night, update it by its id instead of logging a second one.`
  );
}

export interface RecordedNight {
  id: string;
  status: string;
  actual_start_at: Date;
  actual_wake_at: Date | null;
}

/**
 * The first recorded night, other than the rows `excludeIds` names, that overlaps [sleepAt, wakeAt): the predicate
 * behind `refuseOverlappingNight`, shared with an undo or redo that brings a night back (write-revert.ts). A null
 * `wakeAt` is a night still being slept, which runs on from its start.
 */
export async function overlappingNight(
  tx: Sql,
  userId: string,
  excludeIds: readonly string[],
  sleepAt: Date,
  wakeAt: Date | null
): Promise<RecordedNight | undefined> {
  const [other] = await tx<RecordedNight[]>`SELECT id,status,actual_start_at,actual_wake_at FROM sleep_plans
    WHERE user_id=${userId} AND id::text NOT IN ${tx(excludeIds as string[])}
      AND (${wakeAt}::timestamptz IS NULL OR actual_start_at < ${wakeAt})
      AND ((status='completed' AND actual_wake_at > ${sleepAt}) OR status='sleeping')
    ORDER BY actual_start_at LIMIT 1`;
  return other;
}

/** The last wake the sleep log gives, as text so the comparison in `syncLastWokeAt` is exact; read before a write changes it. */
export async function loggedWakeBefore(tx: Sql, userId: string): Promise<string | null> {
  const [logged] = await tx<
    { wake: string | null }[]
  >`SELECT MAX(actual_wake_at)::text AS wake FROM sleep_plans WHERE user_id=${userId} AND status='completed' AND actual_wake_at IS NOT NULL`;
  return logged?.wake ?? null;
}

/**
 * Derives the last wake from the record rather than the row just written, so editing or removing an entry
 * corrects it and back-dating an older sleep cannot regress it. A wake recorded directly that is newer than the
 * log's (an agent saying when the person woke) is kept unless the log now has a later one: only a value the log
 * itself gave (`loggedBefore`, from `loggedWakeBefore`) is replaced by an earlier one.
 */
export async function syncLastWokeAt(tx: Sql, userId: string, loggedBefore: string | null): Promise<void> {
  await tx`UPDATE user_preferences SET last_woke_at=CASE
      WHEN last_woke_at IS NULL OR last_woke_at IS NOT DISTINCT FROM ${loggedBefore}::timestamptz OR last_woke_at < logged.wake THEN logged.wake
      ELSE last_woke_at END,version=version+1,updated_at=CURRENT_TIMESTAMP
    FROM (SELECT MAX(actual_wake_at) AS wake FROM sleep_plans WHERE user_id=${userId} AND status='completed' AND actual_wake_at IS NOT NULL) logged
    WHERE user_id=${userId}`;
}

/**
 * Creates a hand-logged night: a completed `sleep_plans` row with no live session behind it. The caller has
 * validated the times and run `refuseOverlappingNight`.
 */
export async function insertLoggedNight(
  tx: Sql,
  userId: string,
  id: string,
  sleepAt: Date,
  wakeAt: Date
): Promise<void> {
  const duration = Math.round((wakeAt.getTime() - sleepAt.getTime()) / 60000);
  const prefs = await tx<
    { desired_sleep_minutes: number }[]
  >`SELECT desired_sleep_minutes FROM user_preferences WHERE user_id=${userId}`;
  const desired = prefs[0]?.desired_sleep_minutes ?? duration;
  // Same GREATEST(0, desired - duration) every sibling write below (override, correction, and
  // the live Start/Stop finish in activity-commands.ts) uses. Left out of this INSERT, the
  // column defaulted to 0 and a short hand-logged nap read as "goal met".
  const deficit = Math.max(0, desired - duration);
  await tx`INSERT INTO sleep_plans (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,sleep_deficit_minutes,explanation,status,actual_start_at,actual_wake_at,input_version) VALUES (${id},${userId},${sleepAt},${wakeAt},${desired},${duration},${deficit},'Manually logged sleep.','completed',${sleepAt},${wakeAt},'manual')`;
}

/**
 * Ends a sleep that was being tracked: the plan row becomes `completed` with the real wake, the last wake follows the
 * log (`syncLastWokeAt`), and the last asserted location is re-asserted as of it. `wakeAt` is when the person woke (the session's end,
 * which a retroactive finish chooses) and `now` is real now, which only stamps `updated_at`. `sessionStartedAt` is
 * the fallback start for a plan row that lost its own; `startedAt` replaces the start when the caller was told a
 * truer one.
 *
 * `actual_start_at` is normally written when the session starts, but a plan row rewritten
 * mid-sleep can lose it — and a completed sleep with a wake but no start reads as a window
 * that begins after it ended (observed live). The session
 * row's own started_at is when this sleep actually began, so backfill it defensively; a
 * start already recorded on the row is never overwritten (other than by `startedAt`).
 *
 * allowed_minutes is frozen at the planned allowance the moment tracking starts (see the
 * status='sleeping' branch in activity-commands.ts) and, until now, never moved again — so a night that ran
 * long or short showed the planned length forever, disagreeing with the actual start/wake
 * stamps sitting right next to it. Recompute it here from the real span, mirroring the
 * manual-correction path's GREATEST(0,desired-actual) deficit math in entity-commands.ts
 * exactly. A wake at or before the effective start (a future-dated actual_start_at, clock
 * skew) leaves both fields untouched — the same "unknown" stance
 * completedSleepMinutesEndingAt takes in engine/core/src/engine.ts.
 */
export async function completeSleepPlan(
  tx: Sql,
  userId: string,
  sleepPlanId: string,
  times: { wakeAt: Date; now: Date; sessionStartedAt: Date; startedAt?: Date | undefined }
): Promise<void> {
  const { wakeAt, now, sessionStartedAt, startedAt } = times;
  const loggedBefore = await loggedWakeBefore(tx, userId);
  const plan = await tx<
    { actual_start_at: Date | null }[]
  >`SELECT actual_start_at FROM sleep_plans WHERE id=${sleepPlanId} AND user_id=${userId} FOR UPDATE`;
  const effectiveStart = startedAt ?? plan[0]?.actual_start_at ?? sessionStartedAt;
  const actualMinutes = Math.round((wakeAt.getTime() - effectiveStart.getTime()) / 60000);
  const start = startedAt ?? null;
  if (plan[0] && actualMinutes > 0)
    // `desired_minutes` is read straight off the row (not passed as a parameter) so Postgres
    // can infer the `-` operator's type from the column, the same way entity-commands.ts's
    // manual-correction path does — a JS-side value on both sides of GREATEST leaves Postgres
    // unable to resolve `unknown - unknown` and the update fails outright.
    await tx`UPDATE sleep_plans SET status='completed',actual_wake_at=${wakeAt},actual_start_at=COALESCE(${start}::timestamptz,actual_start_at,${sessionStartedAt}),allowed_minutes=${actualMinutes},sleep_deficit_minutes=GREATEST(0,desired_minutes-${actualMinutes}),version=version+1,updated_at=${now} WHERE id=${sleepPlanId}`;
  else
    await tx`UPDATE sleep_plans SET status='completed',actual_wake_at=${wakeAt},actual_start_at=COALESCE(${start}::timestamptz,actual_start_at,${sessionStartedAt}),version=version+1,updated_at=${now} WHERE id=${sleepPlanId}`;
  // The last wake follows the log, so a back-dated finish never overwrites a newer wake recorded directly.
  await syncLastWokeAt(tx, userId, loggedBefore);
  // Waking is a fresh assertion of the place slept in, so the morning does not begin with the
  // location expired to unanswered and every location-derived capability withdrawn.
  await reassertLocationOnWake(tx, userId, wakeAt);
}
