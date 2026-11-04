import { WAKE_MAX_BACK_HOURS, type WakeCommand, type WakeResult } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { BACKFILL_FUTURE_GRACE_MS } from "./backfilled-start";
import { claimCommandReceipt, commandRequestHash, hasCommandReceipt } from "./command-receipt";
import { InvalidCommandError } from "./command-errors";
import { reassertLocationOnWake } from "./current-situation";
import { ensureUser } from "./ensure-user";
import { localMomentFormatter } from "./local-moment";
import { holdPlanForecastPublication, recordStateChange } from "./planning-evidence";
import { closeOpenSession, resolveRetroactiveEnd } from "./retroactive-end";
import { sessionClock } from "./session-clock";
import { syncSleepSession } from "./sleep-session-sync";
import {
  completeSleepPlan,
  insertLoggedNight,
  loggedWakeBefore,
  refuseOverlappingNight,
  syncLastWokeAt
} from "./sleep-wake";
import { readStateAfterCommit } from "./read-after-commit";
import type { PoolSql, Sql } from "./sql-pool";
import { WriteSnapshot } from "./write-snapshot";

/**
 * `rhen wake [--at <time>] [--slept-at <time>]`: when the
 * person woke is an observation, and this settles last night around it in one transaction, so the sleep record
 * and `lastWokeAt` cannot disagree. Exactly one of three things happens, the first that applies:
 *
 * 1. A sleep that is running (or paused, or awaiting feedback) finishes at the wake: the "I'm awake" path, given a
 *    time (`finish_activity` in activity-commands.ts, which shares `closeOpenSession` and `completeSleepPlan`).
 *    A given `sleptAt` also moves the start the person pressed Start at to when they really fell asleep.
 * 2. Otherwise last night's planned sleep is completed with the wake, and with `sleptAt` as its start, or when
 *    none is given the planned start, which is then an assumption (`startAssumed`). A plan the engine re-drew
 *    from a missed start (`replannedFromMissedStart`) is not last night's: its start is the moment of the replan.
 * 3. Otherwise a night is logged as the sleep log does, which needs `sleptAt`. Its overlap guard
 *    (`refuseOverlappingNight`) refuses a second night for hours already recorded, so a repeated wake is refused
 *    rather than doubled.
 *
 * The wake moves `lastWokeAt` as the sleep log does (`syncLastWokeAt`): it is the latest recorded wake.
 *
 * An agent's wake keeps the rows it changes (`WriteSnapshot`, kind `wake`): the sleep plan, the sleep session and its
 * segment, and the last wake and place on the settings row. One `POST /api/commands/revert` puts all of them back,
 * or, for a night the wake logged, takes it away again, so a wake is undone whole or not at all.
 */

const MAX_BACK_MS = WAKE_MAX_BACK_HOURS * 3_600_000;

/** A past moment from the caller, within the window; a moment inside the clock-skew grace after now counts as now. */
function pastMoment(
  requested: string | undefined,
  now: Date,
  what: string,
  local: (moment: Date) => string
): Date | undefined {
  if (requested === undefined) return undefined;
  const moment = new Date(requested);
  if (moment.getTime() > now.getTime() + BACKFILL_FUTURE_GRACE_MS)
    throw new InvalidCommandError(
      `The ${what} ${requested} cannot be more than 5 minutes in the future (it is now ${local(now)}). Repeat the call with an earlier time, or leave it out for now.`
    );
  if (moment.getTime() < now.getTime() - MAX_BACK_MS)
    throw new InvalidCommandError(
      `The ${what} ${requested} is more than ${WAKE_MAX_BACK_HOURS} hours ago, which is the limit here. Log an older night with rhen_save {"entityType":"sleep_log_entry","fields":{"sleepAt":"<ISO time with offset>","wakeAt":"<ISO time with offset>"}}.`
    );
  return moment.getTime() > now.getTime() ? now : moment;
}

interface OpenSleep {
  id: string;
  status: string;
  started_at: Date;
  target_id: string;
}

/** Step 1: finishes the running sleep at the wake. */
async function finishRunningSleep(
  tx: Sql,
  userId: string,
  command: WakeCommand,
  open: OpenSleep,
  wakeAt: Date | undefined,
  sleptAt: Date | undefined,
  now: Date,
  local: (moment: Date) => string,
  snap: WriteSnapshot | null
): Promise<{ result: WakeResult; at: Date }> {
  // Never runs backwards across the session's own history, like every session command.
  const at = await sessionClock(tx, open.id, now);
  const endTime = await resolveRetroactiveEnd(tx, open, wakeAt?.toISOString(), at);
  if (sleptAt) {
    if (sleptAt.getTime() >= endTime.getTime())
      throw new InvalidCommandError(
        `The wake (${endTime.toISOString()}) must be after the time slept (${sleptAt.toISOString()}). Repeat the call with a later wake or an earlier slept-at.`
      );
    // The same bounds as correcting a running sleep's start through the sleep log.
    const [previous] = await tx<
      { wake: Date | null }[]
    >`SELECT MAX(actual_wake_at) AS wake FROM sleep_plans WHERE user_id=${userId} AND status='completed' AND id<>${open.target_id}`;
    if (previous?.wake && sleptAt < previous.wake)
      throw new InvalidCommandError(
        `The time slept (${sleptAt.toISOString()}) cannot be before your last recorded wake (${local(previous.wake)}). Repeat the call with a later slept-at.`
      );
  }
  await snap?.before("sessions", [open.id]);
  const segments = await tx<{ id: string }[]>`SELECT id FROM session_segments WHERE session_id=${open.id}`;
  await snap?.before(
    "session_segments",
    segments.map((segment) => segment.id)
  );
  await snap?.before("sleep_plans", [open.target_id]);
  await snap?.before("user_preferences", [userId]);
  await closeOpenSession(tx, open, {
    endTime,
    retroactive: command.at !== undefined,
    terminal: "completed",
    note: null,
    at
  });
  await completeSleepPlan(tx, userId, open.target_id, {
    wakeAt: endTime,
    now: at,
    sessionStartedAt: open.started_at,
    startedAt: sleptAt
  });
  // Only the start moves: the close already put the end where it belongs, and a paused sleep's segments keep their
  // pause as their end rather than stretching to the wake.
  if (sleptAt) await syncSleepSession(tx, userId, open.target_id, { startedAt: sleptAt });
  const [plan] = await tx<
    { actual_start_at: Date | null }[]
  >`SELECT actual_start_at FROM sleep_plans WHERE id=${open.target_id} AND user_id=${userId}`;
  return {
    result: {
      outcome: "finished_session",
      sleepPlanId: open.target_id,
      sleptAt: (plan?.actual_start_at ?? open.started_at).toISOString(),
      wokeAt: endTime.toISOString(),
      startAssumed: false
    },
    at
  };
}

/**
 * Steps 2 and 3: nothing is running, so complete last night's planned sleep or log the night. With no start planned
 * or told (the usual case after a break), only the wake is recorded.
 */
async function settleNight(
  tx: Sql,
  userId: string,
  command: WakeCommand,
  wakeAt: Date,
  sleptAt: Date | undefined,
  now: Date,
  local: (moment: Date) => string,
  snap: WriteSnapshot | null
): Promise<WakeResult> {
  await snap?.before("user_preferences", [userId]);
  const loggedBefore = await loggedWakeBefore(tx, userId);
  // Last night's plan: the latest planned sleep that began before the wake (within the window), and, when the start
  // is given, one that reaches past it. A plan re-drawn from a missed start begins at the moment of the replan, so
  // it is no evidence of when the night began.
  const earliest = new Date(wakeAt.getTime() - MAX_BACK_MS);
  const [planned] = await tx<{ id: string; planned_start_at: Date }[]>`SELECT id,planned_start_at FROM sleep_plans
    WHERE user_id=${userId} AND status='planned' AND planned_start_at < ${wakeAt} AND planned_start_at >= ${earliest}
      AND COALESCE(score_components->>'replannedFromMissedStart','false') <> 'true'
      ${sleptAt ? tx`AND planned_wake_at > ${sleptAt}` : tx``}
    ORDER BY planned_start_at DESC LIMIT 1 FOR UPDATE`;

  let result: WakeResult;
  if (planned) {
    const start = sleptAt ?? planned.planned_start_at;
    await snap?.before("sleep_plans", [planned.id]);
    await refuseOverlappingNight(tx, userId, planned.id, start, wakeAt);
    const minutes = Math.round((wakeAt.getTime() - start.getTime()) / 60000);
    // The plan's own times stay as the evidence of what the engine scheduled; only what happened moves.
    await tx`UPDATE sleep_plans SET status='completed',actual_start_at=${start},actual_wake_at=${wakeAt},allowed_minutes=${minutes},sleep_deficit_minutes=GREATEST(0,desired_minutes-${minutes}),version=version+1,updated_at=${now} WHERE id=${planned.id}`;
    result = {
      outcome: "completed_plan",
      sleepPlanId: planned.id,
      sleptAt: start.toISOString(),
      wokeAt: wakeAt.toISOString(),
      startAssumed: sleptAt === undefined
    };
  } else if (!sleptAt) {
    // The question was when the person woke, so that alone settles it: the wake is recorded as the settings save of
    // `lastWokeAt` records it, and no night is logged, there being no start to log one from. It never moves the last
    // wake back, and the place is not re-asserted, since nothing says where the night was spent.
    const [prefs] = await tx<
      { last_woke_at: Date | null }[]
    >`SELECT last_woke_at FROM user_preferences WHERE user_id=${userId} FOR UPDATE`;
    if (prefs?.last_woke_at && prefs.last_woke_at.getTime() > wakeAt.getTime())
      throw new InvalidCommandError(
        `The last wake on record, ${local(prefs.last_woke_at)}, is later than this one, so it stays. ` +
          "To log a night, give --slept-at as well."
      );
    await tx`UPDATE user_preferences SET last_woke_at=${wakeAt},version=version+1,updated_at=${now} WHERE user_id=${userId}`;
    return { outcome: "recorded_wake", wokeAt: wakeAt.toISOString() };
  } else {
    // Logged under the command's own id, as a `sleep_log_entry` created with that id would be.
    const id = command.commandId;
    await refuseOverlappingNight(tx, userId, id, sleptAt, wakeAt);
    await insertLoggedNight(tx, userId, id, sleptAt, wakeAt);
    snap?.inserted("sleep_plans", [id]);
    result = {
      outcome: "logged_night",
      sleepPlanId: id,
      sleptAt: sleptAt.toISOString(),
      wokeAt: wakeAt.toISOString(),
      startAssumed: false
    };
  }
  // A wake is a fresh assertion of the place slept in, as in every other path that records one.
  await reassertLocationOnWake(tx, userId, wakeAt);
  await syncLastWokeAt(tx, userId, loggedBefore);
  return result;
}

/**
 * The wake inside the caller's transaction, after its receipt is claimed and the publication lock is held: the rows
 * it changes go into `snap` (the caller saves it), and the caller files the change log row at the returned `at`.
 * Catch-up settles a stale wake through this, so a settle and `rhen wake` cannot record a morning differently.
 */
export async function applyWakeCommand(
  tx: Sql,
  userId: string,
  command: WakeCommand,
  now: Date,
  snap: WriteSnapshot | null
): Promise<{ result: WakeResult; at: Date }> {
  const local = await localMomentFormatter(tx, userId, now);
  const wakeAt = pastMoment(command.at, now, "wake time", local);
  const sleptAt = pastMoment(command.sleptAt, now, "time slept", local);
  if (sleptAt && sleptAt.getTime() >= (wakeAt ?? now).getTime())
    throw new InvalidCommandError(
      `The wake must be after the time slept (${sleptAt.toISOString()}). Repeat the call with a later wake time.`
    );

  const [open] = await tx<
    OpenSleep[]
  >`SELECT id,status,started_at,target_id FROM sessions WHERE user_id=${userId} AND target_type='sleep' AND ended_at IS NULL AND status IN ('running','paused','awaiting_feedback') ORDER BY started_at DESC LIMIT 1 FOR UPDATE`;
  if (open) return finishRunningSleep(tx, userId, command, open, wakeAt, sleptAt, now, local, snap);
  return { result: await settleNight(tx, userId, command, wakeAt ?? now, sleptAt, now, local, snap), at: now };
}

/**
 * Runs the wake command. `wake` is null when the command id was already applied (a retry): the state is the answer
 * then, and the first answer's detail is not kept.
 */
export async function runWakeCommand(
  sql: PoolSql,
  command: WakeCommand
): Promise<{ wake: WakeResult | null; state: PortalState }> {
  const userId = await ensureUser(sql);
  const requestHash = commandRequestHash(command.type, command);
  if (await hasCommandReceipt(sql, { id: command.commandId, userId, commandType: command.type, requestHash }))
    return { wake: null, state: await readStateAfterCommit(sql) };
  const wake = await sql.begin(async (tx): Promise<WakeResult | null> => {
    const now = new Date();
    if (!(await claimCommandReceipt(tx, { id: command.commandId, userId, commandType: command.type, requestHash })))
      return null;
    // Publication lock before any row lock, in the worker's order: its publish deletes and upserts the planned
    // `sleep_plans` rows this settles. An agent's snapshot takes it too; the person's wake keeps none and takes it here.
    // An agent's wake keeps the rows it changes so `POST /api/commands/revert` can put them back.
    const snap = await WriteSnapshot.open(tx, userId, command.commandId, "wake");
    if (!snap) await holdPlanForecastPublication(tx, userId);
    const { result, at } = await applyWakeCommand(tx, userId, command, now, snap);
    await snap?.save();
    // A wake recorded alone names no night.
    const night = result.outcome === "recorded_wake" ? null : result;
    await recordStateChange(tx, userId, {
      entityType: "sleep_log_entry",
      entityId: night?.sleepPlanId ?? null,
      operation: "wake",
      evidence: night
        ? { outcome: night.outcome, sleptAt: night.sleptAt, wokeAt: night.wokeAt, startAssumed: night.startAssumed }
        : { outcome: result.outcome, wokeAt: result.wokeAt },
      commandId: command.commandId,
      at
    });
    return result;
  });
  return { wake, state: await readStateAfterCommit(sql) };
}
