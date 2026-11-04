import {
  DEFAULT_TIMEZONE,
  IMPORT_REMOVED_REASON_PREFIX,
  isImportRemovedClose,
  normalizeRepeatWeekdays,
  type ImportRecord
} from "@openrhen/contracts";
import { replaceCommitmentRoutineSteps, type CommitmentRoutineStepInput } from "@openrhen/database";
import { fieldValue, isAbsentColumn } from "@/features/imports/import-validation";
import { createManualLink } from "../plan-map-store";
import { planLinkInput } from "./key-resolution";
import { localDayIn } from "../cadence-completion";
import { stableUuid } from "../command-values";
import { actorName } from "../close-commands";
import type { Sql } from "../sql-pool";
import { restoreBatch } from "../close-cascade";
import { closeCommitmentAsSystem, type LockedSystemClose } from "../system-close";
import { ImportConflictError } from "./import-conflict-error";
import { isPrimarySourceCreate } from "./primary-source";

/**
 * Writing one resolved import record into its planning table: an INSERT for a create, an UPDATE for
 * an update that first checks the row is still the version the preview saw. Every upsert reads its
 * values through `v(name)` and applies the one absent-versus-blank rule (see `columnSetter`), so the
 * question "what does an update do to a column the sheet left out" has a single answer.
 */

/** The value of a record's field, as the upserts read it. */
export type FieldReader = (name: string) => any;

/** Every field of the record, by name; the upserts take this rather than reaching into the record. */
export function fieldReader(record: ImportRecord): FieldReader {
  return (name: string) => fieldValue(record, name) as any;
}

/**
 * A fixed commitment the source removed (a cancelled event, or one gone from the read): the version must still match,
 * then it is cancelled, not deleted (archive-removals design section 7). Its import key and its calendar links stay, so
 * an event that comes back finds the row. See `closeCommitmentAsSystem`.
 */
export async function assertAndCloseCommitment(
  sql: Sql,
  userId: string,
  id: string,
  record: ImportRecord,
  close: ImportCloseContext
) {
  await assertVersion(sql, "commitments", id, { ...record, operation: "update" });
  await closeCommitmentAsSystem(sql, {
    userId,
    id,
    why: sourceRemovalWhy(record),
    batchId: close.batchId,
    planned: close.plans?.get(id)
  });
}

/** What the commit knows of the batch that a source removal is part of. */
export interface ImportCloseContext {
  /** The import batch id: the close batch and the ledger rows' command id. */
  batchId?: string | undefined;
  /** The close plans the brake counted, by commitment id. */
  plans?: ReadonlyMap<string, LockedSystemClose> | undefined;
}

/** A record the calendar feed derived from its own read (a date's change, a moved date, a series): the source's say, not a reviewer's edit. */
const isFeedRecord = (record: ImportRecord) => Object.keys(record.relationships).some((key) => key.startsWith("feed"));

/** The reason a record gives for the source's removal (`Cancelled in Google Calendar`), else a generic one. */
export function sourceRemovalWhy(record: ImportRecord): string {
  for (const field of Object.values(record.fields)) {
    const first = field.evidence?.[0];
    if (first) return first;
  }
  return "No longer in the source";
}

/**
 * The SQL value of a commitment's `status` when an import writes it. A cancelled row is never reopened by an import
 * unless its close carries the import-removed marker (`closed_by = 'system'` and a reason starting with
 * {@link IMPORT_REMOVED_REASON_PREFIX}, tested with `starts_with`, never `LIKE` on text). An incoming `cancelled` leaves the
 * status as it is: the cancellation is the close helper's, which stamps it, cascades it and records it. Both the commitment
 * upsert and the feed's date insert use this one fragment, so no import path can write over a closed row.
 */
export function guardedStatus(sql: Sql, incoming: string | null | ReturnType<Sql>) {
  return sql`CASE
    WHEN ${incoming}::text = 'cancelled' THEN commitments.status
    WHEN commitments.status = 'cancelled' AND NOT (commitments.closed_by = 'system' AND starts_with(COALESCE(commitments.closed_reason, ''), ${IMPORT_REMOVED_REASON_PREFIX})) THEN commitments.status
    ELSE ${incoming}::text
  END`;
}

async function assertVersion(sql: Sql, table: string, id: string, record: ImportRecord) {
  if (record.operation === "update") {
    const rows = (await sql.unsafe(`SELECT version FROM ${table} WHERE id=$1 FOR UPDATE`, [id])) as unknown as {
      version: number;
    }[];
    if (rows[0]?.version !== record.expectedVersion)
      throw new ImportConflictError(`${record.entityType} ${record.importKey} changed after preview.`);
  }
}
/**
 * One `column=value` clause of an UPDATE, under the one rule every upsert applies: a field whose
 * column the source did not carry sets the column to itself — a no-op that leaves the stored value
 * exactly as it was — and a field the source did carry, blank or not, is written as it stands, so a
 * blank cell clears (NULL for a scalar, empty for a list). Inserts never come through here: a create
 * has nothing to keep, so an absent column simply lands as null or the column's default.
 */
function columnSetter(sql: Sql, r: ImportRecord) {
  return (column: string, field: string, value: any) =>
    isAbsentColumn(r, field) ? sql`${sql(column)}=${sql(column)}` : sql`${sql(column)}=${value}`;
}
const timestampOrNull = (value: unknown) => (value ? new Date(String(value)) : null);
export async function upsertArea(sql: Sql, userId: string, id: string, r: ImportRecord, v: (n: string) => any) {
  await assertVersion(sql, "areas", id, r);
  const set = columnSetter(sql, r);
  if (r.operation === "create")
    await sql`INSERT INTO areas(id,user_id,name,description,status,sort_order) VALUES(${id},${userId},${v("name")},${v("description")},${v("status")},${v("sortOrder")})`;
  else
    await sql`UPDATE areas SET ${set("name", "name", v("name"))},${set("description", "description", v("description"))},${set("status", "status", v("status"))},${set("sort_order", "sortOrder", v("sortOrder"))},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
}
export async function upsertOutcome(sql: Sql, id: string, areaId: string, r: ImportRecord, v: (n: string) => any) {
  await assertVersion(sql, "outcomes", id, r);
  const set = columnSetter(sql, r);
  if (r.operation === "create")
    await sql`INSERT INTO outcomes(id,area_id,title,definition_of_done,value,status,deadline_at,review_on) VALUES(${id},${areaId},${v("title")},${v("definitionOfDone")},${v("value")},${v("status")},${timestampOrNull(v("deadlineAt"))},${v("reviewOn")})`;
  else
    await sql`UPDATE outcomes SET area_id=${areaId},${set("title", "title", v("title"))},${set("definition_of_done", "definitionOfDone", v("definitionOfDone"))},${set("value", "value", v("value"))},${set("status", "status", v("status"))},${set("deadline_at", "deadlineAt", timestampOrNull(v("deadlineAt")))},${set("review_on", "reviewOn", v("reviewOn"))},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
}
export async function upsertProject(sql: Sql, id: string, outcomeId: string, r: ImportRecord, v: (n: string) => any) {
  await assertVersion(sql, "projects", id, r);
  const set = columnSetter(sql, r);
  if (r.operation === "create")
    await sql`INSERT INTO projects(id,outcome_id,title,status,uncertainty,consequence,internal_deadline_at,external_deadline_at,remaining_effort_override_minutes) VALUES(${id},${outcomeId},${v("title")},${v("status")},${v("uncertainty")},${v("consequence")},${timestampOrNull(v("internalDeadlineAt"))},${timestampOrNull(v("externalDeadlineAt"))},${v("remainingEffortOverrideMinutes")})`;
  else
    await sql`UPDATE projects SET outcome_id=${outcomeId},${set("title", "title", v("title"))},${set("status", "status", v("status"))},${set("uncertainty", "uncertainty", v("uncertainty"))},${set("consequence", "consequence", v("consequence"))},${set("internal_deadline_at", "internalDeadlineAt", timestampOrNull(v("internalDeadlineAt")))},${set("external_deadline_at", "externalDeadlineAt", timestampOrNull(v("externalDeadlineAt")))},${set("remaining_effort_override_minutes", "remainingEffortOverrideMinutes", v("remainingEffortOverrideMinutes"))},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
}
export async function upsertDeliverable(
  sql: Sql,
  id: string,
  projectId: string,
  r: ImportRecord,
  v: (n: string) => any
) {
  await assertVersion(sql, "deliverables", id, r);
  const set = columnSetter(sql, r);
  if (r.operation === "create")
    await sql`INSERT INTO deliverables(id,project_id,title,details,status,uncertainty,importance,consequence,internal_deadline_at,external_deadline_at) VALUES(${id},${projectId},${v("title")},${v("details")},${v("status")},${v("uncertainty")},${v("importance")},${v("consequence")},${timestampOrNull(v("internalDeadlineAt"))},${timestampOrNull(v("externalDeadlineAt"))})`;
  else
    await sql`UPDATE deliverables SET project_id=${projectId},${set("title", "title", v("title"))},${set("details", "details", v("details"))},status=${isAbsentColumn(r, "status") ? sql`status` : sql`CASE WHEN last_worked_at IS NULL AND contract_version=0 AND plan_version=0 THEN ${v("status")}::deliverable_status ELSE status END`},${set("uncertainty", "uncertainty", v("uncertainty"))},${set("importance", "importance", v("importance"))},${set("consequence", "consequence", v("consequence"))},${set("internal_deadline_at", "internalDeadlineAt", timestampOrNull(v("internalDeadlineAt")))},${set("external_deadline_at", "externalDeadlineAt", timestampOrNull(v("externalDeadlineAt")))},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
}
/**
 * What one sheet said about a cadence. A positive interval makes the action a cadence, an explicit
 * `0` turns an existing one back into ordinary work, and null — a blank cell, or a column the file
 * never carried — says nothing at all, so whatever the action already is stands. Blank does not
 * downgrade: a sheet written before the column existed must not silently end a cadence.
 */
function cadenceInterval(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const days = Number(value);
  return Number.isInteger(days) && days >= 0 ? days : null;
}

/**
 * The recurrence rule behind a cadence: an interval, no windows, and no end but the user's. The rule
 * id is derived from the action so a re-import updates the rule the last import wrote instead of
 * duplicating it. An existing rule keeps its start date, because a cadence that has never been done
 * is due from that date — restarting it on every re-import would quietly push it further away each
 * time the sheet was uploaded.
 */
async function writeCadenceRule(sql: Sql, userId: string, actionId: string, intervalDays: number | null) {
  if (intervalDays === null) return;
  if (intervalDays === 0) {
    await sql`DELETE FROM action_recurrence_rules WHERE action_id=${actionId}`;
    return;
  }
  const users = await sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id=${userId}`;
  const timezone = users[0]?.timezone ?? DEFAULT_TIMEZONE;
  const ruleId = await stableUuid(`recurrence:${userId}:${actionId}`, `import:${actionId}`);
  await sql`
    INSERT INTO action_recurrence_rules(id,action_id,timezone,start_date,end_date,interval_days,completion_mode,target_total_minutes)
    VALUES(${ruleId},${actionId},${timezone},${localDayIn(timezone, new Date())},${null},${intervalDays},'manual',${null})
    ON CONFLICT(action_id) DO UPDATE SET timezone=EXCLUDED.timezone,end_date=NULL,interval_days=EXCLUDED.interval_days,completion_mode='manual',target_total_minutes=NULL,version=action_recurrence_rules.version+1,updated_at=CURRENT_TIMESTAMP
  `;
  // A cadence has no windows; a windowed rule the sheet has just turned into one loses them.
  await sql`DELETE FROM action_recurrence_windows WHERE rule_id IN (SELECT id FROM action_recurrence_rules WHERE action_id=${actionId})`;
}

export async function upsertAction(
  sql: Sql,
  userId: string,
  id: string,
  projectId: string,
  r: ImportRecord,
  v: (n: string) => any
) {
  await assertVersion(sql, "actions", id, r);
  const set = columnSetter(sql, r);
  const repeatEveryDays = cadenceInterval(v("repeatEveryDays"));
  // A cadence's due date and latest start are authored-but-unread (the schedule attachments design note,
  //): the sheet cannot make an action a cadence and give it a due date at the same time, whatever
  // its own deadlineAt/latestStartAt columns say.
  const becomesCadence = Boolean(repeatEveryDays);
  // A create has nothing to keep, so a blank or absent column simply means an ordinary one-off.
  if (r.operation === "create")
    await sql`INSERT INTO actions(id,project_id,title,status,scheduling_mode,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,splittable,setup_minutes,importance,consequence,available_from,deadline_at,latest_start_at,notes) VALUES(${id},${projectId},${v("title")},${v("status")},${becomesCadence ? "cadence" : "one_off"},${v("optimisticMinutes")},${v("expectedMinutes")},${v("pessimisticMinutes")},${v("remainingMinutes")},${v("energy")},${v("minimumSessionMinutes")},${v("maximumSessionMinutes")},${v("splittable")},${v("setupMinutes")},${v("importance")},${v("consequence")},${timestampOrNull(v("availableFrom"))},${becomesCadence ? null : timestampOrNull(v("deadlineAt"))},${becomesCadence ? null : timestampOrNull(v("latestStartAt"))},${v("notes")})`;
  else
    await sql`UPDATE actions SET project_id=${projectId},${set("title", "title", v("title"))},${set("status", "status", v("status"))},scheduling_mode=${repeatEveryDays === null ? sql`scheduling_mode` : sql`${becomesCadence ? "cadence" : "one_off"}`},${set("optimistic_minutes", "optimisticMinutes", v("optimisticMinutes"))},${set("expected_minutes", "expectedMinutes", v("expectedMinutes"))},${set("pessimistic_minutes", "pessimisticMinutes", v("pessimisticMinutes"))},${set("remaining_minutes", "remainingMinutes", v("remainingMinutes"))},remaining_set_at=CASE WHEN ${!isAbsentColumn(r, "remainingMinutes")} AND ${v("remainingMinutes")}::int IS DISTINCT FROM remaining_minutes THEN CURRENT_TIMESTAMP ELSE remaining_set_at END,${set("energy", "energy", v("energy"))},${set("minimum_session_minutes", "minimumSessionMinutes", v("minimumSessionMinutes"))},${set("maximum_session_minutes", "maximumSessionMinutes", v("maximumSessionMinutes"))},${set("splittable", "splittable", v("splittable"))},${set("setup_minutes", "setupMinutes", v("setupMinutes"))},${set("importance", "importance", v("importance"))},${set("consequence", "consequence", v("consequence"))},${set("available_from", "availableFrom", timestampOrNull(v("availableFrom")))},${becomesCadence ? sql`deadline_at=NULL` : set("deadline_at", "deadlineAt", timestampOrNull(v("deadlineAt")))},${becomesCadence ? sql`latest_start_at=NULL` : set("latest_start_at", "latestStartAt", timestampOrNull(v("latestStartAt")))},${set("notes", "notes", v("notes"))},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
  await writeCadenceRule(sql, userId, id, repeatEveryDays);
  // `action_contexts` is retired, so a "requirements" column present at all is the caller
  // deliberately speaking pathways and wins outright. A sheet that carries only the legacy flat
  // "contexts" column (no "requirements" column in the sheet at all) is folded into one AND pathway,
  // the same thing that column always meant — this cannot undo a correction made through
  // "requirements", because a full export/reimport always carries both columns together, so
  // "requirements" is genuinely absent only for a sheet that never spoke pathways to begin with.
  // Neither column present leaves the stored pathways alone, same as any other absent column.
  if (!isAbsentColumn(r, "requirementPathways")) {
    await sql`DELETE FROM action_requirement_pathways WHERE action_id=${id}`;
    const pathways = Array.isArray(v("requirementPathways"))
      ? (v("requirementPathways") as { contextIds?: unknown }[])
      : [];
    for (const [sortOrder, pathway] of pathways.entries()) {
      const pathwayId = crypto.randomUUID();
      await sql`INSERT INTO action_requirement_pathways(id,action_id,sort_order) VALUES(${pathwayId},${id},${sortOrder})`;
      for (const contextKey of Array.isArray(pathway.contextIds) ? pathway.contextIds : [])
        await sql`INSERT INTO action_requirements(pathway_id,context_key) VALUES(${pathwayId},${contextKey})`;
    }
  } else if (!isAbsentColumn(r, "contexts")) {
    const contexts = Array.isArray(v("contexts"))
      ? (v("contexts") as string[])
      : String(v("contexts") ?? "")
          .split(",")
          .map((x: string) => x.trim())
          .filter(Boolean);
    await sql`DELETE FROM action_requirement_pathways WHERE action_id=${id}`;
    if (contexts.length) {
      const pathwayId = crypto.randomUUID();
      await sql`INSERT INTO action_requirement_pathways(id,action_id,sort_order) VALUES(${pathwayId},${id},0)`;
      for (const contextKey of new Set(contexts))
        await sql`INSERT INTO action_requirements(pathway_id,context_key) VALUES(${pathwayId},${contextKey})`;
    }
  }
  if (!isAbsentColumn(r, "preferences")) {
    await sql`DELETE FROM action_preferences WHERE action_id=${id}`;
    for (const c of Array.isArray(v("preferences")) ? (v("preferences") as string[]) : [])
      await sql`INSERT INTO action_preferences(action_id,context_key) VALUES(${id},${c})`;
  }
}
export async function upsertConditionDefinition(
  sql: Sql,
  userId: string,
  id: string,
  r: ImportRecord,
  v: (n: string) => any
) {
  const pathways = Array.isArray(v("pathways")) ? (v("pathways") as string[][]) : [];
  const grants = Array.isArray(v("grants")) ? (v("grants") as string[]) : [];
  const channels = Array.isArray(v("channels")) ? (v("channels") as string[]) : [];
  const status = v("status") ?? "active";
  const portability = v("portability") ?? "fixed";
  // An import can archive a place as readily as the Settings screen can, and the home cannot quietly
  // stop existing: sleep and every return leg point at it. Same refusal, worded the same way.
  if (status === "archived") {
    const home = await sql<
      { home_location_id: string | null }[]
    >`SELECT home_location_id FROM user_preferences WHERE user_id=${userId}`;
    if (home[0]?.home_location_id === id)
      throw new Error("This is your home location. Choose another home in Settings before archiving it.");
  }
  // The same absent-versus-blank rule as the other upserts, expressed for an upsert-by-conflict: an
  // absent column keeps the row's own value, a carried one takes what the sheet said (or its default).
  const keep = (column: string, field: string) =>
    isAbsentColumn(r, field)
      ? sql`${sql(column)}=condition_definitions.${sql(column)}`
      : sql`${sql(column)}=EXCLUDED.${sql(column)}`;
  await sql`
    INSERT INTO condition_definitions (user_id,id,name,kind,status,portability,pathways,grants,channels,travel_minutes,setup_before_minutes,transition_after_minutes)
    VALUES (${userId},${id},${v("name")},${v("kind")},${status},${portability},${sql.json(pathways as never)},${sql.json(grants as never)},${sql.json(channels as never)},${v("travelMinutes")},${v("setupBeforeMinutes") ?? 0},${v("transitionAfterMinutes") ?? 0})
    ON CONFLICT (user_id,id) DO UPDATE SET ${keep("name", "name")},${keep("kind", "kind")},${keep("status", "status")},${keep("portability", "portability")},${keep("pathways", "pathways")},${keep("grants", "grants")},${keep("channels", "channels")},${keep("travel_minutes", "travelMinutes")},${keep("setup_before_minutes", "setupBeforeMinutes")},${keep("transition_after_minutes", "transitionAfterMinutes")},updated_at=CURRENT_TIMESTAMP
  `;
}

export async function upsertCommitment(
  sql: Sql,
  userId: string,
  id: string,
  r: ImportRecord,
  v: (n: string) => any,
  close: ImportCloseContext = {}
) {
  await assertVersion(sql, "commitments", id, r);
  const set = columnSetter(sql, r);
  // A commitment the import cancelled (the source's removal) that this write reopens: remember the batch it was closed in,
  // because the reopen clears it and the steps and prep that closed with it come back with it, as a restore would.
  let reopensBatch: string | null = null;
  if (r.operation !== "create" && !isAbsentColumn(r, "status") && v("status") !== "cancelled") {
    const was = (
      await sql<
        { status: string; closed_by: string | null; closed_reason: string | null; closed_batch: string | null }[]
      >`SELECT status, closed_by, closed_reason, closed_batch FROM commitments WHERE id=${id}`
    )[0];
    if (was?.status === "cancelled" && isImportRemovedClose(was)) reopensBatch = was.closed_batch;
  }
  if (r.operation === "create") {
    // Every other creator (a secondary source, workbook) defaults to unshared/inherit
    // unless the batch item already says otherwise. Shifts arrive automatically, so their sharing is
    // a standing choice made once in Settings, not a per-shift click: a primary source's create path reads
    // `share_primary_events` and writes it as the flag's *initial* value, 'inherit' source — not "custom",
    // because this is the default tracking the setting, not a one-off pin. When the setting changes
    // later, entity-commands carries it to this row too if the shift is still ahead and still 'inherit'.
    let shareToCalendar = Boolean(v("shareToCalendar") ?? false);
    const shareSource = String(v("shareSource") ?? "inherit");
    if (isPrimarySourceCreate(r)) {
      const prefs = await sql<
        { share_primary_events: boolean | null }[]
      >`SELECT share_primary_events FROM user_preferences WHERE user_id=${userId}`;
      shareToCalendar = Boolean(prefs[0]?.share_primary_events);
    }
    const shareSourceToWrite = isPrimarySourceCreate(r) ? "inherit" : shareSource;
    await sql`INSERT INTO commitments(id,user_id,title,starts_at,ends_at,status,location,location_id,setup_before_minutes,transition_after_minutes,share_to_calendar,share_source,project_id) VALUES(${id},${userId},${v("title")},${new Date(v("startsAt"))},${new Date(v("endsAt"))},${v("status")},${v("location")},${v("locationId")},${v("setupBeforeMinutes")},${v("transitionAfterMinutes")},${shareToCalendar},${shareSourceToWrite},${r.relationships.commitmentProjectId ?? null})`;
  } else
    await sql`UPDATE commitments SET ${set("title", "title", v("title"))},${set("starts_at", "startsAt", timestampOrNull(v("startsAt")))},${set("ends_at", "endsAt", timestampOrNull(v("endsAt")))},${isAbsentColumn(r, "status") ? sql`status=status` : sql`status=${guardedStatus(sql, v("status"))}`},${set("location", "location", v("location"))},${set("location_id", "locationId", v("locationId"))},${set("setup_before_minutes", "setupBeforeMinutes", v("setupBeforeMinutes"))},${set("transition_after_minutes", "transitionAfterMinutes", v("transitionAfterMinutes"))},${set("share_to_calendar", "shareToCalendar", v("shareToCalendar"))},${set("share_source", "shareSource", v("shareSource"))},${set("schedule_source", "scheduleSource", v("scheduleSource"))},project_id=COALESCE(project_id,${r.relationships.commitmentProjectId ?? null}),version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
  if (reopensBatch) {
    const now = (await sql<{ status: string }[]>`SELECT status FROM commitments WHERE id=${id}`)[0];
    if (now && now.status !== "cancelled")
      await restoreBatch(
        sql,
        { userId, type: "commitment", id, shownId: id, verb: "cancel", version: 0, includeChildren: false },
        reopensBatch,
        null
      );
  }
  // The source says it is cancelled: cancel it properly (steps, prep, ledger) unless it already is.
  if (r.operation !== "create" && !isAbsentColumn(r, "status") && v("status") === "cancelled")
    await closeCommitmentAsSystem(sql, {
      userId,
      id,
      why: sourceRemovalWhy({ ...r, fields: { status: r.fields.status! } }),
      // A record edited to cancelled is the person's or agent's choice, not the source's removal (those are `delete`
      // records, or the feed's own date records): stamped with who chose it, with no marker, so no later sync reopens it.
      actor: isFeedRecord(r) ? undefined : actorName(),
      batchId: close.batchId,
      planned: close.plans?.get(id)
    });
}
export async function upsertCommitmentRecurrenceRule(
  sql: Sql,
  userId: string,
  id: string,
  r: ImportRecord,
  v: (n: string) => any
) {
  await assertVersion(sql, "commitment_recurrence_rules", id, r);
  const set = columnSetter(sql, r);
  const endDate = v("endDate") ? v("endDate") : null;
  // the three repeat columns are coupled (see schema.ts's pairing CHECK), so on an update they
  // are all rewritten together, keyed off whether the sheet carried `intervalUnit` at all — never
  // independently, which could otherwise leave e.g. a 'months' row with a stale `interval_days`.
  const unitProvided = !isAbsentColumn(r, "intervalUnit");
  const unit = unitProvided ? String(v("intervalUnit") ?? "days") : "days";
  const intervalDays = unit === "months" || unit === "weeks" ? null : v("intervalDays");
  // a weeks rule carries `intervalWeeks` and `weekdays` (a number[] in the record; stored as jsonb).
  const intervalWeeks = unit === "weeks" ? v("intervalWeeks") : null;
  // Stored in the one spelling `repeatWeekdaysSchema` accepts, whatever order the record carried it in.
  const weekdays =
    unit === "weeks" && Array.isArray(v("weekdays"))
      ? sql.json(normalizeRepeatWeekdays(v("weekdays") as number[]) as never)
      : null;
  const intervalMonths = unit === "months" ? v("intervalMonths") : null;
  const monthAnchor = unit === "months" ? v("monthAnchor") : null;
  if (r.operation === "create")
    await sql`INSERT INTO commitment_recurrence_rules(id,user_id,title,timezone,start_date,end_date,interval_unit,interval_days,interval_weeks,weekdays,interval_months,month_anchor,local_start_time,local_end_time,location,location_id,setup_before_minutes,transition_after_minutes) VALUES(${id},${userId},${v("title")},${v("timezone")},${v("startDate")},${endDate},${unit},${intervalDays},${intervalWeeks},${weekdays},${intervalMonths},${monthAnchor},${v("localStartTime")},${v("localEndTime")},${v("location")},${v("locationId")},${v("setupBeforeMinutes")},${v("transitionAfterMinutes")})`;
  else
    await sql`UPDATE commitment_recurrence_rules SET ${set("title", "title", v("title"))},${set("timezone", "timezone", v("timezone"))},${set("start_date", "startDate", v("startDate"))},${set("end_date", "endDate", endDate)},${set("interval_unit", "intervalUnit", unit)},${set("interval_days", "intervalUnit", intervalDays)},${set("interval_weeks", "intervalUnit", intervalWeeks)},${set("weekdays", "intervalUnit", weekdays)},${set("interval_months", "intervalUnit", intervalMonths)},${set("month_anchor", "intervalUnit", monthAnchor)},${set("local_start_time", "localStartTime", v("localStartTime"))},${set("local_end_time", "localEndTime", v("localEndTime"))},${set("location", "location", v("location"))},${set("location_id", "locationId", v("locationId"))},${set("setup_before_minutes", "setupBeforeMinutes", v("setupBeforeMinutes"))},${set("transition_after_minutes", "transitionAfterMinutes", v("transitionAfterMinutes"))},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
}
export async function endCommitmentRecurrenceRule(sql: Sql, id: string, record: ImportRecord) {
  await assertVersion(sql, "commitment_recurrence_rules", id, { ...record, operation: "update" });
  await sql`UPDATE commitment_recurrence_rules SET status='ended', version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
  await sql`DELETE FROM commitments WHERE recurrence_rule_id=${id} AND starts_at>CURRENT_TIMESTAMP`;
}

export async function copyRoutineSteps(sql: Sql, userId: string, commitmentId: string, raw: string) {
  let steps: unknown;
  try {
    steps = JSON.parse(raw);
  } catch {
    throw new Error("The selected routine data is invalid.");
  }
  if (!Array.isArray(steps)) throw new Error("The selected routine data is invalid.");
  const phaseOf = (step: Record<string, unknown>) => (step.phase === "after" ? "after" : "before");
  const positions = new Map<string, number>();
  const validated: CommitmentRoutineStepInput[] = [];
  for (const [sequence, value] of steps.entries()) {
    if (!value || typeof value !== "object") throw new Error("A routine step is invalid.");
    const step = value as Record<string, unknown>;
    positions.set(String(step.id ?? sequence), sequence);
    const title = String(step.title ?? "").trim();
    const duration = Number(step.durationMinutes);
    const timing = step.timingRule === "flexible" ? ("flexible" as const) : ("contiguous" as const);
    const lead = timing === "flexible" ? Number(step.maxLeadMinutes) : null;
    const energy = String(step.energy ?? "low");
    const contexts = Array.isArray(step.contexts)
      ? step.contexts.filter((item): item is string => typeof item === "string")
      : [];
    const waitAfterMinutes = step.waitAfterMinutes === undefined ? 0 : Number(step.waitAfterMinutes);
    const mustStartByMinutes =
      step.mustStartByMinutes === undefined || step.mustStartByMinutes === null
        ? null
        : Number(step.mustStartByMinutes);
    const preferredBands = Array.isArray(step.preferredBands)
      ? step.preferredBands.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    if (
      !title ||
      !Number.isInteger(duration) ||
      duration <= 0 ||
      !["high", "medium", "low", "recovery"].includes(energy) ||
      (timing === "flexible" && (!Number.isInteger(lead) || Number(lead) <= 0)) ||
      !Number.isInteger(waitAfterMinutes) ||
      waitAfterMinutes < 0 ||
      (mustStartByMinutes !== null && (!Number.isInteger(mustStartByMinutes) || mustStartByMinutes <= 0))
    )
      throw new Error("A routine step is incomplete or invalid.");
    validated.push({
      title,
      durationMinutes: duration,
      timingRule: timing,
      maxLeadMinutes: lead,
      energy,
      phase: phaseOf(step),
      contexts,
      actionWindowId: null,
      cadenceActionId: null,
      // Explicitly reviewed by hand during import — never preset-derived, and the write below flips
      // routine_source to 'custom' right after, so reconciliation never looks at these rows again.
      presetStepId: null,
      dependsOn: [],
      waitAfterMinutes,
      mustStartByMinutes,
      preferredBands
    });
  }
  for (const [sequence, value] of steps.entries()) {
    const step = value as Record<string, unknown>;
    const priorSamePhaseIndex = validated
      .slice(0, sequence)
      .map((candidate, index) => ({ candidate, index }))
      .reverse()
      .find(({ candidate }) => candidate.phase === validated[sequence]!.phase)?.index;
    const dependencyIds = Array.isArray(step.dependencyIds) ? step.dependencyIds.map(String) : null;
    if (dependencyIds) {
      for (const dependencyRaw of dependencyIds) {
        const dependency = positions.get(dependencyRaw);
        if (dependency === undefined) throw new Error("A routine connection is invalid.");
        validated[sequence]!.dependsOn.push(dependency);
      }
    } else if (priorSamePhaseIndex !== undefined) validated[sequence]!.dependsOn.push(priorSamePhaseIndex);
  }
  await replaceCommitmentRoutineSteps(sql, userId, commitmentId, validated);
  // Stamped steps came through explicit review, so the replan must treat them as the user's own and
  // never rewrite them from a place default.
  await sql`UPDATE commitments SET routine_source='custom',updated_at=CURRENT_TIMESTAMP WHERE id=${commitmentId} AND routine_source<>'custom'`;
}

/**
 * Writing a `plan_link` record: the same validation and write as a link made by hand (`createManualLink`),
 * so an import can never produce a link the plan map would refuse. A refusal here means the database moved
 * on since the preview (an end deleted, the pair rejected); it throws so the commit unwinds whole.
 */
export async function upsertPlanLink(sql: Sql, userId: string, record: ImportRecord) {
  const result = await createManualLink(sql, userId, planLinkInput(record));
  if (!result.ok) throw new ImportConflictError(`Plan link ${record.importKey} could not be created: ${result.reason}`);
}
