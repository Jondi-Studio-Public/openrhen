import { deriveEstimateCalibration, type CalibrationSample } from "@openrhen/contracts";
import { actions, checkIns, outcomes, sessionSegments, sessions } from "@openrhen/database";
import type { ActiveSession, PortalState } from "@/state/portal-state";
import type { Row } from "../db-row";
import { readCheckInTrail } from "./check-in-read";
import type { Sql } from "../sql-pool";

type SessionsRead = Pick<PortalState, "completedToday" | "activeSession" | "lastEndedSessions">;

/** Finished sessions since `historySince`, the latest ended one per target, and the live session. */
export async function readSessions(sql: Sql, userId: string, historySince: Date): Promise<SessionsRead> {
  // Despite the field's name this was never bounded to today, or to anything: it selected every
  // finished session the install had ever recorded, on every poll. Now the last HISTORY_WINDOW_DAYS
  // local days (`portal/shared/history-window.ts`). No upper bound — a session may legitimately end in
  // the future relative to the read (a seeded fixture, a clock skew), and cutting those would lose real
  // rows to no purpose.
  const completedRows = await sql<
    (Row<
      typeof sessions,
      | "id"
      | "action_id"
      | "occurrence_id"
      | "target_id"
      | "target_type"
      | "status"
      | "started_at"
      | "started_recorded_at"
      | "started_by"
      | "planned_minutes"
      | "active_minutes"
      | "remaining_before_minutes"
      | "remaining_after_minutes"
      | "result_note"
      | "blocking_reason"
      | "override_reason"
    > & {
      title: string;
      status: PortalState["completedToday"][number]["result"];
      target_type: NonNullable<PortalState["completedToday"][number]["targetType"]>;
      started_at: Date;
      ended_at: Date;
      segment_count: number;
      active_seconds: number;
    })[]
  >`
      SELECT se.id, se.action_id, se.occurrence_id, se.target_id, se.target_type, COALESCE(se.target_title,ac.title,'Activity') AS title, se.status, se.started_at, se.started_recorded_at, se.started_by, se.ended_at, se.planned_minutes,
        se.active_minutes, se.remaining_before_minutes, se.remaining_after_minutes, se.result_note, se.blocking_reason, se.override_reason,
        COUNT(ss.id)::int AS segment_count, COALESCE(SUM(EXTRACT(EPOCH FROM (ss.ended_at - ss.started_at))), 0)::int AS active_seconds
      FROM sessions se LEFT JOIN actions ac ON ac.id = se.action_id
      LEFT JOIN session_segments ss ON ss.session_id=se.id
      WHERE se.user_id = ${userId} AND se.status IN ('completed', 'stopped', 'blocked', 'did_not_start', 'skipped') AND se.ended_at IS NOT NULL
        AND se.ended_at >= ${historySince}
      GROUP BY se.id, ac.title
      ORDER BY se.ended_at
    `;
  // The latest *ended* session per target — action or deliverable, keyed by `action_id` or, for a
  // deliverable, `target_id` — for the maximum-session break (the ranking consistency design note,
  // "Break, data"). A paused or still-running session has `ended_at IS NULL` and never counts.
  const lastEndedSessionRows = await sql<
    (Row<typeof sessions, "ended_at" | "active_minutes"> & { ended_at: Date; target_id: string })[]
  >`
      SELECT DISTINCT ON (target_key) target_key AS target_id, ended_at, active_minutes
      FROM (
        SELECT (CASE WHEN target_type = 'deliverable' THEN target_id ELSE action_id END) AS target_key,
          ended_at, active_minutes
        FROM sessions
        WHERE user_id = ${userId} AND ended_at IS NOT NULL
          AND ((target_type = 'deliverable' AND target_id IS NOT NULL) OR (target_type <> 'deliverable' AND action_id IS NOT NULL))
      ) AS latest
      ORDER BY target_key, ended_at DESC
    `;
  const activeRows = await sql<
    (Row<
      typeof sessions,
      | "id"
      | "action_id"
      | "occurrence_id"
      | "target_id"
      | "target_step_id"
      | "target_type"
      | "target_title"
      | "status"
      | "started_at"
      | "started_recorded_at"
      | "started_by"
      | "planned_end_at"
      | "planned_minutes"
      | "active_minutes"
      | "remaining_before_minutes"
      | "paused_remaining_seconds"
      | "feedback_requested_at"
      | "result_note"
      | "version"
    > & {
      status: "running" | "paused" | "awaiting_feedback";
      target_type: NonNullable<ActiveSession["targetType"]>;
      started_at: Date;
    })[]
  >`
      SELECT id, action_id, occurrence_id, target_id, target_step_id, target_type, target_title, status, started_at, started_recorded_at, started_by, planned_end_at, planned_minutes, active_minutes,
        remaining_before_minutes, paused_remaining_seconds, feedback_requested_at, result_note, version
      FROM sessions WHERE user_id = ${userId} AND ended_at IS NULL AND status IN ('running', 'paused', 'awaiting_feedback')
      ORDER BY created_at DESC LIMIT 1
    `;
  const activeSegmentRows = await sql<
    Row<typeof sessionSegments, "session_id" | "started_at" | "ended_at" | "step_id">[]
  >`
      SELECT session_id, started_at, ended_at, step_id FROM session_segments
      WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ${userId} AND ended_at IS NULL)
      ORDER BY started_at
    `;
  const active = activeRows[0];
  const activeSegments = active ? activeSegmentRows.filter((segment) => segment.session_id === active.id) : [];
  const activeElapsedSeconds = activeSegments.reduce(
    (sum, segment) =>
      segment.ended_at
        ? sum + Math.max(0, Math.floor((segment.ended_at.getTime() - segment.started_at.getTime()) / 1000))
        : sum,
    0
  );
  const openSegment = activeSegments.find((segment) => segment.ended_at === null);
  // Pausing closes the open segment, so a paused session's latest segment end is when it was paused;
  // freshness ages a paused session from there. One paused and then moved to awaiting feedback keeps
  // `paused_remaining_seconds`, and its end is that pause too.
  const pausedAt =
    active?.status === "paused" || (active?.status === "awaiting_feedback" && active.paused_remaining_seconds !== null)
      ? activeSegments.reduce<Date | null>(
          (latest, segment) => (segment.ended_at && (!latest || segment.ended_at > latest) ? segment.ended_at : latest),
          null
        )
      : null;
  // Per-step totals come from the same segments as the whole-session total, so the two cannot
  // disagree. Only closed segments count; the open one is still being lived through.
  const stepSeconds = activeSegments.reduce<Record<string, number>>((totals, segment) => {
    if (!segment.step_id || !segment.ended_at) return totals;
    const elapsed = Math.max(0, Math.floor((segment.ended_at.getTime() - segment.started_at.getTime()) / 1000));
    return { ...totals, [segment.step_id]: (totals[segment.step_id] ?? 0) + elapsed };
  }, {});
  const activeStatus: ActiveSession["status"] =
    active?.status === "paused" ? "paused" : active?.status === "running" ? "running" : "feedback";
  // `unansweredCheckIns` stays deliverable-only — check-ins only exist for `directive_kind='deliverable'`
  // for that field's one consumer (`now-model.ts`'s `reconciliationDue`, itself gated to a deliverable
  // session already; see the session reconciliation design note, "Interfaces and contracts").
  //
  // `lastVerifiedAt` is the pulse resolver's "when last confirmed" (the pulse resolver design note,
  //) and widens to every session target type a check-in can actually be asked about, mirroring
  // `check-in-scheduler.ts`'s own `SESSION_TARGET_BELIEF_KIND` — duplicated rather than imported
  // because that map is a private `const`, not exported from `@openrhen/database`, and it is
  // `check_in.directive_kind` vocabulary (wider than `Pulse.doing`'s five nouns: it also has
  // `open_anchor`/`protected_commitment`/`routine_instance`), not something `pulse.ts` should carry
  // either. `routine_instance` and `sleep` are absent here: a `routine_instance` session has no
  // `Pulse.doing` noun of its own (see `pulse.ts`), and a sleep session never reaches here at all —
  // `isSleepWindow` silences the scheduler before a check-in row could ever exist for it.
  const SESSION_TARGET_CHECK_IN_KIND: Partial<Record<string, string>> = {
    action: "action",
    deliverable: "deliverable",
    routine_step: "routine_step",
    fixed_commitment: "protected_commitment"
  };
  let unansweredCheckIns: number | undefined;
  let lastVerifiedAt: string | undefined;
  if (active && active.target_type === "deliverable") {
    const trail = await readCheckInTrail(sql, userId, active.id);
    if (trail) unansweredCheckIns = trail.rows.length;
  }
  const checkInKind = active ? SESSION_TARGET_CHECK_IN_KIND[active.target_type] : undefined;
  // A plain action session (`session-commands.ts`'s `start`, as opposed to `start_activity`) never
  // sets `sessions.target_id` — only `start_activity`'s targets (routine step, commitment, ...) do —
  // so the id to match a check-in against falls back the same way the wire `activeSession.targetId`
  // just above already does: the occurrence if this is a recurring or cadence action, else the action
  // itself.
  const checkInTargetId = active ? (active.target_id ?? active.occurrence_id ?? active.action_id) : undefined;
  if (active && checkInKind && checkInTargetId) {
    const lastOnTrack = await sql<Row<typeof checkIns, "slot_at">[]>`
      SELECT slot_at FROM check_in
      WHERE user_id = ${userId}
        AND slot_at >= ${active.started_at}
        AND directive_kind = ${checkInKind}
        AND directive_target_id = ${checkInTargetId}
        AND status = 'on_track'
      ORDER BY slot_at DESC
      LIMIT 1
    `;
    lastVerifiedAt =
      lastOnTrack[0]?.slot_at.toISOString() ?? openSegment?.started_at.toISOString() ?? active.started_at.toISOString();
  }
  return {
    completedToday: completedRows.map((row) => ({
      id: row.id,
      actionId: row.occurrence_id ?? row.action_id ?? row.target_id ?? "",
      actionTitle: row.title,
      targetType: row.target_type,
      result: row.status,
      startedAt: row.started_at.toISOString(),
      ...(row.started_recorded_at ? { startedRecordedAt: row.started_recorded_at.toISOString() } : {}),
      ...(row.started_by ? { startedBy: row.started_by } : {}),
      endedAt: row.ended_at.toISOString(),
      plannedMinutes: row.planned_minutes,
      activeMinutes: Math.round(row.active_seconds / 60),
      remainingBeforeMinutes: row.remaining_before_minutes,
      remainingAfterMinutes: row.remaining_after_minutes ?? 0,
      segmentCount: row.segment_count,
      ...(row.result_note ? { resultNote: row.result_note } : {}),
      ...(row.blocking_reason ? { blockingReason: row.blocking_reason } : {}),
      ...(row.override_reason ? { overrideReason: row.override_reason } : {})
    })),
    activeSession: active
      ? {
          id: active.id,
          version: active.version,
          actionId: active.occurrence_id ?? active.action_id ?? active.target_id ?? "",
          targetType: active.target_type,
          targetId: active.target_id ?? active.occurrence_id ?? active.action_id ?? "",
          ...(active.target_step_id ? { stepId: active.target_step_id } : {}),
          targetTitle: active.target_title ?? undefined,
          status: activeStatus,
          startedAt: active.started_at.toISOString(),
          ...(active.started_recorded_at ? { startedRecordedAt: active.started_recorded_at.toISOString() } : {}),
          ...(active.started_by ? { startedBy: active.started_by } : {}),
          plannedEndAt: active.planned_end_at.toISOString(),
          plannedMinutes: active.planned_minutes,
          remainingBeforeMinutes: active.remaining_before_minutes,
          activeElapsedSeconds: activeElapsedSeconds || active.active_minutes * 60,
          stepSeconds,
          ...(openSegment ? { segmentStartedAt: openSegment.started_at.toISOString() } : {}),
          ...(active.feedback_requested_at ? { feedbackRequestedAt: active.feedback_requested_at.toISOString() } : {}),
          ...(pausedAt ? { pausedAt: pausedAt.toISOString() } : {}),
          ...(active.paused_remaining_seconds !== null
            ? { pausedRemainingSeconds: active.paused_remaining_seconds }
            : {}),
          ...(active.result_note ? { note: active.result_note } : {}),
          ...(unansweredCheckIns !== undefined ? { unansweredCheckIns } : {}),
          ...(lastVerifiedAt !== undefined ? { lastVerifiedAt } : {})
        }
      : null,
    lastEndedSessions: lastEndedSessionRows.map((row) => ({
      targetId: row.target_id,
      endedAt: row.ended_at.toISOString(),
      focusedMinutes: row.active_minutes
    }))
  };
}

/** The sample the estimate calibration is derived from, with the factor itself. */
export async function readEstimateCalibration(sql: Sql, userId: string): Promise<PortalState["estimateCalibration"]> {
  return deriveEstimateCalibration(await readCalibrationSamples(sql, userId));
}

/**
 * One sample per finished one-off action that has timed sessions (logic design §5 "Learned
 * calibration"): the effort its first session started from, less what its last session left,
 * against the minutes its sessions ran. Session columns, not the action's current estimate, so
 * editing an action later never rewrites what it taught. The newest 200 keep the factor current.
 */
async function readCalibrationSamples(sql: Sql, userId: string): Promise<CalibrationSample[]> {
  const rows = await sql<
    (Row<typeof actions, "completed_at"> &
      Row<typeof outcomes, "area_id"> & {
        completed_at: Date;
        action_id: string;
        estimated_minutes: number;
        actual_minutes: number;
      })[]
  >`
    SELECT a.id AS action_id, o.area_id, a.completed_at,
      (
        SELECT s1.remaining_before_minutes FROM sessions s1
        WHERE s1.target_type = 'action' AND s1.action_id = a.id AND s1.ended_at IS NOT NULL
          AND s1.status IN ('completed','stopped','blocked')
        ORDER BY s1.started_at ASC, s1.created_at ASC LIMIT 1
      ) - COALESCE((
        SELECT s2.remaining_after_minutes FROM sessions s2
        WHERE s2.target_type = 'action' AND s2.action_id = a.id AND s2.ended_at IS NOT NULL
          AND s2.status IN ('completed','stopped','blocked')
        ORDER BY s2.ended_at DESC LIMIT 1
      ), 0) AS estimated_minutes,
      (
        SELECT SUM(s3.active_minutes) FROM sessions s3
        WHERE s3.target_type = 'action' AND s3.action_id = a.id AND s3.ended_at IS NOT NULL
          AND s3.status IN ('completed','stopped','blocked')
      ) AS actual_minutes
    FROM actions a
    JOIN projects p ON p.id = a.project_id
    JOIN outcomes o ON o.id = p.outcome_id
    JOIN areas ar ON ar.id = o.area_id
    WHERE ar.user_id = ${userId} AND a.status IN ('done', 'archived') AND a.scheduling_mode = 'one_off'
      AND a.deliverable_id IS NULL AND a.completed_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM sessions s0
        WHERE s0.target_type = 'action' AND s0.action_id = a.id AND s0.ended_at IS NOT NULL
          AND s0.status IN ('completed','stopped','blocked')
      )
    ORDER BY a.completed_at DESC
    LIMIT 200
  `;
  return rows.map((row) => ({
    actionId: row.action_id,
    areaId: row.area_id,
    completedAt: row.completed_at.toISOString(),
    estimatedMinutes: Number(row.estimated_minutes),
    actualMinutes: Number(row.actual_minutes)
  }));
}
