import { requestAgent } from "@/server/agent-actor";
import type { SessionCommand } from "@openrhen/contracts";
import type { PortalState, StoredAction } from "@/state/portal-state";
import { accumulateRecurrenceMinutes, lockRecurrenceRule, recordCadenceCycle } from "./cadence-completion";
import {
  CommandConflictError,
  InvalidCommandError,
  notFound,
  openSessionConflict,
  refused,
  versionConflict,
  wrongSessionState
} from "./command-errors";
import { stableUuid } from "./command-values";
import { ensureUser } from "./ensure-user";
import { claimCommandReceipt, commandRequestHash, hasCommandReceipt } from "./command-receipt";
import {
  deriveSessionSanction,
  explainContinuationRefusal,
  holdPlanForecastPublication,
  recordStateChange,
  requireCurrentPlanForecast
} from "./planning-evidence";
import { resolveBackfilledStart, resolveCorrectedStart } from "./backfilled-start";
import { readStateAfterCommit } from "./read-after-commit";
import { replaceCheckpointEnd, resolveRetroactiveEnd } from "./retroactive-end";
import { sessionClock } from "./session-clock";
import type { PoolSql, TxSql } from "./sql-pool";
import { WriteSnapshot } from "./write-snapshot";

/** The call that ends a session on anything but an action; the tool and its arguments are in the manifest. */
const activityFinishCall = {
  tool: "rhen_activity",
  arguments: { subcommand: "finish", outcome: "completed" },
  note: "ends the open routine step, sleep, commitment or deliverable-step session; use outcome stopped if the work is not done"
};

/**
 * A recurring action is a template: only its occurrences are worked, one per window. A session
 * started on the template itself would be filed against the series and, on finish, end it, so
 * the start must name the occurrence (as the portal's Start does, with the template's version).
 */
export function assertStartableTarget(schedulingMode: string, occurrenceNamed: boolean): void {
  if (schedulingMode === "recurring" && !occurrenceNamed)
    throw new InvalidCommandError(
      "This is a recurring action: start a session on one of its occurrences (pass the occurrence id as actionId, with this action's version as expectedVersion), not on the series itself."
    );
}

/** Why an action cannot take a session, or null when it can: its status, and setting it back to active. */
export function unstartableActionMessage(status: string): string | null {
  // Read on the portal and through the CLI alike, so it names the fix, not one surface's way to it.
  if (status === "waiting" || status === "blocked")
    return `This action is ${status}, so it cannot be started; set its status back to active first.`;
  if (status === "done" || status === "cancelled" || status === "archived")
    return `This action is ${status}, so it cannot be started; reopen it by setting its status back to active.`;
  return null;
}

export async function runSessionCommand(sql: PoolSql, command: SessionCommand): Promise<PortalState> {
  const userId = await ensureUser(sql);
  const requestHash = commandRequestHash(command.type, command);
  if (await hasCommandReceipt(sql, { id: command.commandId, userId, commandType: command.type, requestHash }))
    return await readStateAfterCommit(sql);
  await sql.begin(async (tx) => {
    if (!(await claimCommandReceipt(tx, { id: command.commandId, userId, commandType: command.type, requestHash })))
      return;
    // An agent's session write keeps the rows it changes, so `POST /api/commands/revert` can put them back
    //. The person's own writes (null here) are not snapshotted.
    const snap = await WriteSnapshot.open(tx, userId, command.commandId, "session");
    const at = await applySessionCommand(tx, userId, command, snap);
    await snap?.save();
    await recordStateChange(tx, userId, {
      entityType: "session",
      entityId: "sessionId" in command ? command.sessionId : command.commandId,
      operation: command.type,
      evidence: { at: at.toISOString() },
      commandId: command.commandId,
      at
    });
  });
  return await readStateAfterCommit(sql);
}

/**
 * One session command inside the caller's transaction, after its receipt is claimed: the rows it changes go
 * into `snap` (the caller saves it), and it returns the command's clock for the caller's change log row.
 * Catch-up settles a forgotten session through this, so a settle and a finish cannot end a session
 * differently; `endAtPause` ends a paused one at its pause (`resolveRetroactiveEnd`).
 */
export async function applySessionCommand(
  tx: TxSql,
  userId: string,
  command: SessionCommand,
  snap: WriteSnapshot | null,
  options: { endAtPause?: boolean } = {}
): Promise<Date> {
  let at = new Date();
  if (command.type === "start" || command.type === "select_alternative") {
    // Publication lock before any row lock, in the worker's order.
    await holdPlanForecastPublication(tx, userId);
    // `startedAt` is when the work happened; `at` stays real now.
    const { startTime, backfilled } = await resolveBackfilledStart(
      tx,
      userId,
      {
        commandId: command.commandId,
        startedAt: command.startedAt,
        targetType: "action",
        targetId: command.actionId
      },
      at
    );
    const currentPlanning = await requireCurrentPlanForecast(tx, userId, at);
    const occurrence = await tx<
      { id: string; action_id: string; status: string; window_starts_at: Date; window_ends_at: Date }[]
    >`SELECT oc.id,oc.action_id,oc.status,oc.window_starts_at,oc.window_ends_at FROM action_occurrences oc JOIN actions ac ON ac.id=oc.action_id JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE oc.id=${command.actionId} AND a.user_id=${userId} FOR UPDATE OF oc`;
    const actionId = occurrence[0]?.action_id ?? (await stableUuid(`action:${userId}`, command.actionId));
    if (
      occurrence[0] &&
      (occurrence[0].status !== "pending" ||
        occurrence[0].window_starts_at > startTime ||
        occurrence[0].window_ends_at <= startTime)
    )
      throw new InvalidCommandError("This recurring occurrence is not currently available.");
    const action = await tx<
      { version: number; remaining_minutes: number; status: StoredAction["status"]; scheduling_mode: string }[]
    >`
        SELECT ac.version, ac.remaining_minutes, ac.status, ac.scheduling_mode FROM actions ac JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE ac.id=${actionId} AND a.user_id=${userId} FOR UPDATE OF ac
      `;
    if (!action[0]) throw notFound("action", command.actionId);
    assertStartableTarget(action[0].scheduling_mode, occurrence[0] !== undefined);
    if (command.expectedVersion !== action[0].version)
      throw versionConflict("action", command.actionId, command.expectedVersion, action[0].version);
    const notStartable = unstartableActionMessage(action[0].status);
    if (notStartable) throw new InvalidCommandError(notStartable);
    const running = await tx<
      { id: string; status: string; target_type: string | null }[]
    >`SELECT id,status,target_type FROM sessions WHERE user_id=${userId} AND ended_at IS NULL AND status IN ('running','paused','awaiting_feedback') FOR UPDATE`;
    if (running[0]) throw openSessionConflict(running[0]);
    let recommendationId: string | null = null;
    if (command.recommendationId) {
      const owned = await tx<
        { id: string }[]
      >`SELECT id FROM recommendations WHERE id=${command.recommendationId} AND user_id=${userId}`;
      recommendationId = owned[0]?.id ?? null;
      if (!recommendationId)
        throw new CommandConflictError(
          `Recommendation "${command.recommendationId}" is no longer current: the plan was recalculated since you read it. Nothing was started. Read the new recommendation and start again.`,
          {
            nextCall: { tool: "rhen_status", arguments: {}, note: "shows the current recommendation and its id" }
          }
        );
      const candidate = await tx<
        { rank: number; eligible: boolean; recommended_minutes: number | null }[]
      >`SELECT rank,eligible,recommended_minutes FROM recommendation_candidates WHERE recommendation_id=${recommendationId} AND action_id=${actionId} AND occurrence_id IS NOT DISTINCT FROM ${occurrence[0]?.id ?? null}`;
      const currentCandidate = candidate[0];
      let validRank = false;
      if (currentCandidate)
        validRank =
          command.type === "select_alternative"
            ? currentCandidate.rank >= 2 && currentCandidate.rank <= 4
            : currentCandidate.rank === 1;
      if (!currentCandidate?.eligible || !validRank)
        throw new InvalidCommandError(
          command.type === "select_alternative"
            ? `Action "${command.actionId}" is not one of the current alternatives (ranks 2 to 4 of the recommendation).`
            : `Action "${command.actionId}" is no longer the current recommendation.`
        );
      if (currentCandidate.recommended_minutes !== command.plannedMinutes)
        throw new CommandConflictError(
          `The recommended session length is now ${currentCandidate.recommended_minutes ?? "not set"} minutes, not the ${command.plannedMinutes} you sent. Nothing was started.`,
          {
            nextCall: {
              tool: "rhen_status",
              arguments: {},
              note: "shows the current recommendation and its minutes"
            }
          }
        );
    }
    const plannedEnd = new Date(startTime.getTime() + command.plannedMinutes * 60_000);
    const overrideReason = command.type === "select_alternative" ? command.reason : null;
    const resultNote = command.type === "select_alternative" ? (command.note ?? null) : null;
    // The pulse criteria and publish design note (Decision Q2): decided once, at start, and frozen.
    // `select_alternative` names its own sanction directly — `deriveSessionSanction` would also
    // read "directive" for a candidate that happens to equal the current directive, so only fall
    // back to it when the action is not also the directive itself.
    const sanction =
      command.type === "select_alternative"
        ? deriveSessionSanction(currentPlanning, "action", actionId, startTime) === "directive"
          ? "directive"
          : "alternative"
        : deriveSessionSanction(currentPlanning, "action", actionId, startTime);
    const sanctionUntil = sanction === "free" || sanction === null ? null : plannedEnd;
    await tx`INSERT INTO sessions (id, user_id, action_id, occurrence_id, status, planned_started_at, planned_end_at, started_at, started_recorded_at, planned_minutes, remaining_before_minutes, recommendation_id, override_reason, result_note, plan_sanction, sanction_until, started_by) VALUES (${command.commandId}, ${userId}, ${actionId}, ${occurrence[0]?.id ?? null}, 'running', ${startTime}, ${plannedEnd}, ${startTime}, ${backfilled ? at : null}, ${command.plannedMinutes}, ${action[0].remaining_minutes}, ${recommendationId}, ${overrideReason}, ${resultNote}, ${sanction}, ${sanctionUntil}, ${requestAgent()})`;
    snap?.inserted("sessions", [command.commandId]);
    const firstSegment = await tx<
      { id: string }[]
    >`INSERT INTO session_segments (session_id, started_at) VALUES (${command.commandId}, ${startTime}) RETURNING id`;
    snap?.inserted(
      "session_segments",
      firstSegment.map((row) => row.id)
    );
    if (!occurrence[0]) {
      await snap?.before("actions", [actionId]);
      await tx`UPDATE actions SET status='doing', version=version+1, updated_at=${at} WHERE id=${actionId}`;
    }
  } else {
    // `continue` reads the plan; take the publication lock before the session row.
    if (command.type === "continue") await holdPlanForecastPublication(tx, userId);
    const session = await tx<
      {
        id: string;
        action_id: string | null;
        occurrence_id: string | null;
        target_type: string | null;
        target_step_id: string | null;
        status: "running" | "paused" | "awaiting_feedback";
        version: number;
        planned_end_at: Date;
        paused_remaining_seconds: number | null;
        remaining_before_minutes: number;
        started_at: Date;
      }[]
    >`
        SELECT id, action_id, occurrence_id, target_type, target_step_id, status, version, planned_end_at, paused_remaining_seconds, remaining_before_minutes, started_at FROM sessions WHERE id=${command.sessionId} AND user_id=${userId} AND ended_at IS NULL FOR UPDATE
      `;
    if (!session[0]) throw notFound("session", command.sessionId);
    if (command.expectedVersion !== session[0].version)
      throw versionConflict("session", command.sessionId, command.expectedVersion, session[0].version);
    // Every command below that gets this far changes the session row.
    await snap?.before("sessions", [session[0].id]);
    at = await sessionClock(tx, session[0].id, at);
    // Closes the session's open segments at `endAt`, never at or before a segment's own start (the table
    // forbids it). A set-based UPDATE, so the snapshot takes the ids first.
    const closeSegments = async (endAt: Date) => {
      const open = await tx<
        { id: string }[]
      >`SELECT id FROM session_segments WHERE session_id=${session[0]!.id} AND ended_at IS NULL`;
      await snap?.before(
        "session_segments",
        open.map((row) => row.id)
      );
      await tx`UPDATE session_segments SET ended_at=GREATEST(${endAt}, started_at + interval '1 millisecond') WHERE session_id=${session[0]!.id} AND ended_at IS NULL`;
    };
    const closeSegment = () => closeSegments(at);
    // A deliverable session times each step through its segments. Any segment this path opens —
    // resuming, continuing after the checkpoint — must carry the current step, or the minutes after
    // it silently land on no step and the session total stops being a sum of its parts.
    const isDeliverable = session[0].target_type === "deliverable";
    const segmentStepId = isDeliverable ? session[0].target_step_id : null;
    const openSegment = async () => {
      const opened = await tx<
        { id: string }[]
      >`INSERT INTO session_segments (session_id, started_at, step_id) VALUES (${session[0]!.id}, ${at}, ${segmentStepId}) RETURNING id`;
      snap?.inserted(
        "session_segments",
        opened.map((row) => row.id)
      );
    };
    if (command.type === "correct_start") {
      // The session, its first segment and (while running) its planned end move to `startedAt`, as if it had
      // started there; `started_recorded_at` marks it backfilled. `sanction_until` was set equal to the planned end at start, so
      // it shifts with it (null stays null).
      const moved = await resolveCorrectedStart(tx, userId, command, at);
      const plannedEnd = moved.movesPlannedEnd
        ? new Date(session[0].planned_end_at.getTime() + moved.shiftMs)
        : session[0].planned_end_at;
      await tx`UPDATE sessions SET started_at=${moved.startTime}, planned_started_at=${moved.startTime}, planned_end_at=${plannedEnd}, sanction_until=sanction_until + (${moved.movesPlannedEnd ? moved.shiftMs : 0}::double precision * interval '1 millisecond'), started_recorded_at=${moved.startTime.getTime() < at.getTime() ? at : null}, version=version+1, updated_at=${at} WHERE id=${session[0].id}`;
      if (moved.firstSegmentId) {
        await snap?.before("session_segments", [moved.firstSegmentId]);
        await tx`UPDATE session_segments SET started_at=${moved.startTime} WHERE id=${moved.firstSegmentId}`;
      }
    } else if (command.type === "pause") {
      if (session[0].status !== "running")
        throw wrongSessionState(
          "rhen_session",
          session[0].id,
          session[0].status,
          ["running"],
          session[0].status === "paused" ? "resume" : undefined
        );
      await closeSegment();
      // Never negative, as for `pause_activity`: a remainder below zero fails portal state validation.
      const remainingSeconds = Math.max(0, Math.ceil((session[0].planned_end_at.getTime() - at.getTime()) / 1000));
      await tx`UPDATE sessions SET status='paused', paused_remaining_seconds=${remainingSeconds}, version=version+1, updated_at=${at} WHERE id=${session[0].id}`;
    } else if (command.type === "resume") {
      if (session[0].status !== "paused")
        throw wrongSessionState("rhen_session", session[0].id, session[0].status, ["paused"]);
      const remainingSeconds = session[0].paused_remaining_seconds ?? 0;
      await openSegment();
      await tx`UPDATE sessions SET status='running', planned_end_at=${new Date(at.getTime() + remainingSeconds * 1000)}, paused_remaining_seconds=NULL, version=version+1, updated_at=${at} WHERE id=${session[0].id}`;
    } else if (command.type === "request_feedback") {
      // An activity has no feedback surface — it runs past its planned end by design, counting up.
      // Parking one in `awaiting_feedback` leaves it with no command it will still accept, not even
      // pause, so refuse here as well as in the browser rather than trusting the caller.
      if (
        (["routine_step", "routine_instance", "sleep", "fixed_commitment"] as (string | null)[]).includes(
          session[0].target_type
        )
      )
        throw new InvalidCommandError(
          `Session ${session[0].id} is on a ${String(session[0].target_type).replace(/_/g, " ")}, which has no feedback step (feedback is only collected for action and deliverable sessions). ` +
            'Nothing was changed. End it with rhen_activity {"subcommand":"finish","outcome":"completed"} (outcome stopped if the work is not done), or pause it with rhen_activity {"subcommand":"pause"}.',
          { nextCall: activityFinishCall }
        );
      // The page sends this the moment it opens after the planned end has passed, which can be hours
      // later, so the work is taken to have stopped at the planned end, not when somebody looked; `finish`
      // can still say when it really stopped (`endedAt`). A paused session closed its segment at the pause.
      if (session[0].status === "running")
        await closeSegments(new Date(Math.min(at.getTime(), session[0].planned_end_at.getTime())));
      if (!(["running", "paused"] as string[]).includes(session[0].status))
        throw wrongSessionState("rhen_session", session[0].id, session[0].status, ["running", "paused"]);
      await tx`UPDATE sessions SET status='awaiting_feedback', feedback_requested_at=${at}, version=version+1, updated_at=${at} WHERE id=${session[0].id}`;
    } else if (command.type === "continue") {
      // A running or paused session reaches awaiting_feedback through `feedback`; that is the call to name.
      if (session[0].status !== "awaiting_feedback")
        throw wrongSessionState(
          "rhen_session",
          session[0].id,
          session[0].status,
          ["awaiting_feedback"],
          session[0].status === "running" || session[0].status === "paused" ? "feedback" : undefined
        );
      const current = await requireCurrentPlanForecast(tx, userId, at);
      const continuation =
        current.continuation && typeof current.continuation === "object" && !Array.isArray(current.continuation)
          ? (current.continuation as Record<string, unknown>)
          : null;
      if (continuation?.safe !== true || continuation.recommendedMinutes !== command.requestedMinutes)
        throw refused(explainContinuationRefusal(continuation, command.requestedMinutes));
      await openSegment();
      // Decision Q2: `continue` sets `continuation` and moves the sanctioned end forward — the one
      // exception to "decided once, at start" the design names explicitly.
      const continuedEnd = new Date(at.getTime() + command.requestedMinutes * 60_000);
      await tx`UPDATE sessions SET status='running', planned_end_at=${continuedEnd}, planned_minutes=planned_minutes+${command.requestedMinutes}, feedback_requested_at=NULL, paused_remaining_seconds=NULL, plan_sanction='continuation', sanction_until=${continuedEnd}, version=version+1, updated_at=${at} WHERE id=${session[0].id}`;
    } else {
      // Ending a session is what attributes its time and closes its target, and that is per
      // target type. This path knows only actions: a deliverable session ended here would update
      // `actions WHERE id=NULL` and credit its steps with nothing.
      if (isDeliverable || !session[0].action_id)
        throw new InvalidCommandError(
          `Session ${session[0].id} is not an action session (it is on ${
            session[0].target_type
              ? `a ${String(session[0].target_type).replace(/_/g, " ")}`
              : "something other than an action"
          }), and rhen_session only ends actions. Nothing was changed. ` +
            'End it with rhen_activity {"subcommand":"finish","outcome":"completed"} (outcome stopped, blocked, did_not_start or skipped if it did not complete), which records the outcome against the right target.',
          { nextCall: activityFinishCall }
        );
      const actionId = session[0].action_id;
      // A past end for a session being backfilled (`finish` only): it replaces `at` for the session's
      // own end and the action's `last_worked_at`/`completed_at`, while `at` stays on `updated_at` and
      // `ended_recorded_at`. The cadence and recurrence helpers keep `at`, since they stamp it on
      // `updated_at` too; a backfill reaches back at most a day, so their dates move by that at most.
      const endedAt = command.type === "finish" ? command.endedAt : undefined;
      const endTime = await resolveRetroactiveEnd(tx, session[0], endedAt, at, options.endAtPause);
      // A running session's open segment closes at the end; one awaiting feedback closed its last segment
      // at the checkpoint, and a given end replaces that.
      if (session[0].status === "running") await closeSegments(endTime);
      else if (session[0].status === "awaiting_feedback" && endedAt)
        await replaceCheckpointEnd(tx, session[0].id, endTime, snap);
      const totals = await tx<
        { seconds: number }[]
      >`SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at-started_at))),0)::int AS seconds FROM session_segments WHERE session_id=${session[0].id} AND ended_at IS NOT NULL`;
      const activeMinutes = Math.max(0, Math.round((totals[0]?.seconds ?? 0) / 60));
      let terminal: "completed" | "stopped" | "blocked" | "did_not_start";
      let remainingAfter = session[0].remaining_before_minutes;
      let actionStatus: StoredAction["status"] = "active";
      let needsReview = false;
      let blockingReason: string | null = null;
      let note: string | null = command.note ?? null;
      // The remaining-time estimate is confirmed when the finish states one: done (nothing left) or the figure
      // the person gave. "Unsure", a block and a session that never started carry the old figure over, so the
      // estimate keeps the age it had (the fact freshness design note, effort age), and a default stays assumed.
      const remainingStated = command.type === "finish" && command.outcome !== "unsure";
      if (command.type === "finish") {
        terminal = command.outcome === "completed" ? "completed" : "stopped";
        remainingAfter =
          command.outcome === "completed"
            ? 0
            : command.outcome === "progress"
              ? command.remainingMinutes!
              : session[0].remaining_before_minutes;
        actionStatus = command.outcome === "completed" ? "done" : "active";
        needsReview = command.outcome === "unsure";
      } else if (command.type === "block") {
        terminal = "blocked";
        actionStatus = command.actionStatus;
        blockingReason = command.reason;
      } else {
        terminal = "did_not_start";
        actionStatus = "active";
      }
      await tx`UPDATE sessions SET status=${terminal}, ended_at=${endTime}, ended_recorded_at=${command.type === "finish" && command.endedAt ? at : null}, active_minutes=${activeMinutes}, remaining_after_minutes=${remainingAfter}, blocking_reason=${blockingReason}, result_note=COALESCE(${note}, result_note), paused_remaining_seconds=NULL, version=version+1, updated_at=${at} WHERE id=${session[0].id}`;
      const mode = await tx<
        { scheduling_mode: string }[]
      >`SELECT scheduling_mode FROM actions WHERE id=${actionId} FOR UPDATE`;
      // Every branch below updates the action (the cadence one through `recordCadenceCycle`, which also records it).
      await snap?.before("actions", [actionId]);
      if (session[0].occurrence_id) {
        if (terminal === "completed") {
          await snap?.before("action_occurrences", [session[0].occurrence_id]);
          await tx`UPDATE action_occurrences SET status='completed',completed_at=${endTime},routine_covered=false,version=version+1,updated_at=${at} WHERE id=${session[0].occurrence_id}`;
        }
        await tx`UPDATE actions SET last_worked_at=CASE WHEN ${terminal}='did_not_start' THEN last_worked_at ELSE ${endTime} END,version=version+1,updated_at=${at} WHERE id=${actionId}`;
        if (terminal === "completed")
          await accumulateRecurrenceMinutes(
            tx,
            actionId,
            await lockRecurrenceRule(tx, actionId),
            activeMinutes,
            at,
            snap
          );
      } else if (mode[0]?.scheduling_mode === "cadence" && terminal === "completed") {
        // Finishing cadence closes the cycle, not the action: it is logged as done today
        // and reset for next time, so the engine withholds it until tomorrow and moves on.
        const rule = await lockRecurrenceRule(tx, actionId);
        if (!rule)
          throw refused({
            message: `Action "${actionId}" is set to cadence but its cadence rule is missing, so it cannot be marked done.`,
            nextCall: {
              tool: "rhen_show",
              arguments: { entity: "action", id: actionId },
              note: "check its scheduling and recurrence"
            }
          });
        await recordCadenceCycle(tx, {
          actionId,
          rule,
          at,
          minutes: activeMinutes,
          sessionId: session[0].id,
          source: "session",
          snap
        });
      } else if (mode[0]?.scheduling_mode === "cadence") {
        // Progress, blocked, did not start: the cycle is still open, so the action stays live with
        // whatever effort the person says is left; it is never marked done by a session.
        const cadenceStatus: StoredAction["status"] = actionStatus === "done" ? "active" : actionStatus;
        await tx`UPDATE actions SET status=${cadenceStatus}, remaining_minutes=${remainingAfter}, remaining_set_at=CASE WHEN ${remainingStated} THEN ${at} ELSE remaining_set_at END, estimate_needs_review=${needsReview}, assumed_fields=CASE WHEN ${remainingStated} THEN array_remove(assumed_fields,'remainingMinutes') ELSE assumed_fields END, last_worked_at=CASE WHEN ${terminal}='did_not_start' THEN last_worked_at ELSE ${endTime} END, version=version+1, updated_at=${at} WHERE id=${actionId}`;
      } else if (mode[0]?.scheduling_mode === "recurring") {
        // A session with no occurrence on a recurring template (started before starts were refused) is
        // time logged against the series. It never completes, blocks or re-estimates the whole series.
        await tx`UPDATE actions SET last_worked_at=CASE WHEN ${terminal}='did_not_start' THEN last_worked_at ELSE ${endTime} END, version=version+1, updated_at=${at} WHERE id=${actionId}`;
      } else
        await tx`UPDATE actions SET status=${actionStatus}, remaining_minutes=${remainingAfter}, remaining_set_at=CASE WHEN ${remainingStated} THEN ${at} ELSE remaining_set_at END, estimate_needs_review=${needsReview}, assumed_fields=CASE WHEN ${remainingStated} THEN array_remove(assumed_fields,'remainingMinutes') ELSE assumed_fields END, last_worked_at=CASE WHEN ${terminal}='did_not_start' THEN last_worked_at ELSE ${endTime} END, completed_at=CASE WHEN ${terminal}='completed' THEN ${endTime} ELSE completed_at END, version=version+1, updated_at=${at} WHERE id=${actionId}`;
    }
  }
  return at;
}
