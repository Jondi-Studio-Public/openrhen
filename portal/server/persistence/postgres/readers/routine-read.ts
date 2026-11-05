import {
  commitmentRecurrenceRules,
  commitments,
  routinePresetStepDependencies,
  routinePresetSteps,
  routinePresets,
  routineStepDependencies,
  routineSteps,
  sources
} from "@openrhen/database";
import type { PortalState } from "@/state/portal-state";
import type { DbRow, LeftJoined, Row } from "../db-row";
import { localDateString } from "../row-values";
import { mapSleepPlanRow, type SleepPlanRow } from "./sleep-plan-row";
import type { Sql } from "../sql-pool";

type Commitment = PortalState["commitments"][number];
type CommitmentRule = PortalState["commitmentRecurrenceRules"][number];
type Preset = PortalState["routinePresets"][number];
type RoutineStep = PortalState["routineSteps"][number];
type CommitmentSource = NonNullable<PortalState["commitments"][number]["sources"]>[number];

type CommitmentsAndRoutines = Pick<
  PortalState,
  "commitments" | "commitmentRecurrenceRules" | "routineSteps" | "routinePresets" | "sleepPlans"
>;

/**
 * Fixed commitments and everything scheduled around them: recurrence rules, routine steps (one table
 * for both anchors), routine presets, and the sleep plans still in range.
 */
export async function readCommitmentsAndRoutines(sql: Sql, userId: string): Promise<CommitmentsAndRoutines> {
  const commitmentRows = await sql<
    (Row<
      typeof commitments,
      | "id"
      | "version"
      | "title"
      | "starts_at"
      | "ends_at"
      | "status"
      | "location"
      | "location_id"
      | "setup_before_minutes"
      | "transition_after_minutes"
      | "recurrence_rule_id"
      | "local_date"
      | "project_id"
      | "presence"
      | "share_to_calendar"
      | "share_source"
      | "prompt_policy"
      | "routine_source"
      | "routine_preset_id"
      | "origin"
      | "disruption_source"
      | "disruption_open_ended"
      | "landed_at"
      | "created_at"
      | "updated_at"
      | "schedule_source"
      | "lateness_matters"
      | "transport_mode"
      | "contact_id"
      | "attendance"
      | "preferred_location_id"
      | "private"
      | "check_in_extra_minutes"
      | "freed_from"
    > &
      LeftJoined<Row<typeof sources, "source_type">> & {
        status: Commitment["status"];
        presence: Commitment["presence"];
        share_source: Commitment["shareSource"];
        prompt_policy: Commitment["promptPolicy"];
        routine_source: Commitment["routineSource"];
        origin: NonNullable<Commitment["origin"]>;
        disruption_source: NonNullable<Commitment["disruptionSource"]> | null;
        schedule_source: Commitment["scheduleSource"];
        transport_mode: NonNullable<Commitment["transportMode"]> | null;
        attendance: NonNullable<Commitment["attendance"]> | "in_person";
        source_title: string | null;
        tracked_ended_at: Date | null;
        sources: { id: string; provider: CommitmentSource["provider"]; role: CommitmentSource["role"] }[] | null;
      })[]
  >`
      SELECT c.id, c.version, c.title, c.starts_at, c.ends_at, c.status, c.location, c.location_id, c.setup_before_minutes, c.transition_after_minutes, c.recurrence_rule_id, c.local_date, c.project_id, c.presence, c.share_to_calendar, c.share_source, c.prompt_policy, c.routine_source, c.routine_preset_id, c.origin, c.disruption_source, c.disruption_open_ended, c.landed_at, c.created_at, c.updated_at, s.source_type, s.title AS source_title, c.schedule_source, c.lateness_matters, c.transport_mode, c.contact_id, c.attendance, c.preferred_location_id, c.private, c.check_in_extra_minutes, c.freed_from,
        (SELECT json_agg(json_build_object('id', l.id, 'provider', l.provider, 'role', l.role) ORDER BY l.created_at, l.id) FROM calendar_event_links l WHERE l.user_id=c.user_id AND l.commitment_id=c.id) AS sources,
        -- Overtime is the commitment itself running long: a session that began before the scheduled end
        -- and ran past it. One begun after the end is the transition or the drive back being tracked,
        -- which records that time without moving the commitment's end (and so re-opening its transition).
        (SELECT MAX(se.ended_at) FROM sessions se WHERE se.target_type='fixed_commitment' AND se.target_id=c.id AND se.started_at<c.ends_at AND se.ended_at>c.ends_at) AS tracked_ended_at
      FROM commitments c LEFT JOIN sources s ON s.id = c.source_id
      WHERE c.user_id = ${userId} ORDER BY c.starts_at, c.id
    `;
  const commitmentRecurrenceRuleRows = await sql<
    (DbRow<typeof commitmentRecurrenceRules> & {
      presence: CommitmentRule["presence"];
      status: CommitmentRule["status"];
      routine_source: CommitmentRule["routineSource"];
      transport_mode: NonNullable<CommitmentRule["transportMode"]> | null;
    })[]
  >`SELECT * FROM commitment_recurrence_rules WHERE user_id=${userId} ORDER BY title, id`;
  // One routine, one table: a commitment-anchored row is read without a time bound, as
  // before this plan. A sleep-anchored row has no commitments row of its own to expire
  // alongside, so it is bounded the same way the old routine_instances read was (ends_at >
  // CURRENT_TIMESTAMP - INTERVAL '1 day') -- on its own scheduled_end_at, or included regardless when
  // that is somehow unset (a malformed row should never silently vanish from the wire).
  // The app clock, not the database's, so a test that pins the clock keeps the night it is standing in.
  const now = new Date();
  const routineRows = await sql<
    (Row<
      typeof routineSteps,
      | "id"
      | "version"
      | "commitment_id"
      | "anchor_type"
      | "anchor_id"
      | "purpose"
      | "title"
      | "duration_minutes"
      | "sequence"
      | "timing_rule"
      | "max_lead_minutes"
      | "energy"
      | "phase"
      | "contexts"
      | "action_window_id"
      | "cadence_action_id"
      | "preset_step_id"
      | "status"
      | "scheduled_start_at"
      | "scheduled_end_at"
      | "completed_at"
      | "wait_after_minutes"
      | "must_start_by_minutes"
      | "preferred_bands"
    > & {
      anchor_type: RoutineStep["anchorType"];
      purpose: RoutineStep["purpose"] | null;
      timing_rule: RoutineStep["timingRule"];
      phase: RoutineStep["phase"];
      status: RoutineStep["status"];
    })[]
  >`
      SELECT id,version,commitment_id,anchor_type,anchor_id,purpose,title,duration_minutes,sequence,timing_rule,max_lead_minutes,energy,phase,contexts,action_window_id,cadence_action_id,preset_step_id,status,scheduled_start_at,scheduled_end_at,completed_at,wait_after_minutes,must_start_by_minutes,preferred_bands
      FROM routine_steps
      WHERE user_id=${userId}
        AND (anchor_type='commitment' OR scheduled_end_at IS NULL OR scheduled_end_at>${now}::timestamptz-INTERVAL '1 day')
      ORDER BY anchor_id,sequence`;
  const routineDependencyRows = await sql<
    Row<typeof routineStepDependencies, "step_id" | "depends_on_step_id">[]
  >`SELECT d.step_id,d.depends_on_step_id FROM routine_step_dependencies d JOIN routine_steps s ON s.id=d.step_id WHERE s.user_id=${userId}`;
  const presetRows = await sql<
    (Row<typeof routinePresets, "id" | "version" | "name" | "activity_name" | "status" | "replaces_wake_routine"> & {
      status: Preset["status"];
    })[]
  >`SELECT id,version,name,activity_name,status,replaces_wake_routine FROM routine_presets WHERE user_id=${userId} ORDER BY name,id`;
  const presetStepRows = await sql<
    (DbRow<typeof routinePresetSteps> & {
      timing_rule: Preset["steps"][number]["timingRule"];
      phase: Preset["steps"][number]["phase"];
    })[]
  >`SELECT s.* FROM routine_preset_steps s JOIN routine_presets p ON p.id=s.preset_id WHERE p.user_id=${userId} ORDER BY s.preset_id,s.sequence`;
  const presetDependencyRows = await sql<
    Row<typeof routinePresetStepDependencies, "step_id" | "depends_on_step_id">[]
  >`SELECT d.step_id,d.depends_on_step_id FROM routine_preset_step_dependencies d JOIN routine_preset_steps s ON s.id=d.step_id JOIN routine_presets p ON p.id=s.preset_id WHERE p.user_id=${userId}`;
  const sleepRows = await sql<SleepPlanRow[]>`
      SELECT id,version,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,sleep_deficit_minutes,anchor_deviation_minutes,hard_errors,explanation,status,actual_start_at,actual_wake_at,input_version,score_components,stay_up_answer_minutes,placement_choice FROM sleep_plans WHERE user_id=${userId} AND (planned_wake_at > ${now}::timestamptz - INTERVAL '1 day' OR (input_version='manual' AND planned_wake_at > ${now}::timestamptz - INTERVAL '14 days')) ORDER BY planned_start_at`;
  return {
    commitments: commitmentRows.map((row) => ({
      id: row.id,
      version: row.version,
      title: row.title,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      status: row.status,
      setupBeforeMinutes: row.setup_before_minutes,
      transitionAfterMinutes: row.transition_after_minutes,
      ...(row.location ? { location: row.location } : {}),
      ...(row.location_id ? { locationId: row.location_id } : {}),
      ...(row.recurrence_rule_id
        ? { recurrenceRuleId: row.recurrence_rule_id, localDate: localDateString(row.local_date!) }
        : {}),
      ...(row.project_id ? { projectId: row.project_id } : {}),
      presence: row.presence,
      shareToCalendar: row.share_to_calendar,
      shareSource: row.share_source,
      scheduleSource: row.schedule_source,
      latenessMatters: row.lateness_matters,
      ...(row.transport_mode ? { transportMode: row.transport_mode } : {}),
      ...(row.contact_id ? { contactId: row.contact_id } : {}),
      ...(row.attendance === "remote" ? { attendance: row.attendance } : {}),
      ...(row.preferred_location_id ? { preferredLocationId: row.preferred_location_id } : {}),
      promptPolicy: row.prompt_policy,
      routineSource: row.routine_source,
      ...(row.routine_preset_id ? { routinePresetId: row.routine_preset_id } : {}),
      ...(row.origin === "disruption" ? { origin: row.origin } : {}),
      ...(row.disruption_source ? { disruptionSource: row.disruption_source } : {}),
      ...(row.disruption_open_ended ? { disruptionOpenEnded: true } : {}),
      ...(row.landed_at ? { landedAt: row.landed_at.toISOString() } : {}),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      ...(row.source_type ? { sourceType: row.source_type } : {}),
      ...(row.source_title ? { sourceTitle: row.source_title } : {}),
      // Only ever the latest *finished* session's end, and only when it actually ran past the
      // commitment's own `ends_at` (the query above already filters to that) — a live overtime
      // session is a separate signal the engine reads from `state.activeSession` directly (see
      // `effectiveCommitmentEnd`, engine/core/src/model/types.ts).
      ...(row.tracked_ended_at ? { trackedEndedAt: row.tracked_ended_at.toISOString() } : {}),
      // "I'm free" (`freed_from`): read for every row, recurring and feed occurrences included, because the
      // engine overlays it onto the regenerated occurrence whether or not the row is `custom`.
      ...(row.freed_from ? { freedFrom: row.freed_from.toISOString() } : {}),
      ...(row.private ? { private: true } : {}),
      ...(row.check_in_extra_minutes != null ? { checkInExtraMinutes: row.check_in_extra_minutes } : {}),
      ...(row.sources?.length ? { sources: row.sources } : {})
    })),
    commitmentRecurrenceRules: commitmentRecurrenceRuleRows.map((row) => ({
      id: row.id,
      version: row.version,
      title: row.title,
      timezone: row.timezone,
      startDate: localDateString(row.start_date),
      ...(row.end_date ? { endDate: localDateString(row.end_date) } : {}),
      // the three columns expand back into the repeat union here, the inverse of the collapse
      // in `recurrence-commands.ts` (the only write). `interval_unit` is the discriminant; a monthly
      // rule's ordinal and weekday are derived from `startDate`, so no further column is needed.
      repeat:
        row.interval_unit === "weeks"
          ? { unit: "weeks" as const, intervalWeeks: row.interval_weeks!, weekdays: row.weekdays! }
          : row.interval_unit === "months"
            ? { unit: "months" as const, intervalMonths: row.interval_months!, anchor: row.month_anchor! }
            : { unit: "days" as const, intervalDays: row.interval_days! },
      localStartTime: String(row.local_start_time).slice(0, 5),
      localEndTime: String(row.local_end_time).slice(0, 5),
      ...(row.location ? { location: row.location } : {}),
      ...(row.location_id ? { locationId: row.location_id } : {}),
      setupBeforeMinutes: row.setup_before_minutes,
      transitionAfterMinutes: row.transition_after_minutes,
      presence: row.presence,
      status: row.status,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      shareToCalendar: row.share_to_calendar,
      routineSource: row.routine_source,
      ...(row.routine_preset_id ? { routinePresetId: row.routine_preset_id } : {}),
      latenessMatters: row.lateness_matters,
      ...(row.transport_mode ? { transportMode: row.transport_mode } : {}),
      ...(row.contact_id ? { contactId: row.contact_id } : {}),
      ...(row.private ? { private: true } : {}),
      ...(row.check_in_extra_minutes != null ? { checkInExtraMinutes: row.check_in_extra_minutes } : {})
    })),
    routineSteps: routineRows.map((row) => ({
      id: row.id,
      version: row.version,
      // One routine, one table: `commitmentId` is carried only for a commitment-anchored row
      // (kept for its FK/cascade into `commitments`); a sleep-anchored row carries
      // `anchorType`/`anchorId`/`purpose` instead — `existingSleepStep` (engine/core's own reconciliation
      // lookup) matches a persisted row against a fresh template by exactly these three fields, so a
      // sleep-anchored row must always emit them.
      ...(row.commitment_id ? { commitmentId: row.commitment_id } : {}),
      anchorType: row.anchor_type,
      anchorId: row.anchor_id,
      ...(row.purpose ? { purpose: row.purpose } : {}),
      title: row.title,
      durationMinutes: row.duration_minutes,
      sequence: row.sequence,
      timingRule: row.timing_rule,
      energy: row.energy,
      phase: row.phase,
      contexts: Array.isArray(row.contexts)
        ? row.contexts.filter((value): value is string => typeof value === "string")
        : [],
      dependencyIds: routineDependencyRows
        .filter((edge) => edge.step_id === row.id)
        .map((edge) => edge.depends_on_step_id),
      status: row.status,
      ...(row.action_window_id ? { actionWindowId: row.action_window_id } : {}),
      ...(row.cadence_action_id ? { cadenceActionId: row.cadence_action_id } : {}),
      ...(row.preset_step_id ? { presetStepId: row.preset_step_id } : {}),
      ...(row.max_lead_minutes !== null ? { maxLeadMinutes: row.max_lead_minutes } : {}),
      ...(row.scheduled_start_at ? { scheduledStartAt: row.scheduled_start_at.toISOString() } : {}),
      ...(row.scheduled_end_at ? { scheduledEndAt: row.scheduled_end_at.toISOString() } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}),
      waitAfterMinutes: row.wait_after_minutes,
      ...(row.must_start_by_minutes !== null ? { mustStartByMinutes: row.must_start_by_minutes } : {}),
      preferredBands: Array.isArray(row.preferred_bands)
        ? row.preferred_bands.filter((value): value is string => typeof value === "string")
        : []
    })),
    routinePresets: presetRows.map((row) => ({
      id: row.id,
      version: row.version,
      name: row.name,
      activityName: row.activity_name,
      status: row.status,
      replacesWakeRoutine: row.replaces_wake_routine,
      steps: presetStepRows
        .filter((step) => step.preset_id === row.id)
        .map((step) => ({
          id: step.id,
          title: step.title,
          durationMinutes: step.duration_minutes,
          sequence: step.sequence,
          timingRule: step.timing_rule,
          energy: step.energy,
          phase: step.phase,
          contexts: Array.isArray(step.contexts) ? step.contexts : [],
          dependencyIds: presetDependencyRows
            .filter((edge) => edge.step_id === step.id)
            .map((edge) => edge.depends_on_step_id),
          ...(step.max_lead_minutes !== null ? { maxLeadMinutes: step.max_lead_minutes } : {}),
          ...(step.action_window_id ? { actionWindowId: step.action_window_id } : {}),
          ...(step.cadence_action_id ? { cadenceActionId: step.cadence_action_id } : {}),
          waitAfterMinutes: step.wait_after_minutes,
          ...(step.must_start_by_minutes !== null ? { mustStartByMinutes: step.must_start_by_minutes } : {}),
          preferredBands: Array.isArray(step.preferred_bands)
            ? step.preferred_bands.filter((value: unknown): value is string => typeof value === "string")
            : []
        }))
    })),
    sleepPlans: sleepRows.map(mapSleepPlanRow)
  };
}
