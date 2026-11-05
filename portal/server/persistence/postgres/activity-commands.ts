import { isClosedStatus, restoreCall } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import type { ActivityCommand } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import {
  CommandConflictError,
  InvalidCommandError,
  alreadyClosed,
  notFound,
  openSessionConflict,
  refused,
  versionConflict,
  wrongSessionState,
  wrongState
} from "./command-errors";
import { stableUuid } from "./command-values";
import { applyDeliverableStepOutcome } from "./deliverable-session-rollover";
import { ensureUser } from "./ensure-user";
import { claimCommandReceipt, commandRequestHash, hasCommandReceipt } from "./command-receipt";
import { lockRecurrenceRule, recordCadenceCycle } from "./cadence-completion";
import {
  currentEngineResultIncludesActivity,
  explainActivityRefusal,
  explainCommitmentActivityRefusal,
  deriveSessionSanction,
  holdPlanForecastPublication,
  recordStateChange,
  requireCurrentPlanForecast
} from "./planning-evidence";
import { resolveBackfilledStart } from "./backfilled-start";
import { closeOpenSession, resolveRetroactiveEnd } from "./retroactive-end";
import { completeSleepPlan } from "./sleep-wake";
import { readStateAfterCommit } from "./read-after-commit";
import { sessionClock } from "./session-clock";
import { completeStepActionOccurrence } from "./routine-step-window";
import { watchActivityWrite } from "./entity-snapshot";
import { activityOutcomeRefusal } from "./activity-outcome-refusal";
import type { PoolSql, Sql, TxSql } from "./sql-pool";
import { WriteSnapshot } from "./write-snapshot";

/**
 * Names a fixed-commitment session by the phase it actually tracks, so a session opened during setup
 * or travel says so instead of naming the commitment itself. `active` and an absent
 * phase — an older client, or a client that has not adopted the phase field — both read as the
 * commitment's own title, matching the session this always was before phases were tracked separately.
 */
export function phaseSessionTitle(
  title: string,
  phase: "setup" | "travel" | "arrival" | "active" | "transition" | "return" | undefined
): string {
  switch (phase) {
    case "setup":
      return `Preparing for ${title}`;
    case "travel":
      return `Travelling to ${title}`;
    case "arrival":
      return `Arriving for ${title}`;
    case "transition":
      return `Transitioning back after ${title}`;
    case "return":
      return `Travelling on from ${title}`;
    default:
      return title;
  }
}

/**
 * Best-effort cadence-completion hook for a routine step that stands in for a cadence action
 * (`cadence_action_id` on `routine_steps`/`routine_preset_steps`): completing the step
 * records the cadence cycle exactly as if the linked action had been run directly, so the same
 * a cadence never has to be logged twice and the engine's own cadence-covered exclusion
 * (`engine/core/src/engine.ts`'s `hydrateAction`) and the next `cadenceEligibleFrom` both see it.
 * `cadenceActionId` absent, the action no longer `scheduling_mode='cadence'`, or its rule missing are
 * all silent no-ops — a dangling link is not this step's own completion's problem to fail on, mirroring
 * the sync-time gate's own fail-open rule (`platform/database/src/planning/routine-inheritance.ts`).
 */
async function recordCadenceStepCompletion(
  tx: Sql,
  cadenceActionId: string | null,
  at: Date,
  minutes: number,
  sessionId: string | null,
  snap: WriteSnapshot | null
): Promise<void> {
  if (!cadenceActionId) return;
  const mode = await tx<{ scheduling_mode: string }[]>`SELECT scheduling_mode FROM actions WHERE id=${cadenceActionId}`;
  if (mode[0]?.scheduling_mode !== "cadence") return;
  const rule = await lockRecurrenceRule(tx, cadenceActionId);
  if (!rule) return;
  await recordCadenceCycle(tx, { actionId: cadenceActionId, rule, at, minutes, sessionId, source: "session", snap });
}

/**
 * A step that is done, cancelled or archived is not worked on: starting or switching to it would write `doing` over a
 * closed row without the restore rules. A cancelled or archived one is refused with the exact restore call.
 */
function closedStepRefusal(step: { id: string; status: string; version: number }) {
  return alreadyClosed(
    "step",
    step.id,
    step.status,
    step.status === "done" ? undefined : restoreCall("action", step.id, step.version, step.status)
  );
}

export async function runActivityCommand(sql: PoolSql, command: ActivityCommand): Promise<PortalState> {
  const userId = await ensureUser(sql);
  const requestHash = commandRequestHash(command.type, command);
  if (await hasCommandReceipt(sql, { id: command.commandId, userId, commandType: command.type, requestHash }))
    return await readStateAfterCommit(sql);
  await sql.begin(async (tx) => {
    if (!(await claimCommandReceipt(tx, { id: command.commandId, userId, commandType: command.type, requestHash })))
      return;
    // An agent's activity write keeps the rows it touches so it can be undone afterwards (write-snapshot.ts).
    const snap = await WriteSnapshot.open(tx, userId, command.commandId, "activity");
    const at = await applyActivityCommand(tx, userId, command, snap);
    await snap?.save();
    await recordStateChange(tx, userId, {
      entityType: "activity_session",
      entityId: "sessionId" in command ? command.sessionId : "targetId" in command ? command.targetId : command.stepId,
      operation: command.type,
      evidence: { at: at.toISOString() },
      commandId: command.commandId,
      at
    });
  });
  return await readStateAfterCommit(sql);
}

/**
 * One activity command inside the caller's transaction, after its receipt is claimed: the rows it touches go
 * into `snap` (the caller saves it), and it returns the command's clock for the caller's change log row.
 * Catch-up settles a forgotten activity session through this; `endAtPause` ends a paused one at its pause
 * (`resolveRetroactiveEnd`).
 */
export async function applyActivityCommand(
  tx: TxSql,
  userId: string,
  command: ActivityCommand,
  snap: WriteSnapshot | null,
  options: { endAtPause?: boolean } = {}
): Promise<Date> {
  let at = new Date();
  await watchActivityWrite(snap, tx, userId, command);
  if (command.type === "start_activity") {
    // Publication lock before the open-session row lock, in the worker's order.
    await holdPlanForecastPublication(tx, userId);
    const open = await tx<
      { id: string; status: string; target_type: string | null }[]
    >`SELECT id,status,target_type FROM sessions WHERE user_id=${userId} AND ended_at IS NULL AND status IN ('running','paused','awaiting_feedback') FOR UPDATE`;
    if (open[0]) throw openSessionConflict(open[0]);
    const targetId = await stableUuid(`${command.targetType}:${userId}`, command.targetId);
    let title = "Sleep";
    // `startedAt` is when the work happened; `at` stays real now
    // for `updated_at` and every other record of this command.
    const { startTime, backfilled } = await resolveBackfilledStart(
      tx,
      userId,
      { commandId: command.commandId, startedAt: command.startedAt, targetType: command.targetType, targetId },
      at
    );
    const currentPlanning = await requireCurrentPlanForecast(tx, userId, at);
    if (
      !currentEngineResultIncludesActivity(
        currentPlanning,
        command.targetType,
        targetId,
        command.plannedMinutes,
        command.phase
      )
    )
      throw command.targetType === "fixed_commitment"
        ? new InvalidCommandError(
            explainCommitmentActivityRefusal(currentPlanning, targetId, command.plannedMinutes, command.phase)
          )
        : refused(explainActivityRefusal(currentPlanning, command.targetType, targetId, command.plannedMinutes));
    if (command.targetType === "routine_step") {
      const target = await tx<
        { title: string; version: number; status: string }[]
      >`SELECT title,version,status FROM routine_steps WHERE id=${targetId} AND user_id=${userId} FOR UPDATE`;
      if (!target[0]) throw notFound("routine step", command.targetId);
      if (command.expectedVersion !== target[0].version)
        throw versionConflict("routine step", command.targetId, command.expectedVersion, target[0].version);
      if (["completed", "cancelled", "skipped"].includes(target[0].status))
        throw alreadyClosed(
          "routine step",
          command.targetId,
          target[0].status,
          target[0].status === "skipped"
            ? { tool: "rhen_activity", arguments: { subcommand: "unskip-step", step: command.targetId } }
            : undefined
        );
      const blocked = await tx<
        { title: string }[]
      >`SELECT prerequisite.title FROM routine_step_dependencies dependency JOIN routine_steps prerequisite ON prerequisite.id=dependency.depends_on_step_id WHERE dependency.step_id=${targetId} AND prerequisite.status NOT IN ('completed','skipped')`;
      if (blocked.length)
        throw new InvalidCommandError(
          `Complete ${blocked.map((item) => `“${item.title}”`).join(", ")} before starting this step.`
        );
      title = target[0].title;
      await tx`UPDATE routine_steps SET status='doing',version=version+1,updated_at=${at} WHERE id=${targetId}`;
    } else if (command.targetType === "fixed_commitment") {
      const target = await tx<
        { title: string; version: number; status: string }[]
      >`SELECT title,version,status FROM commitments WHERE id=${targetId} AND user_id=${userId} FOR UPDATE`;
      if (!target[0]) throw notFound("commitment", command.targetId);
      if (command.expectedVersion !== target[0].version)
        throw versionConflict("commitment", command.targetId, command.expectedVersion, target[0].version);
      if (target[0].status !== "confirmed")
        throw wrongState({
          kind: "commitment",
          id: command.targetId,
          state: target[0].status,
          allowed: ["confirmed"],
          nextCall: { tool: "rhen_show", arguments: { entity: "commitment", id: command.targetId } }
        });
      title = phaseSessionTitle(target[0].title, command.phase);
    } else if (command.targetType === "deliverable") {
      const target = await tx<
        { title: string; version: number; status: string }[]
      >`SELECT d.title,d.version,d.status FROM deliverables d JOIN projects p ON p.id=d.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE d.id=${targetId} AND a.user_id=${userId} FOR UPDATE OF d`;
      if (!target[0]) throw notFound("deliverable", command.targetId);
      if (command.expectedVersion !== target[0].version)
        throw versionConflict("deliverable", command.targetId, command.expectedVersion, target[0].version);
      if (target[0].status === "completed" || isClosedStatus(target[0].status))
        throw alreadyClosed("deliverable", command.targetId, target[0].status, {
          tool: "rhen_show",
          arguments: { entity: "deliverable", id: command.targetId }
        });
      // Breakdown starts before internal steps necessarily exist. The aggregate session may pick
      // or switch a Carry-out step later inside the workspace.
      const step = command.stepId
        ? await tx<
            { id: string; title: string; status: string; version: number }[]
          >`SELECT id,title,status,version FROM actions WHERE id=${command.stepId} AND deliverable_id=${targetId}`
        : [];
      if (command.stepId && !step[0])
        throw refused({
          message: `Step "${command.stepId}" is not part of deliverable "${command.targetId}".`,
          nextCall: {
            tool: "rhen_show",
            arguments: { entity: "deliverable", id: command.targetId },
            note: "its steps are listed there"
          }
        });
      if (step[0] && ["done", "cancelled", "archived"].includes(step[0].status)) throw closedStepRefusal(step[0]);
      title = target[0].title;
      await tx`UPDATE deliverables SET status=${target[0].status === "needs_breakdown" ? "in_progress" : target[0].status === "ready" ? "in_progress" : target[0].status},last_worked_at=${startTime},version=version+1,updated_at=${at} WHERE id=${targetId}`;
      if (command.stepId)
        await tx`UPDATE actions SET status='doing',last_worked_at=${startTime},version=version+1,updated_at=${at} WHERE id=${command.stepId}`;
    } else {
      const target = await tx<
        { version: number; allowed_minutes: number }[]
      >`SELECT version,allowed_minutes FROM sleep_plans WHERE id=${targetId} AND user_id=${userId} AND status='planned' FOR UPDATE`;
      if (!target[0]) throw notFound("sleep plan", command.targetId);
      if (command.expectedVersion !== target[0].version)
        throw versionConflict("sleep plan", command.targetId, command.expectedVersion, target[0].version);
      if (target[0].allowed_minutes === command.plannedMinutes)
        await tx`UPDATE sleep_plans SET status='sleeping',actual_start_at=${at},version=version+1,updated_at=${at} WHERE id=${targetId}`;
      else
        // A duration chosen at the moment of starting — Now offers a full night or a top-up nap
        // once bedtime is begun early by hand — is what this night is, so the row records it
        // rather than keeping the window the engine drew for a bedtime that never happened. This
        // used to be refused outright as a stale client, but `expectedVersion` above already
        // catches a plan that moved underneath the page; the length is the person's to choose.
        // Writing it here, before `status='sleeping'` freezes the row against recalculation
        // (engine.ts), is the only moment the truth can be recorded.
        await tx`UPDATE sleep_plans SET status='sleeping',actual_start_at=${at},planned_start_at=${at},planned_wake_at=${new Date(at.getTime() + command.plannedMinutes * 60000)},allowed_minutes=${command.plannedMinutes},sleep_deficit_minutes=GREATEST(0,desired_minutes-${command.plannedMinutes}),input_version='override',version=version+1,updated_at=${at} WHERE id=${targetId}`;
    }
    const plannedEnd = new Date(startTime.getTime() + command.plannedMinutes * 60000);
    // The pulse criteria and publish design note (Decision Q2): decided once, at start, and frozen.
    const sanction = deriveSessionSanction(currentPlanning, command.targetType, targetId, startTime, command.phase);
    const sanctionUntil = sanction === "free" || sanction === null ? null : plannedEnd;
    await tx`INSERT INTO sessions (id,user_id,action_id,target_type,target_id,target_step_id,target_title,status,planned_started_at,planned_end_at,started_at,started_recorded_at,planned_minutes,remaining_before_minutes,plan_sanction,sanction_until,started_by) VALUES (${command.commandId},${userId},NULL,${command.targetType},${targetId},${command.targetType === "deliverable" ? (command.stepId ?? null) : null},${title},'running',${startTime},${plannedEnd},${startTime},${backfilled ? at : null},${command.plannedMinutes},0,${sanction},${sanctionUntil},${requestAgent()})`;
    await tx`INSERT INTO session_segments (session_id,started_at,step_id) VALUES (${command.commandId},${startTime},${command.targetType === "deliverable" ? (command.stepId ?? null) : null})`;
  } else if (command.type === "skip_routine_step") {
    // Names the `routine_steps` row directly, for either anchor — no instance id, since a
    // sleep-anchored step is skipped exactly like a commitment's own preparation step now.
    const openStep = await tx<
      { id: string }[]
    >`SELECT id FROM sessions WHERE user_id=${userId} AND target_id=${command.stepId} AND ended_at IS NULL FOR UPDATE`;
    if (openStep[0])
      throw new CommandConflictError(
        `Step "${command.stepId}" has an open timer (session ${openStep[0].id}), so it cannot be skipped. Finish or stop the timer first, then skip the step again.`,
        {
          nextCall: {
            tool: "rhen_activity",
            arguments: { subcommand: "finish", outcome: "stopped" },
            note: "stops the open timer; use outcome completed if the step is done, then repeat the skip"
          }
        }
      );
    const target = await tx<
      { status: string; version: number; commitment_id: string | null; cadence_action_id: string | null }[]
    >`SELECT status,version,commitment_id,cadence_action_id FROM routine_steps WHERE id=${command.stepId} AND user_id=${userId} FOR UPDATE`;
    if (!target[0]) throw notFound("routine step", command.stepId);
    if (command.expectedVersion !== target[0].version)
      throw versionConflict("routine step", command.stepId, command.expectedVersion, target[0].version);
    if (["completed", "cancelled", "skipped"].includes(target[0].status))
      throw alreadyClosed(
        "routine step",
        command.stepId,
        target[0].status,
        target[0].status === "skipped"
          ? { tool: "rhen_activity", arguments: { subcommand: "unskip-step", step: command.stepId } }
          : undefined
      );
    const blocked = await tx<
      { title: string }[]
    >`SELECT prerequisite.title FROM routine_step_dependencies dependency JOIN routine_steps prerequisite ON prerequisite.id=dependency.depends_on_step_id WHERE dependency.step_id=${command.stepId} AND prerequisite.status NOT IN ('completed','skipped')`;
    if (blocked.length)
      throw new InvalidCommandError(
        `Complete ${blocked.map((item) => `“${item.title}”`).join(", ")} before skipping this step.`
      );
    await tx`UPDATE routine_steps SET status='skipped',version=version+1,updated_at=${at} WHERE id=${command.stepId}`;
    // A skipped step no longer claims a place in its chain, so whatever follows it can move earlier
    // — the engine's placer picks that up on the recalculation the one-write-path enqueues, the same
    // as a completion does below; nothing here reschedules synchronously any more.
  } else if (command.type === "reopen_routine_step") {
    // Undoes `skip_routine_step` for either anchor. `save routine-step` cannot do this for a
    // sleep-anchored step (it needs a commitment), so a mistaken skip of a bedtime step had no way back.
    const target = await tx<
      { status: string; version: number }[]
    >`SELECT status,version FROM routine_steps WHERE id=${command.stepId} AND user_id=${userId} FOR UPDATE`;
    if (!target[0]) throw notFound("routine step", command.stepId);
    if (command.expectedVersion !== target[0].version)
      throw versionConflict("routine step", command.stepId, command.expectedVersion, target[0].version);
    if (target[0].status !== "skipped")
      throw wrongState({ kind: "routine step", id: command.stepId, state: target[0].status, allowed: ["skipped"] });
    await tx`UPDATE routine_steps SET status='pending',version=version+1,updated_at=${at} WHERE id=${command.stepId}`;
  } else {
    const session = await tx<
      {
        id: string;
        target_id: string;
        target_step_id: string | null;
        // `action` for an action session, which these commands never touch (see the guard below).
        target_type: "routine_step" | "sleep" | "fixed_commitment" | "deliverable" | "action";
        status: string;
        version: number;
        planned_end_at: Date;
        paused_remaining_seconds: number | null;
        started_at: Date;
      }[]
    >`SELECT id,target_id,target_step_id,target_type,status,version,planned_end_at,paused_remaining_seconds,started_at FROM sessions WHERE id=${command.sessionId} AND user_id=${userId} AND ended_at IS NULL FOR UPDATE`;
    if (!session[0]) throw notFound("session", command.sessionId, "The open activity session");
    if (command.expectedVersion !== session[0].version)
      throw versionConflict("session", command.sessionId, command.expectedVersion, session[0].version);
    // An action session (`target_type` 'action', the column's default) belongs to `runSessionCommand`. Nothing below knows
    // one: a finish fell through to the sleep branch and bumped `last_woke_at` to now, which then
    // refused every backfilled start before it. Refused before any write, so it stays open.
    if (session[0].target_type === "action")
      throw new InvalidCommandError(
        "This is an action session, so the activity commands cannot change it; it is still open. " +
          "Use the session commands instead: rhen session finish (which takes an ended-at time and records the action's outcome), pause, resume, block or did-not-start."
      );
    at = await sessionClock(tx, session[0].id, at);
    if (command.type === "switch_deliverable_step") {
      if (session[0].target_type !== "deliverable")
        throw new InvalidCommandError("Only a deliverable session moves between steps.");
      if (session[0].status !== "running")
        throw wrongSessionState(
          "rhen_activity",
          session[0].id,
          session[0].status,
          ["running"],
          session[0].status === "paused" ? "resume" : undefined
        );
      // Past the allocation the engine granted, the only honest moves are finishing or stopping.
      // Letting work continue here would quietly bill time the plan never reserved.
      if (session[0].planned_end_at <= at)
        throw new InvalidCommandError(
          "This session has reached its checkpoint. Finish or stop it before doing more work."
        );
      const next = await tx<
        { id: string; status: string; version: number }[]
      >`SELECT id,status,version FROM actions WHERE id=${command.stepId} AND deliverable_id=${session[0].target_id}`;
      if (!next[0])
        throw refused({
          message: `Step "${command.stepId}" is not part of this deliverable.`,
          nextCall: {
            tool: "rhen_show",
            arguments: { entity: "deliverable", id: String(session[0].target_id) },
            note: "its steps are listed there"
          }
        });
      if (["done", "cancelled", "archived"].includes(next[0].status)) throw closedStepRefusal(next[0]);
      // Close the open segment before opening the next, so the elapsed minutes land on the step
      // they were actually spent on and no two segments ever run at once.
      await tx`UPDATE session_segments SET ended_at=${at} WHERE session_id=${session[0].id} AND ended_at IS NULL`;
      await tx`INSERT INTO session_segments (session_id,started_at,step_id) VALUES (${session[0].id},${at},${command.stepId})`;
      if (session[0].target_step_id && session[0].target_step_id !== command.stepId)
        await tx`UPDATE actions SET status='planned',version=version+1,updated_at=${at} WHERE id=${session[0].target_step_id} AND status='doing'`;
      await tx`UPDATE actions SET status='doing',last_worked_at=${at},version=version+1,updated_at=${at} WHERE id=${command.stepId}`;
      await tx`UPDATE sessions SET target_step_id=${command.stepId},version=version+1,updated_at=${at} WHERE id=${session[0].id}`;
    } else if (command.type === "pause_activity") {
      if (session[0].status !== "running")
        throw wrongSessionState(
          "rhen_activity",
          session[0].id,
          session[0].status,
          ["running"],
          session[0].status === "paused" ? "resume" : undefined
        );
      await tx`UPDATE session_segments SET ended_at=${at} WHERE session_id=${session[0].id} AND ended_at IS NULL`; // Never negative: pausing after the planned end would otherwise store a negative remainder, which
      // fails portal state validation and takes the whole planning request down with it.
      const remaining = Math.max(0, Math.ceil((session[0].planned_end_at.getTime() - at.getTime()) / 1000));
      await tx`UPDATE sessions SET status='paused',paused_remaining_seconds=${remaining},result_note=${command.note ?? null},version=version+1,updated_at=${at} WHERE id=${session[0].id}`;
    } else if (command.type === "resume_activity") {
      if (session[0].status !== "paused")
        throw wrongSessionState("rhen_activity", session[0].id, session[0].status, ["paused"]);
      if (session[0].target_type === "deliverable" && (session[0].paused_remaining_seconds ?? 0) <= 0)
        throw new InvalidCommandError(
          "This session has reached its checkpoint. Finish or stop it before doing more work."
        );
      await tx`INSERT INTO session_segments (session_id,started_at,step_id) VALUES (${session[0].id},${at},${session[0].target_type === "deliverable" ? session[0].target_step_id : null})`;
      // Clears whatever pause note was recorded: `result_note` is otherwise a finish-time field, and
      // once work resumes the reason for the interruption is no longer this session's current state.
      await tx`UPDATE sessions SET status='running',planned_end_at=${new Date(at.getTime() + (session[0].paused_remaining_seconds ?? 0) * 1000)},paused_remaining_seconds=NULL,result_note=NULL,version=version+1,updated_at=${at} WHERE id=${session[0].id}`;
    } else {
      // Skipped is a routine step's own thing — moot preparation, not merely undone — and is never
      // offered against a deliverable, a commitment, sleep or the bedtime routine's own steps.
      const outcomeRefusal = activityOutcomeRefusal(command.outcome, session[0].target_type);
      if (outcomeRefusal !== null) throw new InvalidCommandError(outcomeRefusal);
      // A chosen retroactive end: `endTime` takes over from `at` wherever the session's own end is
      // recorded, while `at` (real now) stays on `updated_at` (see resolveRetroactiveEnd).
      const endTime = await resolveRetroactiveEnd(tx, session[0], command.endedAt, at, options.endAtPause);
      const terminal =
        command.outcome === "completed"
          ? "completed"
          : command.outcome === "stopped"
            ? "stopped"
            : command.outcome === "blocked"
              ? "blocked"
              : command.outcome === "skipped"
                ? "skipped"
                : "did_not_start";
      // A running session's open segment closes at the end; one awaiting feedback closed its last segment
      // at the checkpoint, and a given end replaces that.
      const minutes = await closeOpenSession(tx, session[0], {
        endTime,
        retroactive: Boolean(command.endedAt),
        terminal,
        note: command.note ?? null,
        at
      });
      if (session[0].target_type === "routine_step") {
        const parent = await tx<
          { commitment_id: string | null; status: string; cadence_action_id: string | null }[]
        >`SELECT commitment_id,status,cadence_action_id FROM routine_steps WHERE id=${session[0].target_id} FOR UPDATE`;
        // Arrival's own skip (`routine-step-arrival.ts`'s write-time skip, and the periodic sweep in
        // platform/database) can retire this step out from under a session that was already open
        // when the location assertion landed — the two are unrelated writes to the same row.
        // Finding 19: a step already `skipped` stays skipped. Finishing the stale session must not
        // resurrect it to `pending` (a "did not start" outcome) or overwrite arrival's own verdict
        // with whatever else the person happened to pick — mirroring the bedtime routine's own guard
        // just below ("the step stays open and can be started or skipped again": nothing there writes
        // over a status the routine system itself already decided, and nothing here does either).
        if (parent[0] && parent[0].status !== "skipped") {
          await tx`UPDATE routine_steps SET status=${command.outcome === "completed" ? "completed" : command.outcome === "blocked" ? "blocked" : command.outcome === "skipped" ? "skipped" : "pending"},completed_at=${command.outcome === "completed" ? at : null},version=version+1,updated_at=${at} WHERE id=${session[0].target_id}`;
          if (command.outcome === "completed") {
            await completeStepActionOccurrence(tx, userId, session[0].target_id, at, snap);
            await recordCadenceStepCompletion(tx, parent[0].cadence_action_id, at, minutes, session[0].id, snap);
          }
        }
      } else if (session[0].target_type === "deliverable") {
        // Time is attributed from the segments, and the tracked step's own status/completion are
        // guarded against a step already closed elsewhere — see applyDeliverableStepOutcome, shared
        // with the automatic rollover that ends a session the same way when there is nowhere left to
        // roll it into.
        await applyDeliverableStepOutcome(
          tx,
          session[0].id,
          session[0].target_id,
          session[0].target_step_id,
          command.outcome,
          endTime,
          at
        );
      } else if (session[0].target_type === "fixed_commitment") {
        // Time is only logged; a commitment's own confirmed/tentative/cancelled status is
        // scheduling, not activity progress, so it is left untouched — except for the one case
        // where finishing the timer *is* the fact that resolves an open-ended disruption's guess
        //. "Confirm and finish" / "I'm free" is a completed outcome, and completing
        // a session tracked against a commitment still holding a guessed end is the same signal as
        // "Done, heading home" (`endDisruptionNow` in disruption-commands.ts): the guess is over, this
        // is what actually happened. `blocked` and `did_not_start` stay pure no-ops on the commitment,
        // since neither says the disruption ended. Floored a minute after the disruption started, the
        // same as `endDisruptionNow`, since the DB rejects `ends_at <= starts_at`.
        if (command.outcome === "completed") {
          const disruption = await tx<
            { starts_at: Date }[]
          >`SELECT starts_at FROM commitments WHERE id=${session[0].target_id} AND user_id=${userId} AND origin='disruption' AND disruption_open_ended=true FOR UPDATE`;
          if (disruption[0]) {
            const endsAt = new Date(Math.max(at.getTime(), disruption[0].starts_at.getTime() + 60_000));
            await tx`UPDATE commitments SET ends_at=${endsAt},disruption_open_ended=false,version=version+1,updated_at=${at} WHERE id=${session[0].target_id}`;
          }
        }
        // The commitment's own `ends_at` deliberately never moves for an ordinary (non-disruption)
        // commitment — see the comment above. Its after-phase routine chain must still follow
        // reality when this session ran past the scheduled end, but that re-anchor
        // is no longer this command's to make: `trackedEndedAt` (readers/routine-read.ts, from this session's
        // own `ended_at`) reaches the engine's timeline on the recalculation the one-write-path below
        // enqueues, and the placer re-anchors the after-chain from there within seconds, not inline.
      } else if (command.outcome === "completed") {
        // Reached by a `sleep` session, and — the one edge this migration accepts rather than
        // engineers around — a legacy `routine_instance` session still open at the exact
        // moment this deploys: `target_type` keeps that value in the DB enum for history's sake, but
        // no branch above still recognises it, so it falls through to here. Every write below then
        // targets a `sleep_plans` id that does not exist and matches zero rows, except
        // `user_preferences.last_woke_at`, which is unconditional and would be wrongly bumped to now.
        // Judged acceptable: it requires a session open at the literal instant of a one-time schema
        // migration, on a single-user app, and does not corrupt the record it is wrong about.
        //
        // The wake is the session's end (`endTime`): a sleep finished with a chosen past time records that
        // wake, not the moment it was entered. The rules for the row are in `completeSleepPlan`, shared with
        // the wake command.
        await completeSleepPlan(tx, userId, session[0].target_id, {
          wakeAt: endTime,
          now: at,
          sessionStartedAt: session[0].started_at
        });
      } else
        await tx`UPDATE sleep_plans SET status='cancelled',actual_wake_at=NULL,version=version+1,updated_at=${at} WHERE id=${session[0].target_id}`;
    }
  }
  return at;
}
