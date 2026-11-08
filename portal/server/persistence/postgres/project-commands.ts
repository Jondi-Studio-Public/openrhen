import type { ConfirmProjectWantedCommand, SaveActionCommand, SaveProjectCommand } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { InvalidCommandError, notFound, notFoundConflict, versionConflict } from "./command-errors";
import { stableUuid } from "./command-values";
import { ensureUser } from "./ensure-user";
import { claimCommandReceipt, commandRequestHash, hasCommandReceipt } from "./command-receipt";
import { hasCycle } from "./graph-checks";
import { assumableValuesOfRow, nextAssumedFields, pgNameArray } from "./assumed-fields";
import { assertNoPrerequisiteCycle, replacePrerequisites, resolvePrerequisiteRefs } from "./prerequisites";
import { assertNoClosedTransition } from "./close-floor";
import { changedFieldsBefore, recordStateChange } from "./planning-evidence";
import { dropWaiverFor } from "./current-situation";
import { readRequirementDefinitions, readStoredRoutes, routesFromRequires } from "./requires-write";
import { pathwaysToStore } from "./requirement-pathways";
import { readStateAfterCommit } from "./read-after-commit";
import { watchActionWrite, watchProjectWrite } from "./entity-snapshot";
import type { PoolSql } from "./sql-pool";
import { logOfferOutcome } from "./offer-log-writer";
import { WriteSnapshot } from "./write-snapshot";

export async function saveProject(sql: PoolSql, command: SaveProjectCommand): Promise<PortalState> {
  const userId = await ensureUser(sql);
  const commandId = command.commandId ?? crypto.randomUUID();
  const requestHash = commandRequestHash("save_project", command);
  if (await hasCommandReceipt(sql, { id: commandId, userId, commandType: "save_project", requestHash }))
    return await readStateAfterCommit(sql);
  await sql.begin(async (tx) => {
    if (!(await claimCommandReceipt(tx, { id: commandId, userId, commandType: "save_project", requestHash }))) return;
    // An agent's save keeps the rows it touches so it can be undone afterwards (write-snapshot.ts). Opened first:
    // it takes the plan publication lock, which must precede every row lock.
    const snap = await WriteSnapshot.open(tx, userId, commandId, "save");
    await assertNoClosedTransition(tx, userId, "project", command.project.id, command.project.status);
    const id = await stableUuid(`project:${userId}`, command.project.id);
    const outcomeId = await stableUuid(`outcome:${userId}`, command.project.outcomeId);
    const ownedOutcome = await tx<
      { id: string }[]
    >`SELECT o.id FROM outcomes o JOIN areas a ON a.id = o.area_id WHERE o.id = ${outcomeId} AND a.user_id = ${userId}`;
    if (!ownedOutcome[0]) throw notFound("outcome", command.project.outcomeId);
    const existing = await tx<
      { version: number; before: Record<string, unknown> }[]
    >`SELECT p.version, to_jsonb(p) AS before FROM projects p JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id WHERE p.id = ${id} AND a.user_id = ${userId} FOR NO KEY UPDATE OF p`;
    await watchProjectWrite(snap, id);
    if (existing[0]) {
      if (command.expectedVersion !== existing[0].version)
        throw versionConflict("project", command.project.id, command.expectedVersion, existing[0].version);
      // a project re-activated after being paused or archived starts its pace baseline over —
      // `projects.status` here is the row's pre-update value, so this only fires on the transition
      // itself, never on every save of an already-active project. `deriveProjectPace`
      // (`@openrhen/database`) recaptures a fresh baseline the next time this project is forecast,
      // which `recordStateChange` below triggers within this same transaction.
      const reactivated = tx`(projects.status IN ('paused','archived') AND ${command.project.status}='active')`;
      await tx`UPDATE projects SET outcome_id=${outcomeId}, title=${command.project.title}, status=${command.project.status}, uncertainty=${command.project.uncertainty}, consequence=${command.project.consequence}, internal_deadline_at=${command.project.internalDeadlineAt ? new Date(command.project.internalDeadlineAt) : null}, external_deadline_at=${command.project.externalDeadlineAt ? new Date(command.project.externalDeadlineAt) : null}, remaining_effort_override_minutes=${command.project.remainingEffortOverrideMinutes ?? null}, forecast_started_at=CASE WHEN ${reactivated} THEN NULL ELSE projects.forecast_started_at END, baseline_estimate_minutes=CASE WHEN ${reactivated} THEN NULL ELSE projects.baseline_estimate_minutes END, private=COALESCE(${command.project.private ?? null},projects.private), version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
    } else {
      if (command.expectedVersion !== null) throw notFoundConflict("project", command.project.id);
      await tx`INSERT INTO projects (id, outcome_id, title, status, uncertainty, consequence, internal_deadline_at, external_deadline_at, remaining_effort_override_minutes, private) VALUES (${id}, ${outcomeId}, ${command.project.title}, ${command.project.status}, ${command.project.uncertainty}, ${command.project.consequence}, ${command.project.internalDeadlineAt ? new Date(command.project.internalDeadlineAt) : null}, ${command.project.externalDeadlineAt ? new Date(command.project.externalDeadlineAt) : null}, ${command.project.remainingEffortOverrideMinutes ?? null}, ${command.project.private ?? false})`;
    }
    if (command.project.prerequisites) {
      const owner = { kind: "project" as const, id };
      await replacePrerequisites(
        tx,
        owner,
        await resolvePrerequisiteRefs(tx, userId, owner, command.project.prerequisites)
      );
    }
    await assertNoPrerequisiteCycle(tx, userId);
    const afterProject = await tx<
      { after: Record<string, unknown> }[]
    >`SELECT to_jsonb(p) AS after FROM projects p WHERE p.id = ${id}`;
    await snap?.save();
    await recordStateChange(tx, userId, {
      entityType: "project",
      entityId: id,
      operation: "save",
      evidence: existing[0] === undefined ? { created: true, createdVersion: 1 } : {},
      commandId,
      before: changedFieldsBefore(existing[0]?.before, afterProject[0]?.after),
      at: new Date()
    });
  });
  return await readStateAfterCommit(sql);
}

/**
 * "Confirm project still wanted" (the weekly review's Keep): the one write to `projects.last_reviewed_at`. An
 * ordinary `saveProject` never names the column, so it keeps whatever is stored. Stamps now unless the command
 * carries `reviewedAt` (undo puts the earlier value, or null, back). Version-checked like a save, and bumps the
 * version so a stale editor of the same project conflicts instead of overwriting.
 */
export async function confirmProjectWanted(sql: PoolSql, command: ConfirmProjectWantedCommand): Promise<PortalState> {
  const userId = await ensureUser(sql);
  const commandId = command.commandId ?? crypto.randomUUID();
  const requestHash = commandRequestHash("confirm_project_wanted", command);
  if (await hasCommandReceipt(sql, { id: commandId, userId, commandType: "confirm_project_wanted", requestHash }))
    return await readStateAfterCommit(sql);
  await sql.begin(async (tx) => {
    if (!(await claimCommandReceipt(tx, { id: commandId, userId, commandType: "confirm_project_wanted", requestHash })))
      return;
    // An agent's review keeps the project row so it can be undone (write-snapshot.ts); opened first for the publication lock.
    const snap = await WriteSnapshot.open(tx, userId, commandId, "save");
    const id = await stableUuid(`project:${userId}`, command.projectId);
    const existing = await tx<
      { version: number; last_reviewed_at: Date | null; overdue_seen_at: Date | null }[]
    >`SELECT p.version, p.last_reviewed_at, p.overdue_seen_at FROM projects p JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id WHERE p.id = ${id} AND a.user_id = ${userId} FOR NO KEY UPDATE OF p`;
    if (!existing[0]) throw notFound("project", command.projectId);
    if (command.expectedVersion !== existing[0].version)
      throw versionConflict("project", command.projectId, command.expectedVersion, existing[0].version);
    await snap?.before("projects", [id]);
    const at = new Date();
    // A stamp later than now would hide the project from the stale list until that date, so one is clamped to now.
    const given = command.reviewedAt ? new Date(command.reviewedAt) : null;
    const reviewedAt = command.reviewedAt === undefined ? at : given && given > at ? at : given;
    const seen = command.kind === "overdue_seen";
    if (seen)
      await tx`UPDATE projects SET overdue_seen_at=${reviewedAt}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
    else
      await tx`UPDATE projects SET last_reviewed_at=${reviewedAt}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
    await recordStateChange(tx, userId, {
      entityType: "project",
      entityId: command.projectId,
      operation: seen ? "overdue_seen" : "confirm_wanted",
      commandId,
      before: seen
        ? { overdue_seen_at: existing[0].overdue_seen_at }
        : { last_reviewed_at: existing[0].last_reviewed_at },
      at
    });
    await snap?.save();
  });
  return await readStateAfterCommit(sql);
}

export async function saveAction(sql: PoolSql, command: SaveActionCommand): Promise<PortalState> {
  const userId = await ensureUser(sql);
  const commandId = command.commandId ?? crypto.randomUUID();
  const requestHash = commandRequestHash("save_action", command);
  if (await hasCommandReceipt(sql, { id: commandId, userId, commandType: "save_action", requestHash }))
    return await readStateAfterCommit(sql);
  await sql.begin(async (tx) => {
    if (!(await claimCommandReceipt(tx, { id: commandId, userId, commandType: "save_action", requestHash }))) return;
    // An agent's save keeps the rows it touches so it can be undone afterwards (write-snapshot.ts). Opened first:
    // it takes the plan publication lock, which must precede every row lock.
    const snap = await WriteSnapshot.open(tx, userId, commandId, "save");
    const action = command.action;
    await assertNoClosedTransition(tx, userId, "action", action.id, action.status);
    const id = await stableUuid(`action:${userId}`, action.id);
    const projectId = await stableUuid(`project:${userId}`, action.projectId);
    const ownedProject = await tx<
      { id: string }[]
    >`SELECT p.id FROM projects p JOIN outcomes o ON o.id=p.outcome_id JOIN areas ar ON ar.id=o.area_id WHERE p.id=${projectId} AND ar.user_id=${userId}`;
    if (!ownedProject[0]) throw notFound("project", action.projectId);
    const existing = await tx<
      {
        version: number;
        remaining_minutes: number;
        deadline_at: Date | null;
        latest_start_at: Date | null;
        prep_for_commitment_id: string | null;
        notes: string | null;
        available_from: Date | null;
        before: Record<string, unknown>;
      }[]
    >`SELECT ac.version, ac.remaining_minutes, ac.available_from, ac.deadline_at, ac.latest_start_at, ac.prep_for_commitment_id, ac.notes, to_jsonb(ac) - 'notes' AS before FROM actions ac JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas ar ON ar.id=o.area_id WHERE ac.id=${id} AND ar.user_id=${userId} FOR NO KEY UPDATE OF ac`;
    // The same test the rule write below uses: anything else deletes the rule and its history with it.
    // Null: the save drops the rule. Otherwise the windows it keeps, as the rule write below derives them.
    await watchActionWrite(
      snap,
      id,
      (action.schedulingMode === "recurring" || action.schedulingMode === "cadence") && action.recurrence
        ? await Promise.all(
            action.recurrence.windows.map(async (window) =>
              stableUuid(
                `recurrence-window:${await stableUuid(`recurrence:${userId}:${id}`, action.recurrence!.id)}`,
                window.id
              )
            )
          )
        : null
    );
    if (existing[0] && command.expectedVersion !== existing[0].version)
      throw versionConflict("action", action.id, command.expectedVersion, existing[0].version);
    if (!existing[0] && command.expectedVersion !== null) throw notFoundConflict("action", action.id);
    // `requires` is checked first, before any row is written, so a refusal leaves the stored routes alone.
    const requiredRoutes =
      action.requires === undefined
        ? undefined
        : routesFromRequires(
            action.requires,
            await readRequirementDefinitions(tx, userId),
            existing[0] ? ((await readStoredRoutes(tx, [id])).get(id) ?? []) : [],
            { id: action.id, title: action.title, tool: "action" }
          );
    const dependencyIds = await Promise.all(
      action.dependencyIds.map((dependencyId) => stableUuid(`action:${userId}`, dependencyId))
    );
    if (dependencyIds.length) {
      const owned = await tx<
        { id: string }[]
      >`SELECT ac.id FROM actions ac JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas ar ON ar.id=o.area_id WHERE ac.id IN ${tx(dependencyIds)} AND ar.user_id=${userId}`;
      if (owned.length !== new Set(dependencyIds).size) {
        const found = new Set(owned.map((row) => row.id));
        const missing = action.dependencyIds.filter((_raw, index) => !found.has(dependencyIds[index]!));
        throw notFound("action", missing.join(", "), `Dependency action${missing.length === 1 ? "" : "s"}`);
      }
    }
    const edges = await tx<
      { action_id: string; depends_on_action_id: string }[]
    >`SELECT ad.action_id, ad.depends_on_action_id FROM action_dependencies ad JOIN actions ac ON ac.id=ad.action_id JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas ar ON ar.id=o.area_id WHERE ar.user_id=${userId}`;
    const graph = new Map<string, string[]>();
    for (const edge of edges)
      if (edge.action_id !== id)
        graph.set(edge.action_id, [...(graph.get(edge.action_id) ?? []), edge.depends_on_action_id]);
    graph.set(id, dependencyIds);
    if (hasCycle(graph))
      throw new InvalidCommandError(
        `Action "${action.id}" cannot depend on ${action.dependencyIds.map((raw) => `"${raw}"`).join(", ")}: one of them already depends on it, directly or through others, so that would make a dependency cycle. Remove that id from dependencyIds, or remove the older dependency first.`
      );
    // Prep (`CONTEXT.md`): absent keeps the stored attachment, explicit null detaches it, and a value
    // must name one of this person's own commitments.
    let prepForCommitmentId = existing[0]?.prep_for_commitment_id ?? null;
    if (action.prepForCommitmentId === null) prepForCommitmentId = null;
    else if (action.prepForCommitmentId !== undefined) {
      prepForCommitmentId = await stableUuid(`commitment:${userId}`, action.prepForCommitmentId);
      const ownedCommitment = await tx<
        { id: string }[]
      >`SELECT id FROM commitments WHERE id=${prepForCommitmentId} AND user_id=${userId}`;
      if (!ownedCommitment[0])
        throw notFound("commitment", action.prepForCommitmentId, "The commitment this action prepares for");
    }
    const schedulingMode = action.schedulingMode ?? "one_off";
    // A recurring action's own due date and latest start are authored-but-unread
    // `prepare` hydrates a recurring unit from its
    // occurrence's window instead, so they are cleared here. This is the one place every caller's
    // save funnels through — the editor, an import, and the CLI's `save action` all reach it — so the
    // invariant is enforced here rather than trusted to each caller.
    //
    // A cadence action is the exception, decided 2026-09-13. effectiveDeadline reads
    // action.deadlineAt for every action whatever its mode, so clearing one moves that action's
    // tier — and the editor hides the date fields outside once, which means an ordinary save from
    // the editor carries no date and would silently drop a stored one. Absence is therefore no
    // opinion: a cadence save keeps what is stored unless it supplies a date of its own, the same
    // rule entity-commands.ts applies to a commitment's presence. Migration 0079 spares these rows
    // for the same reason; this keeps the write path from undoing that on the next save.
    const keepStored = schedulingMode === "cadence";
    const deadlineAt =
      schedulingMode === "recurring"
        ? null
        : action.deadlineAt
          ? new Date(action.deadlineAt)
          : keepStored
            ? (existing[0]?.deadline_at ?? null)
            : null;
    const latestStartAt =
      schedulingMode === "recurring"
        ? null
        : action.latestStartAt
          ? new Date(action.latestStartAt)
          : keepStored
            ? (existing[0]?.latest_start_at ?? null)
            : null;
    // Notes, like `private` and prep: absent keeps what is stored, so a partial payload (block, wait,
    // cancel, a CLI patch) cannot erase them. An empty string is the explicit clear — the editor sends
    // one when its notes box is emptied — and is stored as null.
    const notes = action.notes === undefined ? (existing[0]?.notes ?? null) : action.notes || null;
    // When a done action was finished ("paid the bill Monday"): absent keeps what is stored (a finished session
    // sets it). It is read only on a done action, since a caller that restates a record it read (the editor, the
    // CLI's merge) carries the stored time along when it reopens one.
    const completedAt = action.completedAt && action.status === "done" ? new Date(action.completedAt) : null;
    // Which estimate and judgement fields are still a default or a guess: the caller's say, else a stored one
    // stays only while its value is unchanged. The one place that rule lives.
    const assumedFields = nextAssumedFields({
      sent: action.assumedFields,
      stored: existing[0]
        ? {
            // `before` is JSON, so the stored list reads the same on any client (a bare text[] needs `fetch_types`).
            assumed: Array.isArray(existing[0].before.assumed_fields) ? existing[0].before.assumed_fields : [],
            values: assumableValuesOfRow(existing[0].before)
          }
        : undefined,
      next: action
    });
    // The age of the remaining-time estimate moves when this save changes it, or the caller said it in this call
    // (`remainingAsserted`, the answer to an aged-effort need). Restating the stored figure while editing
    // something else leaves it alone, and a new row takes its column default.
    const remainingConfirmed = existing[0]
      ? existing[0].remaining_minutes !== action.remainingMinutes || command.remainingAsserted === true
      : false;
    if (existing[0])
      await tx`UPDATE actions SET project_id=${projectId}, title=${action.title}, status=${action.status}, scheduling_mode=${schedulingMode}, optimistic_minutes=${action.optimisticMinutes}, expected_minutes=${action.expectedMinutes}, pessimistic_minutes=${action.pessimisticMinutes}, remaining_minutes=${action.remainingMinutes}, remaining_set_at=CASE WHEN ${remainingConfirmed} THEN CURRENT_TIMESTAMP ELSE remaining_set_at END, energy=${action.energy}, minimum_session_minutes=${action.minimumSessionMinutes}, maximum_session_minutes=${action.maximumSessionMinutes}, splittable=${action.splittable}, setup_minutes=${action.setupMinutes}, importance=${action.importance}, consequence=${action.consequence}, available_from=${action.availableFrom ? new Date(action.availableFrom) : null}, deadline_at=${deadlineAt}, latest_start_at=${latestStartAt}, notes=${notes}, private=COALESCE(${action.private ?? null},actions.private), prep_for_commitment_id=${prepForCommitmentId}, completed_at=COALESCE(${completedAt},actions.completed_at), assumed_fields=${pgNameArray(assumedFields)}::text[], version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
    else
      await tx`INSERT INTO actions (id, project_id, title, status, scheduling_mode, optimistic_minutes, expected_minutes, pessimistic_minutes, remaining_minutes, energy, minimum_session_minutes, maximum_session_minutes, splittable, setup_minutes, importance, consequence, available_from, deadline_at, latest_start_at, notes, private, prep_for_commitment_id, completed_at, assumed_fields) VALUES (${id}, ${projectId}, ${action.title}, ${action.status}, ${schedulingMode}, ${action.optimisticMinutes}, ${action.expectedMinutes}, ${action.pessimisticMinutes}, ${action.remainingMinutes}, ${action.energy}, ${action.minimumSessionMinutes}, ${action.maximumSessionMinutes}, ${action.splittable}, ${action.setupMinutes}, ${action.importance}, ${action.consequence}, ${action.availableFrom ? new Date(action.availableFrom) : null}, ${deadlineAt}, ${latestStartAt}, ${notes}, ${action.private ?? false}, ${prepForCommitmentId}, ${completedAt}, ${pgNameArray(assumedFields)}::text[])`;
    if (action.status === "done") await dropWaiverFor(tx, id);
    // Snooze is only a later `availableFrom` on a save, with no offer context: the offer log records it here, by diffing
    // the stored value, so no client has to remember to report it. A first availability on a new action is not a snooze.
    const snoozedUntil = action.availableFrom ? new Date(action.availableFrom) : null;
    if (
      existing[0] &&
      snoozedUntil &&
      snoozedUntil.getTime() > Date.now() &&
      (!existing[0].available_from || snoozedUntil.getTime() > existing[0].available_from.getTime())
    )
      await logOfferOutcome(tx, userId, {
        event: "snoozed",
        commandId,
        targetType: "action",
        targetId: id,
        label: action.title,
        detail: {
          command: "save_action",
          until: snoozedUntil.toISOString(),
          previous: existing[0].available_from ? existing[0].available_from.toISOString() : null
        }
      });
    await tx`DELETE FROM action_dependencies WHERE action_id=${id}`;
    // `action_contexts` (the flat per-action tag table) is retired. `requirementPathways` is
    // the sole stored source now; a caller sending only the legacy `contexts` is folded into one AND
    // pathway (`pathwaysToStore`), so it keeps constraining the action exactly as it always did.
    // Omitting both entirely leaves the stored pathways alone, so a caller that predates the typed
    // model cannot silently erase routes it never knew about. Sending an empty array does clear
    // them, which is how an action becomes unconstrained. `contexts` alone that merely echoes the
    // stored first route (the read shape's flat mirror, as a block or wait sends it) is no change
    // either, so the other routes survive; only a different list is folded into one route.
    const storedFirstRoute =
      existing[0] && !action.requirementPathways && action.contexts.length
        ? (
            await tx<{ context_key: string }[]>`SELECT req.context_key FROM action_requirement_pathways rp
              JOIN action_requirements req ON req.pathway_id=rp.id
              WHERE rp.action_id=${id} AND rp.sort_order=(SELECT MIN(sort_order) FROM action_requirement_pathways WHERE action_id=${id})`
          ).map((row) => row.context_key)
        : undefined;
    const pathwaysInput =
      requiredRoutes ?? pathwaysToStore(action.requirementPathways, action.contexts, storedFirstRoute);
    if (pathwaysInput) {
      await tx`DELETE FROM action_requirement_pathways WHERE action_id=${id}`;
      for (const [sortOrder, route] of pathwaysInput.entries()) {
        const pathway = await tx<
          { id: string }[]
        >`INSERT INTO action_requirement_pathways (action_id, sort_order) VALUES (${id}, ${sortOrder}) RETURNING id`;
        for (const context of new Set(route))
          await tx`INSERT INTO action_requirements (pathway_id, context_key) VALUES (${pathway[0]!.id}, ${context})`;
      }
    }
    if (action.preferences) {
      await tx`DELETE FROM action_preferences WHERE action_id=${id}`;
      for (const context of new Set(action.preferences))
        await tx`INSERT INTO action_preferences (action_id, context_key) VALUES (${id}, ${context})`;
    }
    for (const dependencyId of new Set(dependencyIds))
      await tx`INSERT INTO action_dependencies (action_id, depends_on_action_id) VALUES (${id}, ${dependencyId})`;
    if ((action.schedulingMode === "recurring" || action.schedulingMode === "cadence") && action.recurrence) {
      const ruleId = await stableUuid(`recurrence:${userId}:${id}`, action.recurrence.id);
      // A cadence is open-ended unless told otherwise; a recurrence runs to a date.
      const completionMode =
        action.recurrence.completionMode ?? (action.schedulingMode === "cadence" ? "manual" : "end_date");
      // period/targetOccurrences/minSpacingDays/eligibleWeekdays are cadence-only; a recurring
      // (windowed) rule never carries them, so they write as null there just like today.
      const period = action.recurrence.period;
      await tx`INSERT INTO action_recurrence_rules(id,action_id,timezone,start_date,end_date,interval_days,completion_mode,target_total_minutes,period_unit,period_length,target_occurrences,min_spacing_days,eligible_weekdays) VALUES(${ruleId},${id},${action.recurrence.timezone},${action.recurrence.startDate},${action.recurrence.endDate ?? null},${action.recurrence.intervalDays},${completionMode},${action.recurrence.targetTotalMinutes ?? null},${period?.unit ?? null},${period?.unit === "days" ? period.length : null},${action.recurrence.targetOccurrences ?? null},${action.recurrence.minSpacingDays ?? null},${action.recurrence.eligibleWeekdays ? tx.json(action.recurrence.eligibleWeekdays as never) : null}) ON CONFLICT(action_id) DO UPDATE SET timezone=EXCLUDED.timezone,start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date,interval_days=EXCLUDED.interval_days,completion_mode=EXCLUDED.completion_mode,target_total_minutes=EXCLUDED.target_total_minutes,period_unit=EXCLUDED.period_unit,period_length=EXCLUDED.period_length,target_occurrences=EXCLUDED.target_occurrences,min_spacing_days=EXCLUDED.min_spacing_days,eligible_weekdays=EXCLUDED.eligible_weekdays,version=action_recurrence_rules.version+1,updated_at=CURRENT_TIMESTAMP`;
      const keep: string[] = [];
      for (const window of action.recurrence.windows) {
        const windowId = await stableUuid(`recurrence-window:${ruleId}`, window.id);
        keep.push(windowId);
        await tx`INSERT INTO action_recurrence_windows(id,rule_id,name,anchor,start_offset_minutes,end_offset_minutes,local_start_time,local_end_time,fallback_start_time,fallback_end_time) VALUES(${windowId},${ruleId},${window.name},${window.anchor},${window.startOffsetMinutes ?? null},${window.endOffsetMinutes ?? null},${window.localStartTime ?? null},${window.localEndTime ?? null},${window.fallback?.startTime ?? null},${window.fallback?.endTime ?? null}) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,anchor=EXCLUDED.anchor,start_offset_minutes=EXCLUDED.start_offset_minutes,end_offset_minutes=EXCLUDED.end_offset_minutes,local_start_time=EXCLUDED.local_start_time,local_end_time=EXCLUDED.local_end_time,fallback_start_time=EXCLUDED.fallback_start_time,fallback_end_time=EXCLUDED.fallback_end_time,version=action_recurrence_windows.version+1,updated_at=CURRENT_TIMESTAMP`;
      }
      // `NOT IN ()` is not SQL: a cadence rule keeps no windows, so clear them outright.
      if (keep.length)
        await tx`DELETE FROM action_recurrence_windows WHERE rule_id=${ruleId} AND id NOT IN ${tx(keep)}`;
      else await tx`DELETE FROM action_recurrence_windows WHERE rule_id=${ruleId}`;
    } else await tx`DELETE FROM action_recurrence_rules WHERE action_id=${id}`;
    if (action.prerequisites) {
      const owner = { kind: "action" as const, id };
      await replacePrerequisites(tx, owner, await resolvePrerequisiteRefs(tx, userId, owner, action.prerequisites));
    }
    await assertNoPrerequisiteCycle(tx, userId);
    const afterAction = await tx<
      { after: Record<string, unknown> }[]
    >`SELECT to_jsonb(ac) - 'notes' AS after FROM actions ac WHERE ac.id=${id}`;
    await snap?.save();
    await recordStateChange(tx, userId, {
      entityType: "action",
      entityId: id,
      operation: "save",
      evidence: {
        ...(command.blockingReason ? { blockingReason: command.blockingReason } : {}),
        ...(command.note ? { note: command.note } : {}),
        ...(existing[0] === undefined ? { created: true, createdVersion: 1 } : {})
      },
      commandId,
      // `notes` is dropped from the before-image (see the select): free text can be mail-derived and
      // `write_rows` is not purged.
      before: changedFieldsBefore(existing[0]?.before, afterAction[0]?.after),
      at: new Date()
    });
  });
  return await readStateAfterCommit(sql);
}
