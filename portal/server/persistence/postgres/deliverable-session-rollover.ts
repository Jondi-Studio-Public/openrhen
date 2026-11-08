import { assessDeliverable } from "@openrhen/contracts/readiness";
import { nextExecutableStepId } from "@/features/deliverables/deliverable-model";
import { readPortalState } from "./state-read";
import { sessionClock } from "./session-clock";
import type { Sql } from "./sql-pool";

/**
 * Automatically moves a running deliverable session onto its next executable step the instant the
 * step it was tracking is saved as done — whether that happened through the deliverable chat's
 * mark_steps_complete tool or through the workspace's own step checkbox. Both save the whole
 * deliverable aggregate through the same command, so this runs once, here, after every deliverable
 * save rather than being duplicated at each caller.
 *
 * Without this, completing a step by any route other than SessionCard's own "Step done — end
 * session" button left the session open and still pointed at a step that no longer had any work left
 * — silently crediting further time to nothing until the person noticed and switched or stopped by
 * hand (see the former "does not reopen a step already completed elsewhere" regression test, which
 * documented exactly this as a known gap before this rollover existed).
 *
 * Only a running session rolls forward. A paused session has no open segment to attribute time to,
 * and a session already at its checkpoint has no allocation left to move into another step — rolling
 * onto one anyway would bill time the plan never reserved, the same invariant switch_deliverable_step
 * already protects. Both are left for the person to resolve by hand. And nothing here ever *starts*
 * tracking: if no session was running against this step, none is spontaneously created.
 */
export async function rollDeliverableSessionForward(tx: Sql, deliverableId: string, now: Date): Promise<void> {
  const open = await tx<
    { id: string; target_step_id: string | null; planned_end_at: Date }[]
  >`SELECT id,target_step_id,planned_end_at FROM sessions
    WHERE target_type='deliverable' AND target_id=${deliverableId} AND status='running' AND ended_at IS NULL
    FOR UPDATE`;
  const session = open[0];
  if (!session || !session.target_step_id) return;
  const at = await sessionClock(tx, session.id, now);

  const tracked = await tx<
    { status: string }[]
  >`SELECT status FROM actions WHERE id=${session.target_step_id} AND deliverable_id=${deliverableId}`;
  // The save that triggered this either didn't touch the tracked step at all, or didn't finish it —
  // nothing to roll over.
  if (tracked[0]?.status !== "done") return;

  // Past the checkpoint the only honest moves are finishing or stopping (see switch_deliverable_step
  // in activity-commands.ts), so the session ends here rather than silently working unallocated time.
  if (session.planned_end_at <= at) {
    await closeDeliverableSessionRecord(tx, session.id, "completed", null, at);
    await applyDeliverableStepOutcome(tx, session.id, deliverableId, session.target_step_id, "completed", at);
    return;
  }

  const state = await readPortalState(tx);
  const deliverable = state?.deliverables.find((item) => item.id === deliverableId);
  if (!state || !deliverable) return;
  const readiness = assessDeliverable({
    deliverable,
    situation: state.currentSituation,
    conditionDefinitions: state.conditionDefinitions,
    now: at,
    commitments: state.commitments,
    timeZone: state.settings.timezone
  });
  const nextStepId = nextExecutableStepId(deliverable, readiness);

  // Nothing left to work on right now — required steps remaining but all blocked, waiting on a
  // prerequisite, or situation-mismatched reads the same as genuinely finished for a running session:
  // there is no honest next step to move the clock onto, so the session ends instead of idling.
  if (!nextStepId) {
    await closeDeliverableSessionRecord(tx, session.id, "completed", null, at);
    await applyDeliverableStepOutcome(tx, session.id, deliverableId, session.target_step_id, "completed", at);
    return;
  }

  await tx`UPDATE session_segments SET ended_at=${at} WHERE session_id=${session.id} AND ended_at IS NULL`;
  await tx`INSERT INTO session_segments (session_id,started_at,step_id) VALUES (${session.id},${at},${nextStepId})`;
  await tx`UPDATE actions SET status='doing',last_worked_at=${at},version=version+1,updated_at=${at} WHERE id=${nextStepId}`;
  await tx`UPDATE sessions SET target_step_id=${nextStepId},version=version+1,updated_at=${at} WHERE id=${session.id}`;
}

/**
 * Closes out a deliverable session's segments and credits every step it touched with the time
 * actually spent — shared by the automatic rollover above (when there is nowhere left to roll into)
 * and by finish_activity's own deliverable outcome in activity-commands.ts, so both close a session
 * the same way. Guards the currently tracked step's status update against a step already closed
 * elsewhere (`status NOT IN ('done','cancelled')`) for the same reason the finish_activity path always
 * has: a session finishing after its step was independently completed must not revert it.
 *
 * `skipped` is accepted only because `finish_activity`'s outcome type is shared across every target
 * type; the server refuses it for anything but a routine-step session before this is ever called, so
 * it falls through to the same "leave it open" treatment as `stopped`/`did_not_start`.
 */
export async function applyDeliverableStepOutcome(
  tx: Sql,
  sessionId: string,
  deliverableId: string,
  targetStepId: string | null,
  outcome: "completed" | "stopped" | "blocked" | "did_not_start" | "skipped",
  at: Date,
  // The moment recorded as `updated_at` on every row this touches — real now, distinct from `at` when
  // a reconciled `finish_activity` closes the session at a chosen past moment (`at` still drives
  // `last_worked_at`/`completed_at`, the honest "when it happened"). Defaults to `at` for the
  // automatic rollover above, which has no chosen end time of its own — every write it makes is
  // already anchored to real now.
  recordedAt: Date = at
): Promise<void> {
  const perStep = await tx<
    { step_id: string; seconds: number }[]
  >`SELECT step_id,COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at-started_at))),0)::int seconds FROM session_segments WHERE session_id=${sessionId} AND ended_at IS NOT NULL AND step_id IS NOT NULL GROUP BY step_id`;
  for (const entry of perStep) {
    const spent = Math.round(entry.seconds / 60);
    // Remaining effort never goes below zero, and an overrun is left visible as a re-estimate rather
    // than silently absorbed.
    await tx`UPDATE actions SET remaining_minutes=GREATEST(0,remaining_minutes-${spent}),remaining_set_at=CASE WHEN GREATEST(0,remaining_minutes-${spent})<>remaining_minutes THEN ${recordedAt} ELSE remaining_set_at END,estimate_needs_review=(remaining_minutes-${spent})<0,last_worked_at=${at},version=version+1,updated_at=${recordedAt} WHERE id=${entry.step_id}`;
  }
  if (targetStepId)
    await tx`UPDATE actions SET status=${outcome === "completed" ? "done" : outcome === "blocked" ? "blocked" : "planned"},completed_at=${outcome === "completed" ? at : null},version=version+1,updated_at=${recordedAt} WHERE id=${targetStepId} AND status NOT IN ('done','cancelled','archived')`;
  await tx`UPDATE deliverables SET last_worked_at=${at},version=version+1,updated_at=${recordedAt} WHERE id=${deliverableId}`;
}

/** Closes every open segment and writes the session's own terminal fields — the part every outcome shares. */
export async function closeDeliverableSessionRecord(
  tx: Sql,
  sessionId: string,
  outcome: "completed" | "stopped" | "blocked" | "did_not_start",
  note: string | null,
  at: Date,
  // See `applyDeliverableStepOutcome` above: `updated_at` always takes real now, `at` (the chosen end)
  // drives `ended_at`/`active_minutes`. Defaults to `at` since every current call site is the
  // automatic rollover, never a reconciled finish.
  recordedAt: Date = at
): Promise<void> {
  await tx`UPDATE session_segments SET ended_at=${at} WHERE session_id=${sessionId} AND ended_at IS NULL`;
  const totals = await tx<
    { seconds: number }[]
  >`SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at-started_at))),0)::int seconds FROM session_segments WHERE session_id=${sessionId} AND ended_at IS NOT NULL`;
  const minutes = Math.round((totals[0]?.seconds ?? 0) / 60);
  await tx`UPDATE sessions SET status=${outcome},ended_at=${at},active_minutes=${minutes},remaining_after_minutes=0,result_note=${note},version=version+1,updated_at=${recordedAt} WHERE id=${sessionId}`;
}
