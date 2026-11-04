import {
  OCCURRENCE_IN_PROGRESS_MESSAGE,
  commitmentTimelineSchema,
  occurrenceInProgress,
  type CommitmentTimelineWire,
  type EndRecurrenceGoalCommand,
  type RecordCadenceCompletionCommand,
  type SaveCommitmentRecurrenceRuleCommand
} from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { localDayIn, lockRecurrenceRule, recordCadenceCycle } from "./cadence-completion";
import { InvalidCommandError, badValue, notFound, notFoundConflict, refused, versionConflict } from "./command-errors";
import { optionalText, stableUuid } from "./command-values";
import { optionalActiveLocationId } from "./location-context";
import { ensureUser } from "./ensure-user";
import { claimCommandReceipt, commandRequestHash, hasCommandReceipt } from "./command-receipt";
import { recordStateChange } from "./planning-evidence";
import { readStateAfterCommit } from "./read-after-commit";
import { watchCommitmentRecurrenceWrite, watchEndRecurrenceGoal } from "./entity-snapshot";
import type { PoolSql, Sql } from "./sql-pool";
import { WriteSnapshot } from "./write-snapshot";

/**
 * The user's latest non-superseded forecast run's `derivedState.commitmentTimelines`, keyed by
 * commitment id — read and parsed defensively, per commitment-timeline.md: a missing run, a missing
 * field, or an entry that fails `commitmentTimelineSchema` all read as "no stored timeline" for that
 * id, not as a failure of the whole lookup.
 */
async function loadStoredCommitmentTimelines(tx: Sql, userId: string): Promise<Map<string, CommitmentTimelineWire>> {
  const map = new Map<string, CommitmentTimelineWire>();
  const rows = await tx<{ result: unknown }[]>`
    SELECT result FROM planning_runs WHERE user_id=${userId} AND superseded_at IS NULL ORDER BY calculated_at DESC LIMIT 1
  `;
  const result = rows[0]?.result;
  const derivedState =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>).derivedState
      : undefined;
  const timelines =
    derivedState && typeof derivedState === "object" && !Array.isArray(derivedState)
      ? (derivedState as Record<string, unknown>).commitmentTimelines
      : undefined;
  if (!Array.isArray(timelines)) return map;
  for (const entry of timelines) {
    const parsed = commitmentTimelineSchema.safeParse(entry);
    if (parsed.success) map.set(parsed.data.id, parsed.data);
  }
  return map;
}

/**
 * A series save reaching an occurrence already under way (the commitment timeline design note, "Series
 * edit reaching an occurrence in progress"): the rule's non-cancelled, still-`inherit` occurrences are
 * checked against `occurrenceInProgress` before the rule itself is updated. Any in progress with the
 * flag absent refuses the whole save (the caller's transaction then rolls back); `false` marks each of
 * them `custom` with its current (already-current) values so the save leaves it alone; `true` leaves
 * them `inherit` so the edit reaches them too. Returns the ids that were in progress and which answer
 * applied, for the change-log evidence.
 */
async function applyOccurrenceInProgressRule(
  tx: Sql,
  userId: string,
  ruleId: string,
  applyToOccurrenceInProgress: boolean | undefined,
  now: Date,
  snap: WriteSnapshot | null = null
): Promise<{ occurrenceIds: string[]; applied: boolean | undefined }> {
  const occurrences = await tx<{ id: string; starts_at: Date; ends_at: Date }[]>`
    SELECT id, starts_at, ends_at FROM commitments
    WHERE recurrence_rule_id=${ruleId} AND status<>'cancelled' AND schedule_source='inherit'
  `;
  if (!occurrences.length) return { occurrenceIds: [], applied: undefined };
  const timelines = await loadStoredCommitmentTimelines(tx, userId);
  const occurrenceIds = occurrences.map((row) => row.id);
  // "Started" for preparation: a step that has begun ('doing') or already finished ('completed') —
  // the routine_steps status vocabulary also has 'pending', 'blocked', 'cancelled' and 'skipped',
  // none of which mean the person has acted on this occurrence's preparation.
  const preparationRows = await tx<
    { commitment_id: string }[]
  >`SELECT DISTINCT commitment_id FROM routine_steps WHERE commitment_id IN ${tx(occurrenceIds)} AND status IN ('doing','completed')`;
  const preparationStartedIds = new Set(preparationRows.map((row) => row.commitment_id));
  const sessionRows = await tx<
    { target_id: string }[]
  >`SELECT DISTINCT target_id FROM sessions WHERE target_type='fixed_commitment' AND target_id IN ${tx(occurrenceIds)} AND ended_at IS NULL AND status IN ('running','paused','awaiting_feedback')`;
  const sessionOpenIds = new Set(sessionRows.map((row) => row.target_id));
  const inProgressIds = occurrences
    .filter((occurrence) => {
      const timeline = timelines.get(occurrence.id);
      return occurrenceInProgress({
        now,
        startsAt: occurrence.starts_at,
        endsAt: occurrence.ends_at,
        ...(timeline?.setupStartsAt !== undefined ? { setupStartsAt: timeline.setupStartsAt } : {}),
        ...(timeline?.effectiveEndsAt !== undefined ? { effectiveEndsAt: timeline.effectiveEndsAt } : {}),
        preparationStarted: preparationStartedIds.has(occurrence.id),
        sessionOpen: sessionOpenIds.has(occurrence.id)
      });
    })
    .map((occurrence) => occurrence.id);
  if (!inProgressIds.length) return { occurrenceIds: [], applied: undefined };
  if (applyToOccurrenceInProgress === undefined) throw new InvalidCommandError(OCCURRENCE_IN_PROGRESS_MESSAGE);
  if (applyToOccurrenceInProgress === false) {
    // Exactly the occurrences about to be detached, whatever their distance from now.
    await snap?.before("commitments", inProgressIds);
    await tx`UPDATE commitments SET schedule_source='custom', version=version+1, updated_at=${now} WHERE id IN ${tx(inProgressIds)}`;
  }
  return { occurrenceIds: inProgressIds, applied: applyToOccurrenceInProgress };
}

/**
 * Before another person's series change (the recurring-ownership design note under the archived design notes): every
 * still-`inherit` occurrence that has already ended, or is under way by `occurrenceInProgress`, becomes
 * `custom`, so the change reaches only dates still to come — the owner's own series editor asks about
 * an under-way one; another person's change leaves it alone.
 */
export async function detachStartedOccurrences(
  tx: Sql,
  userId: string,
  ruleId: string,
  now = new Date()
): Promise<void> {
  await tx`UPDATE commitments SET schedule_source='custom', version=version+1, updated_at=${now} WHERE user_id=${userId} AND recurrence_rule_id=${ruleId} AND schedule_source='inherit' AND ends_at<=${now}`;
  await applyOccurrenceInProgressRule(tx, userId, ruleId, false, now);
}

export async function saveCommitmentRecurrenceRule(
  sql: PoolSql,
  command: SaveCommitmentRecurrenceRuleCommand
): Promise<PortalState> {
  const userId = await ensureUser(sql);
  const commandId = command.commandId ?? crypto.randomUUID();
  const requestHash = commandRequestHash("save_commitment_recurrence_rule", command);
  if (
    await hasCommandReceipt(sql, { id: commandId, userId, commandType: "save_commitment_recurrence_rule", requestHash })
  )
    return await readStateAfterCommit(sql);
  await sql.begin(async (tx) => {
    if (
      !(await claimCommandReceipt(tx, {
        id: commandId,
        userId,
        commandType: "save_commitment_recurrence_rule",
        requestHash
      }))
    )
      return;
    // An agent's save keeps the rows it touches so it can be undone afterwards (write-snapshot.ts). Opened first:
    // it takes the plan publication lock, which must precede every row lock.
    const snap = await WriteSnapshot.open(tx, userId, commandId, "recurrence");
    const id = await stableUuid(`commitment-recurrence:${userId}`, command.rule.id);
    const existing = await tx<
      { version: number }[]
    >`SELECT version FROM commitment_recurrence_rules WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
    if (existing[0] && command.expectedVersion !== existing[0].version)
      throw versionConflict("recurring commitment", command.rule.id, command.expectedVersion, existing[0].version);
    if (!existing[0] && command.expectedVersion !== null)
      throw notFoundConflict("recurring commitment", command.rule.id);
    const at = new Date();
    await watchCommitmentRecurrenceWrite(snap, id, command.rule.status === "ended");
    // A new rule has no occurrences yet, so it never reaches an occurrence in progress.
    const inProgress = existing[0]
      ? await applyOccurrenceInProgressRule(tx, userId, id, command.applyToOccurrenceInProgress, at, snap)
      : { occurrenceIds: [], applied: undefined };
    const rule = command.rule;
    const status = rule.status ?? "active";
    const projectRaw = optionalText(rule.projectId);
    const projectId = projectRaw ? await stableUuid(`project:${userId}`, projectRaw) : null;
    if (projectId) {
      const owned = await tx<
        { id: string }[]
      >`SELECT p.id FROM projects p JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE p.id=${projectId} AND a.user_id=${userId}`;
      if (!owned[0]) throw notFound("project", projectRaw);
    }
    const locationId = await optionalActiveLocationId(tx, userId, rule.locationId, "Commitment location");
    // A rule that says nothing about presence is a blocking one, the same default the column carries.
    // Occurrences copy whatever lands here when they are materialised and keep tracking it on every
    // later replan — unless one was edited directly, which detaches just that occurrence
    // (presence_source; see persistDerivedState in plan-forecast-runtime.ts).
    const presence = rule.presence ?? "blocking";
    // A rule's shareToCalendar flag controls whether its occurrences publish to the calendar provider family
    // calendar, the same way presence controls engagement level. On insert, absent means false.
    // On update, absent means "no opinion" — the existing value is left untouched, using the same
    // COALESCE pattern as entity-commands.ts.
    const shareToCalendar = rule.shareToCalendar ?? null;
    // Same absent-means-no-opinion rule, for pulse privacy.
    const isPrivate = rule.private ?? null;
    // the repeat union collapses to the DB columns here — the only user-command write —
    // and back in its twin, `portal/server/persistence/postgres/readers/routine-read.ts`.
    const intervalUnit = rule.repeat.unit;
    const intervalDays = rule.repeat.unit === "days" ? rule.repeat.intervalDays : null;
    const intervalWeeks = rule.repeat.unit === "weeks" ? rule.repeat.intervalWeeks : null;
    // the weekday list is stored as a jsonb array, NULL for the other units.
    const weekdays = rule.repeat.unit === "weeks" ? tx.json(rule.repeat.weekdays as never) : null;
    const intervalMonths = rule.repeat.unit === "months" ? rule.repeat.intervalMonths : null;
    const monthAnchor = rule.repeat.unit === "months" ? rule.repeat.anchor : null;
    // contactId: absent leaves the stored value untouched on update (NULL on insert); an empty
    // string (already trimmed by the command schema) clears it; otherwise it is written.
    const contactIdProvided = rule.contactId !== undefined;
    const contactId = rule.contactId ? rule.contactId : null;
    // latenessMatters/transportMode follow the same absent-means-no-opinion rule as contactId: an
    // update that never names them keeps the stored value (the column's own default, true/NULL, on
    // insert). The mode is already validated against the fixed set by `transportModeSchema` at the
    // command boundary, so no further check is needed here.
    // checkInExtraMinutes (pulse check-in allowance): absent keeps the stored value, null clears it.
    const checkInExtraProvided = rule.checkInExtraMinutes !== undefined;
    const checkInExtraMinutes = rule.checkInExtraMinutes ?? null;
    const latenessMattersProvided = rule.latenessMatters !== undefined;
    const transportModeProvided = rule.transportMode !== undefined;
    if (existing[0])
      await tx`UPDATE commitment_recurrence_rules SET title=${rule.title}, timezone=${rule.timezone}, start_date=${rule.startDate}, end_date=${rule.endDate ?? null}, interval_unit=${intervalUnit}, interval_days=${intervalDays}, interval_weeks=${intervalWeeks}, weekdays=${weekdays}, interval_months=${intervalMonths}, month_anchor=${monthAnchor}, local_start_time=${rule.localStartTime}, local_end_time=${rule.localEndTime}, location=${rule.location ?? null}, location_id=${locationId}, setup_before_minutes=${rule.setupBeforeMinutes}, transition_after_minutes=${rule.transitionAfterMinutes}, presence=${presence}, share_to_calendar=COALESCE(${shareToCalendar}, share_to_calendar), status=${status}, project_id=${projectId}, contact_id=CASE WHEN ${contactIdProvided} THEN ${contactId} ELSE contact_id END, lateness_matters=CASE WHEN ${latenessMattersProvided} THEN ${rule.latenessMatters ?? true} ELSE lateness_matters END, transport_mode=CASE WHEN ${transportModeProvided} THEN ${rule.transportMode ?? null} ELSE transport_mode END, private=COALESCE(${isPrivate}, private), check_in_extra_minutes=CASE WHEN ${checkInExtraProvided} THEN ${checkInExtraMinutes}::integer ELSE check_in_extra_minutes END, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
    else
      await tx`INSERT INTO commitment_recurrence_rules (id, user_id, title, timezone, start_date, end_date, interval_unit, interval_days, interval_weeks, weekdays, interval_months, month_anchor, local_start_time, local_end_time, location, location_id, setup_before_minutes, transition_after_minutes, presence, share_to_calendar, status, project_id, contact_id, lateness_matters, transport_mode, private, check_in_extra_minutes) VALUES (${id}, ${userId}, ${rule.title}, ${rule.timezone}, ${rule.startDate}, ${rule.endDate ?? null}, ${intervalUnit}, ${intervalDays}, ${intervalWeeks}, ${weekdays}, ${intervalMonths}, ${monthAnchor}, ${rule.localStartTime}, ${rule.localEndTime}, ${rule.location ?? null}, ${locationId}, ${rule.setupBeforeMinutes}, ${rule.transitionAfterMinutes}, ${presence}, ${shareToCalendar ?? false}, ${status}, ${projectId}, ${contactId}, ${rule.latenessMatters ?? true}, ${rule.transportMode ?? null}, ${isPrivate ?? false}, ${checkInExtraMinutes})`;
    if (status === "ended")
      await tx`DELETE FROM commitments WHERE recurrence_rule_id=${id} AND starts_at>CURRENT_TIMESTAMP`;
    await snap?.save();
    await recordStateChange(tx, userId, {
      entityType: "commitment_recurrence_rule",
      entityId: id,
      operation: "save",
      commandId,
      ...(inProgress.occurrenceIds.length > 0
        ? {
            evidence: {
              occurrenceInProgressIds: inProgress.occurrenceIds,
              applyToOccurrenceInProgress: inProgress.applied
            }
          }
        : {}),
      at
    });
  });
  return await readStateAfterCommit(sql);
}

export async function endRecurrenceGoal(sql: PoolSql, command: EndRecurrenceGoalCommand): Promise<PortalState> {
  const userId = await ensureUser(sql);
  const requestHash = commandRequestHash("end_recurrence_goal", command);
  if (await hasCommandReceipt(sql, { id: command.commandId, userId, commandType: "end_recurrence_goal", requestHash }))
    return await readStateAfterCommit(sql);
  await sql.begin(async (tx) => {
    if (
      !(await claimCommandReceipt(tx, {
        id: command.commandId,
        userId,
        commandType: "end_recurrence_goal",
        requestHash
      }))
    )
      return;
    const snap = await WriteSnapshot.open(tx, userId, command.commandId, "recurrence");
    const actionId = await stableUuid(`action:${userId}`, command.actionId);
    const rule = await tx<
      { id: string; completion_mode: string; completed_at: Date | null }[]
    >`SELECT r.id, r.completion_mode, r.completed_at FROM action_recurrence_rules r JOIN actions ac ON ac.id=r.action_id JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE r.action_id=${actionId} AND a.user_id=${userId} FOR UPDATE`;
    if (!rule[0]) throw new InvalidCommandError("This action has no recurrence to end.");
    if (rule[0].completion_mode === "end_date")
      throw new InvalidCommandError("This recurrence ends on a calendar date, not manually.");
    if (rule[0].completed_at) throw new InvalidCommandError("This recurrence goal is already complete.");
    const at = new Date();
    await watchEndRecurrenceGoal(snap, actionId);
    await tx`UPDATE action_recurrence_rules SET completed_at=${at}, version=version+1, updated_at=${at} WHERE id=${rule[0].id}`;
    await tx`UPDATE actions SET status='done', version=version+1, updated_at=${at} WHERE id=${actionId}`;
    await tx`UPDATE action_occurrences SET status='cancelled', version=version+1, updated_at=${at} WHERE rule_id=${rule[0].id} AND status='pending'`;
    await snap?.save();
    await recordStateChange(tx, userId, {
      entityType: "action",
      entityId: actionId,
      operation: "end_recurrence_goal",
      commandId: command.commandId,
      at
    });
  });
  return await readStateAfterCommit(sql);
}

/**
 * "Done today" for cadence that happened away from the app — a run, a practice session on
 * paper. Dated by local day in the rule's timezone, never in the future, and a day already recorded
 * stays one completion. The action resets for its next cycle exactly as a finished session would.
 */
export async function recordCadenceCompletion(
  sql: PoolSql,
  command: RecordCadenceCompletionCommand
): Promise<PortalState> {
  const userId = await ensureUser(sql);
  const requestHash = commandRequestHash("record_cadence_completion", command);
  if (
    await hasCommandReceipt(sql, {
      id: command.commandId,
      userId,
      commandType: "record_cadence_completion",
      requestHash
    })
  )
    return await readStateAfterCommit(sql);
  await sql.begin(async (tx) => {
    if (
      !(await claimCommandReceipt(tx, {
        id: command.commandId,
        userId,
        commandType: "record_cadence_completion",
        requestHash
      }))
    )
      return;
    const snap = await WriteSnapshot.open(tx, userId, command.commandId, "cadence");
    const actionId = await stableUuid(`action:${userId}`, command.actionId);
    const action = await tx<
      { id: string; scheduling_mode: string; status: string }[]
    >`SELECT ac.id, ac.scheduling_mode, ac.status FROM actions ac JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE ac.id=${actionId} AND a.user_id=${userId} FOR UPDATE`;
    if (!action[0]) throw notFound("action", command.actionId);
    if (action[0].scheduling_mode !== "cadence")
      throw new InvalidCommandError("Only cadence can be marked done for the day.");
    if (["done", "cancelled", "archived"].includes(action[0].status))
      throw new InvalidCommandError("This cadence is already closed.");
    const rule = await lockRecurrenceRule(tx, actionId);
    if (!rule)
      throw refused({
        message: `Action "${command.actionId}" is set to cadence but its cadence rule is missing, so it cannot be marked done.`,
        nextCall: {
          tool: "rhen_show",
          arguments: { entity: "action", id: command.actionId },
          note: "check its scheduling and recurrence"
        }
      });
    if (rule.completed_at) throw new InvalidCommandError("This cadence's goal is already complete.");
    const at = new Date();
    const today = localDayIn(rule.timezone, at);
    if (command.localDate && command.localDate > today)
      throw badValue("date", command.localDate, `it cannot be a day that has not happened yet (today is ${today})`);
    await recordCadenceCycle(tx, {
      actionId,
      rule,
      at,
      snap,
      minutes: command.minutes ?? 0,
      sessionId: null,
      source: "manual",
      ...(command.localDate ? { localDate: command.localDate } : {})
    });
    await snap?.save();
    await recordStateChange(tx, userId, {
      entityType: "action",
      entityId: actionId,
      operation: "record_cadence_completion",
      evidence: { localDate: command.localDate ?? today },
      commandId: command.commandId,
      at
    });
  });
  return await readStateAfterCommit(sql);
}
