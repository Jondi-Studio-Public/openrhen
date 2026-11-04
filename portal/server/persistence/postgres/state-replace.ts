import { normalizePortalState, type PortalState, type StoredArea, type StoredOutcome } from "@/state/portal-state";
import { historyWindowStart } from "@/shared/history-window";
import { requiredLocale, requiredTimeZone, stableUuid } from "./command-values";
import { pgNameArray } from "./assumed-fields";
import { writeDeliverableAggregate } from "./deliverable-write";
import { deletePrerequisitesUnderProjects, replacePrerequisites } from "./prerequisites";
import type { Sql } from "./sql-pool";

/**
 * Seeds one user's planning tables from a whole state document. Used by `PUT` whole-state import, by
 * the integration suite's fixtures, and by the one-off migration of the legacy single-row document —
 * never by an ordinary command, every one of which writes its own aggregate directly.
 *
 * It is emphatically **not** a full replace of the state document, and nothing should be built on the
 * assumption that `put(get())` round-trips. What it deletes and rewrites is: areas, outcomes,
 * projects, deliverables, actions (with requirement pathways and dependencies),
 * fixed commitments, captures (as source + proposal pairs), plus twelve `user_preferences` columns
 * and the user's timezone.
 *
 * Sessions are handled more carefully than that list: `readPortalState` only ever hands back sessions
 * inside the history window (`portal/shared/history-window.ts`) plus whatever is currently active, so
 * a document built from a `GET` cannot possibly carry anything older. The delete below is scoped to
 * that same boundary — `ended_at IS NULL OR ended_at >= historyWindowStart(...)` — so a `GET`→`PUT`
 * round trip reinserts what the document does carry without erasing the sessions it never saw. Before
 * this scoping, the delete was unconditional; that was harmless while reads were unbounded (the
 * document really did hold every session), but became silent, permanent data loss the moment the read
 * grew a window without the write-back growing a matching one. A session preserved this way does lose
 * its live `action_id`/`occurrence_id` link — those columns are severed just after the delete, before
 * the unconditional action rewrite below can cascade through them — but keeps its own title, dates and
 * outcome, which is everything `/history` renders.
 *
 * What it silently does not carry, so a document put through it comes back missing them:
 * `action_preferences`, `action_recurrence_rules` and their windows, `action_occurrences`,
 * `commitment_recurrence_rules`, `routine_steps` and routine instances/presets,
 * `condition_definitions`, `daily_plans`, `planning_focus_periods`, `sleep_plans`, `check_in`, and
 * roughly twenty further `user_preferences` columns the read does hydrate (sleep, location,
 * disruption, model settings). Occurrences in particular are lost unconditionally on every call, in
 * or out of the history window: the actions delete below
 * cascades onto `action_occurrences` regardless,
 * and nothing here ever reinserts them. That is unrelated to and unchanged by the session scoping
 * above — it predates the history window entirely and was already true when occurrence reads were
 * unbounded. Extending the write-back is a separate job; until then treat this as a seeding/legacy
 * helper only.
 */
export async function replaceState(sql: Sql, userId: string, input: PortalState): Promise<void> {
  const state = normalizePortalState(input);
  // Refused before anything is deleted: a zone the engine cannot read would fail every plan run. The
  // trimmed zone is what is kept, so a padded one cannot reach `Intl` (a RangeError) or the database.
  state.settings.timezone = requiredTimeZone(state.settings.timezone, "Timezone");
  if (state.settings.locale !== undefined) state.settings.locale = requiredLocale(state.settings.locale, "Date format");
  // Matches the boundary `readPortalState` reads sessions from: the document this function is fed can
  // never carry a closed session older than this, so the delete below must not reach past it either.
  const historySince = historyWindowStart(new Date(), state.settings.timezone);
  const projectIds = await sql<{ id: string }[]>`
    SELECT p.id FROM projects p
    JOIN outcomes o ON o.id = p.outcome_id
    JOIN areas a ON a.id = o.area_id
    WHERE a.user_id = ${userId}
  `;
  const projectIdList = projectIds.map((row) => row.id);
  // The rows are deleted and written again below, and the state document does not carry closed_* (archive-removals
  // design, section 5), so a closed row's stamp is read now and put back after the rewrite.
  const closedStamps = await readClosedStamps(sql, userId);

  if (projectIdList.length) {
    await sql`DELETE FROM recommendation_candidates WHERE action_id IN (SELECT id FROM actions WHERE project_id IN ${sql(projectIdList)})`;
    await sql`DELETE FROM forecast_snapshots WHERE project_id IN ${sql(projectIdList)}`;
  }
  await sql`DELETE FROM recommendations WHERE user_id = ${userId}`;
  // Scoped to what the document could possibly carry: the currently-active session (`ended_at IS
  // NULL`) plus whatever closed inside the history window. A closed session older than that was never
  // in the document this function is writing, so leaving it alone is correct, not incomplete — see the
  // docstring above.
  await sql`DELETE FROM sessions WHERE user_id = ${userId} AND (ended_at IS NULL OR ended_at >= ${historySince})`;
  // A session outside the window survives that delete with its `action_id`/`occurrence_id` foreign
  // keys still live — but the actions delete a few lines down is unconditional (this function always
  // rewrites the whole action list, see the docstring) and cascades onto `action_occurrences`, so
  // either FK would abort the entire PUT on a constraint violation the moment any surviving session
  // pointed at an action or occurrence. Sever both first, snapshotting the action's title into
  // `target_title` so the preserved session does not lose its readable label — `readPortalState` only
  // ever reads a session's title through `target_title` or the `actions` join, never through
  // `action_id` as an identifier. Same pattern as the `commitments.source_id` handling below.
  await sql`
    UPDATE sessions se SET target_title = COALESCE(se.target_title, ac.title, 'Activity')
    FROM actions ac WHERE se.user_id = ${userId} AND se.action_id = ac.id
  `;
  await sql`
    UPDATE sessions SET action_id = NULL, occurrence_id = NULL
    WHERE user_id = ${userId} AND (action_id IS NOT NULL OR occurrence_id IS NOT NULL)
  `;
  // When each estimate was last set (effort age) is not carried by every document: an older client or a fixture
  // leaves `remainingSetAt` out. Read it before the rewrite, so an action whose remaining time comes back unchanged
  // keeps its age instead of being dated afresh by every whole-state put.
  const storedEstimates = new Map<string, { remaining_minutes: number; remaining_set_at: Date }>();
  if (projectIdList.length) {
    for (const row of await sql<
      { id: string; remaining_minutes: number; remaining_set_at: Date }[]
    >`SELECT id, remaining_minutes, remaining_set_at FROM actions WHERE project_id IN ${sql(projectIdList)}`)
      storedEstimates.set(row.id, row);
    await deletePrerequisitesUnderProjects(sql, projectIdList);
    // Before the projects they reference; their own children cascade.
    await sql`DELETE FROM deliverables WHERE project_id IN ${sql(projectIdList)}`;
    await sql`DELETE FROM action_dependencies WHERE action_id IN (SELECT id FROM actions WHERE project_id IN ${sql(projectIdList)})`;
    await sql`DELETE FROM actions WHERE project_id IN ${sql(projectIdList)}`;
    await sql`DELETE FROM projects WHERE id IN ${sql(projectIdList)}`;
  }
  await sql`DELETE FROM outcomes WHERE area_id IN (SELECT id FROM areas WHERE user_id = ${userId})`;
  await sql`DELETE FROM areas WHERE user_id = ${userId}`;
  await sql`DELETE FROM captures WHERE user_id = ${userId}`;
  // Everything that points at `sources` has to be dealt with before the sources themselves. Only
  // `deliverable_sources`, `source_files` and `proposals` are covered — the first two cascade, the
  // third is deleted just above — while `commitments.source_id` and
  // `commitment_recurrence_rules.source_id` have no ON DELETE rule at all, so a single the calendar provider-linked
  // commitment used to abort the whole whole-state PUT on a foreign key violation.
  //
  // Commitments are deleted outright because the incoming state rewrites them below. Recurrence rules
  // are not: this function has never written them back, so deleting them would turn one PUT into
  // silent destruction of every recurring commitment series. Their source link is cleared instead —
  // the source it named is about to be deleted either way, and a rule that has lost its the calendar provider
  // provenance still schedules exactly what it scheduled before.
  await sql`DELETE FROM commitments WHERE user_id = ${userId}`;
  await sql`UPDATE commitment_recurrence_rules SET source_id = NULL WHERE user_id = ${userId} AND source_id IS NOT NULL`;
  await sql`DELETE FROM sources WHERE user_id = ${userId}`;

  await sql`UPDATE users SET timezone = ${state.settings.timezone}, locale = COALESCE(${state.settings.locale ?? null}, locale), updated_at = CURRENT_TIMESTAMP WHERE id = ${userId}`;
  await sql`
    INSERT INTO user_preferences (
      user_id, planning_horizon_end, current_horizon_end_at, asserted_conditions, current_energy,
      default_usable_fraction,
      default_setup_buffer_minutes, default_transition_buffer_minutes, submission_buffer_minutes,
      submission_buffer_percent, energy_meanings, estimate_buckets_minutes
    )
    VALUES (
      ${userId}, ${state.settings.planningHorizonEnd}, ${new Date(state.horizonEnd)}, ${sql.json(state.assertedConditions as never)}, ${state.currentEnergy},
      ${state.settings.defaultUsableFraction},
      ${state.settings.defaultSetupBufferMinutes}, ${state.settings.defaultTransitionBufferMinutes}, ${state.settings.submissionBufferMinutes},
      ${state.settings.submissionBufferPercent}, ${sql.json(state.settings.energyMeanings as never)}, ${sql.json(state.settings.estimateBucketsMinutes as never)}
    )
    ON CONFLICT (user_id) DO UPDATE SET
      planning_horizon_end = EXCLUDED.planning_horizon_end,
      current_horizon_end_at = EXCLUDED.current_horizon_end_at,
      asserted_conditions = EXCLUDED.asserted_conditions,
      current_energy = EXCLUDED.current_energy,
      default_usable_fraction = EXCLUDED.default_usable_fraction,
      default_setup_buffer_minutes = EXCLUDED.default_setup_buffer_minutes,
      default_transition_buffer_minutes = EXCLUDED.default_transition_buffer_minutes,
      submission_buffer_minutes = EXCLUDED.submission_buffer_minutes,
      submission_buffer_percent = EXCLUDED.submission_buffer_percent,
      energy_meanings = EXCLUDED.energy_meanings,
      estimate_buckets_minutes = EXCLUDED.estimate_buckets_minutes,
      updated_at = CURRENT_TIMESTAMP
  `;

  const legacyState = state as PortalState & { areas?: StoredArea[]; outcomes?: StoredOutcome[] };
  const storedAreas: StoredArea[] = legacyState.areas?.length
    ? legacyState.areas
    : [...new Set(state.projects.map((project) => project.area))].map((name, sortOrder) => ({
        id: `legacy-area:${name}`,
        name,
        status: "active" as const,
        sortOrder
      }));
  const storedOutcomes: StoredOutcome[] = legacyState.outcomes?.length
    ? legacyState.outcomes
    : state.projects.map((project) => ({
        id: `legacy-outcome:${project.id}`,
        areaId: storedAreas.find((area) => area.name === project.area)!.id,
        title: project.title,
        definitionOfDone: `Complete ${project.title}`,
        value: project.value,
        status: project.status,
        ...(project.externalDeadlineAt ? { deadlineAt: project.externalDeadlineAt } : {})
      }));

  const areaIds = new Map<string, string>();
  for (const [index, area] of storedAreas.entries()) {
    const areaId = await stableUuid(`area:${userId}`, area.id);
    areaIds.set(area.id, areaId);
    await sql`
      INSERT INTO areas (id, user_id, name, description, status, sort_order)
      VALUES (${areaId}, ${userId}, ${area.name}, ${area.description ?? null}, ${area.status}, ${area.sortOrder ?? index})
    `;
  }

  const outcomeIds = new Map<string, string>();
  for (const outcome of storedOutcomes) {
    const outcomeId = await stableUuid(`outcome:${userId}`, outcome.id);
    outcomeIds.set(outcome.id, outcomeId);
    await sql`
      INSERT INTO outcomes (id, area_id, title, definition_of_done, value, status, deadline_at, review_on)
      VALUES (
        ${outcomeId}, ${areaIds.get(outcome.areaId)!}, ${outcome.title}, ${outcome.definitionOfDone},
        ${outcome.value}, ${outcome.status}, ${outcome.deadlineAt ? new Date(outcome.deadlineAt) : null}, ${outcome.reviewOn ?? null}
      )
    `;
  }

  const projectIdMap = new Map<string, string>();
  for (const project of state.projects) {
    const projectId = await stableUuid(`project:${userId}`, project.id);
    const originalOutcomeId = project.outcomeId ?? `legacy-outcome:${project.id}`;
    projectIdMap.set(project.id, projectId);
    await sql`
      INSERT INTO projects (
        id, outcome_id, title, status, external_deadline_at, internal_deadline_at,
        uncertainty, consequence, remaining_effort_override_minutes, actual_completion_ratio, required_completion_ratio, last_worked_at, last_reviewed_at, overdue_seen_at
      ) VALUES (
        ${projectId}, ${outcomeIds.get(originalOutcomeId)!}, ${project.title}, ${project.status},
        ${project.externalDeadlineAt ? new Date(project.externalDeadlineAt) : null},
        ${project.internalDeadlineAt ? new Date(project.internalDeadlineAt) : null},
        ${project.uncertainty}, ${project.consequence}, ${project.remainingEffortOverrideMinutes ?? null},
        ${project.actualCompletionRatio ?? null}, ${project.requiredCompletionRatio ?? null},
        ${project.lastWorkedAt ? new Date(project.lastWorkedAt) : null},
        ${project.lastReviewedAt ? new Date(project.lastReviewedAt) : null},
        ${project.overdueSeenAt ? new Date(project.overdueSeenAt) : null}
      )
    `;
  }

  // Deliverables are written after their projects exist and before anything reads them back. They are
  // also deleted above, ahead of the projects they reference, so a whole-state replacement neither
  // trips the foreign key nor silently discards work the incoming state still carries.
  for (const deliverable of state.deliverables ?? []) {
    const deliverableId = await stableUuid(`deliverable:${userId}`, deliverable.id);
    const deliverableProjectId =
      projectIdMap.get(deliverable.projectId) ?? (await stableUuid(`project:${userId}`, deliverable.projectId));
    await writeDeliverableAggregate(
      sql,
      userId,
      deliverableId,
      deliverableProjectId,
      deliverable as unknown as Record<string, unknown>,
      { skipPrerequisites: true }
    );
  }

  const actionIdMap = new Map<string, string>();
  const knownContextIds = new Set(
    (await sql<{ id: string }[]>`SELECT id FROM condition_definitions WHERE user_id = ${userId}`).map((row) => row.id)
  );
  for (const [index, action] of state.actions.entries()) {
    const actionId = await stableUuid(`action:${userId}`, action.id);
    actionIdMap.set(action.id, actionId);
    const expected = Math.max(1, action.expectedMinutes);
    const optimistic = Math.max(1, Math.min(expected, action.optimisticMinutes));
    const pessimistic = Math.max(expected, action.pessimisticMinutes);
    await sql`
      INSERT INTO actions (
        id, project_id, title, status, optimistic_minutes, expected_minutes,
        pessimistic_minutes, remaining_minutes, energy, minimum_session_minutes,
        maximum_session_minutes, splittable, setup_minutes, available_from, deadline_at, latest_start_at,
        importance, consequence, sort_order, dependencies_complete, last_worked_at, notes, remaining_set_at, assumed_fields
      ) VALUES (
        ${actionId}, ${projectIdMap.get(action.projectId)!}, ${action.title}, ${action.status},
        ${optimistic}, ${expected}, ${pessimistic}, ${action.remainingMinutes}, ${action.energy},
        ${action.minimumSessionMinutes}, ${action.maximumSessionMinutes}, ${action.splittable}, ${action.setupMinutes},
        ${action.availableFrom ? new Date(action.availableFrom) : null},
        ${action.deadlineAt ? new Date(action.deadlineAt) : null},
        ${action.latestStartAt ? new Date(action.latestStartAt) : null},
        ${action.importance}, ${action.consequence}, ${index}, ${action.dependencyIds.every((dependencyId) => state.actions.find((candidate) => candidate.id === dependencyId)?.status === "done")},
        ${action.lastWorkedAt ? new Date(action.lastWorkedAt) : null}, ${action.notes ?? null},
        ${remainingSetAt(action.remainingSetAt, storedEstimates.get(actionId), action.remainingMinutes)},
        ${pgNameArray(action.assumedFields)}::text[]
      )
    `;
    // `action_contexts` is retired — write whatever pathways the document carries, falling
    // back to a single AND pathway built from the legacy flat `contexts` when there are none, the
    // same thing that field always meant. This is a full document, not a partial command, so
    // `requirementPathways` is always a defined (possibly empty) array rather than ever meaning
    // "the caller said nothing" (`pathwaysToStore`'s undefined-vs-empty distinction, which fits
    // `SaveActionCommand`, does not apply here) — non-empty wins, over either field. The fallback
    // keeps only tags naming a `condition_definitions` row this person already has: this path never
    // writes definitions (see the header), so a tag with none — the seed document's "home" and
    // "laptop", a pack from before typed contexts — would become a requirement nothing can ever
    // satisfy, turning an action that was unconstrained before into one that fails closed.
    const legacyRoute = action.contexts.filter((context) => knownContextIds.has(context));
    const pathwaysInput = action.requirementPathways.length
      ? action.requirementPathways.map((pathway) => pathway.contextIds)
      : legacyRoute.length
        ? [legacyRoute]
        : [];
    for (const [sortOrder, route] of pathwaysInput.entries()) {
      const pathway = await sql<
        { id: string }[]
      >`INSERT INTO action_requirement_pathways (action_id, sort_order) VALUES (${actionId}, ${sortOrder}) RETURNING id`;
      for (const context of new Set(route))
        await sql`INSERT INTO action_requirements (pathway_id, context_key) VALUES (${pathway[0]!.id}, ${context})`;
    }
  }

  for (const action of state.actions) {
    for (const dependencyId of action.dependencyIds) {
      const actionId = actionIdMap.get(action.id);
      const dependsOnActionId = actionIdMap.get(dependencyId);
      if (actionId && dependsOnActionId && actionId !== dependsOnActionId) {
        await sql`INSERT INTO action_dependencies (action_id, depends_on_action_id) VALUES (${actionId}, ${dependsOnActionId})`;
      }
    }
  }

  // Extra prerequisites last: every project, deliverable and action they name exists by now. The
  // document was already validated (referential, kinds, cycles), so a ref to a missing id is skipped.
  const wireToStored = async (kind: "project" | "deliverable" | "action", id: string) =>
    kind === "project"
      ? (projectIdMap.get(id) ?? (await stableUuid(`project:${userId}`, id)))
      : kind === "action"
        ? actionIdMap.get(id)
        : await stableUuid(`deliverable:${userId}`, id);
  const writePrerequisites = async (
    kind: "project" | "deliverable" | "action",
    id: string,
    refs: { kind: "project" | "deliverable" | "action"; id: string }[] | undefined
  ) => {
    if (!refs?.length) return;
    const ownerId = await wireToStored(kind, id);
    if (!ownerId) return;
    const stored = [];
    for (const ref of refs) {
      const targetId = await wireToStored(ref.kind, ref.id);
      if (targetId) stored.push({ kind: ref.kind, id: targetId });
    }
    await replacePrerequisites(sql, { kind, id: ownerId }, stored);
  };
  for (const project of state.projects) await writePrerequisites("project", project.id, project.prerequisites);
  for (const deliverable of state.deliverables ?? [])
    await writePrerequisites("deliverable", deliverable.id, deliverable.prerequisites);
  for (const action of state.actions) await writePrerequisites("action", action.id, action.prerequisites);

  for (const commitmentInput of state.commitments) {
    // `commitmentSchema` (platform/contracts/src/portal/state-schema.ts) does not carry
    // `shareToCalendar`/`shareSource` yet (task 009/the contract change for the calendar provider publish
    // plan); this local widening reads them if the caller's in-memory object happens to carry them
    // anyway, and defaults to the column defaults ('inherit', unshared) otherwise. Once the contract
    // gains the fields this cast becomes redundant and can be dropped.
    const commitment = commitmentInput as PortalState["commitments"][number] & {
      shareToCalendar?: boolean;
      shareSource?: "inherit" | "custom";
    };
    const id = await stableUuid(`commitment:${userId}`, commitment.id);
    await sql`
      INSERT INTO commitments (id, user_id, title, starts_at, ends_at, status, location, location_id, setup_before_minutes, transition_after_minutes, presence, origin, disruption_source, disruption_open_ended, landed_at, share_to_calendar, share_source)
      VALUES (${id}, ${userId}, ${commitment.title}, ${new Date(commitment.startsAt)}, ${new Date(commitment.endsAt)}, ${commitment.status ?? "confirmed"}, ${commitment.location ?? null}, ${commitment.locationId ?? null}, ${commitment.setupBeforeMinutes ?? 0}, ${commitment.transitionAfterMinutes ?? 0}, ${commitment.presence ?? "blocking"}, ${commitment.origin ?? "planned"}, ${commitment.disruptionSource ?? null}, ${commitment.disruptionOpenEnded ?? false}, ${commitment.landedAt ? new Date(commitment.landedAt) : null}, ${commitment.shareToCalendar ?? false}, ${commitment.shareSource ?? "inherit"})
    `;
  }

  for (const capture of state.captures) {
    const sourceId = await stableUuid(`capture-source:${userId}`, capture.id);
    const proposalId = await stableUuid(`capture-proposal:${userId}`, capture.id);
    await sql`
      INSERT INTO sources (id, user_id, source_type, external_id, captured_text, source_link, occurred_at, created_at)
      VALUES (${sourceId}, ${userId}, ${capture.sourceType}, ${capture.id}, ${capture.text}, ${capture.sourceLink ?? null}, ${new Date(capture.createdAt)}, ${new Date(capture.createdAt)})
    `;
    await sql`
      INSERT INTO captures (id, user_id, source_id, proposal_type, status, proposed_fields, questions, confidence, reviewed_at)
      VALUES (${proposalId}, ${userId}, ${sourceId}, ${capture.proposalType}, ${capture.status}, ${sql.json(capture.proposedFields as never)}, ${sql.json((capture.questions ?? []) as never)}, ${capture.confidence ?? null}, ${capture.reviewedAt ? new Date(capture.reviewedAt) : null})
    `;
  }

  for (const [index, item] of state.completedToday.entries()) {
    const action =
      state.actions.find((candidate) => candidate.id === item.actionId) ??
      state.actions.find((candidate) => candidate.title === item.actionTitle);
    const actionId = action ? actionIdMap.get(action.id) : undefined;
    if (!actionId) continue;
    const endedAt = new Date(item.endedAt);
    const startedAt = new Date(item.startedAt);
    const sessionId = await stableUuid(`completed-session:${userId}`, item.id || `${item.endedAt}:${index}`);
    await sql`
      INSERT INTO sessions (
        id, user_id, action_id, status, planned_started_at, planned_end_at,
        started_at, ended_at, planned_minutes, active_minutes, remaining_before_minutes, remaining_after_minutes, result_note
      ) VALUES (
        ${sessionId}, ${userId}, ${actionId}, ${item.result}, ${startedAt}, ${new Date(startedAt.getTime() + item.plannedMinutes * 60_000)},
        ${startedAt}, ${endedAt}, ${item.plannedMinutes}, ${item.activeMinutes}, ${item.remainingBeforeMinutes}, ${item.remainingAfterMinutes}, ${item.resultNote ?? null}
      )
    `;
    if (item.activeMinutes > 0) {
      const segmentId = await stableUuid(`history-segment:${sessionId}`, "active");
      const segmentEnd = endedAt;
      const segmentStart = new Date(Math.max(startedAt.getTime(), segmentEnd.getTime() - item.activeMinutes * 60_000));
      await sql`INSERT INTO session_segments (id, session_id, started_at, ended_at) VALUES (${segmentId}, ${sessionId}, ${segmentStart}, ${segmentEnd})`;
    }
  }

  if (state.activeSession) {
    const active = state.activeSession;
    const actionId = actionIdMap.get(active.actionId);
    if (actionId) {
      const sessionId = await stableUuid(
        `active-session:${userId}`,
        active.id || `${active.actionId}:${active.startedAt}`
      );
      const status = active.status === "feedback" ? "stopped" : active.status;
      const plannedMinutes = active.plannedMinutes;
      const remainingBefore = active.remainingBeforeMinutes;
      await sql`
        INSERT INTO sessions (
          id, user_id, action_id, status, planned_started_at, planned_end_at,
          started_at, planned_minutes, active_minutes, remaining_before_minutes, paused_remaining_seconds, feedback_requested_at, result_note
        ) VALUES (
          ${sessionId}, ${userId}, ${actionId}, ${status}, ${new Date(active.startedAt)}, ${new Date(active.plannedEndAt)},
          ${new Date(active.startedAt)}, ${plannedMinutes}, ${Math.floor(active.activeElapsedSeconds / 60)}, ${remainingBefore}, ${active.pausedRemainingSeconds ?? null},
          ${active.feedbackRequestedAt ? new Date(active.feedbackRequestedAt) : null}, ${active.note ?? null}
        )
      `;
      if (active.activeElapsedSeconds > 0) {
        const closedSegmentId = await stableUuid(`active-segment:${sessionId}`, "elapsed");
        const syntheticStart = new Date(active.startedAt);
        const syntheticEnd = new Date(syntheticStart.getTime() + active.activeElapsedSeconds * 1000);
        await sql`INSERT INTO session_segments (id, session_id, started_at, ended_at, interruption_note) VALUES (${closedSegmentId}, ${sessionId}, ${syntheticStart}, ${syntheticEnd}, 'Accumulated active time before current state')`;
      }
      if (active.status === "running" && active.segmentStartedAt) {
        const openSegmentId = await stableUuid(`active-segment:${sessionId}`, "open");
        await sql`INSERT INTO session_segments (id, session_id, started_at) VALUES (${openSegmentId}, ${sessionId}, ${new Date(active.segmentStartedAt)})`;
      }
    }
  }
  await restoreClosedStamps(sql, closedStamps);
}

const STAMPED_TABLES = {
  areas:
    "SELECT t.id::text AS id, t.closed_at, t.closed_from_status, t.closed_by, t.closed_batch, t.closed_reason FROM areas t WHERE t.closed_at IS NOT NULL AND t.user_id = $1",
  outcomes:
    "SELECT t.id::text AS id, t.closed_at, t.closed_from_status, t.closed_by, t.closed_batch, t.closed_reason FROM outcomes t JOIN areas a ON a.id = t.area_id WHERE t.closed_at IS NOT NULL AND a.user_id = $1",
  projects:
    "SELECT t.id::text AS id, t.closed_at, t.closed_from_status, t.closed_by, t.closed_batch, t.closed_reason FROM projects t JOIN outcomes o ON o.id = t.outcome_id JOIN areas a ON a.id = o.area_id WHERE t.closed_at IS NOT NULL AND a.user_id = $1",
  actions:
    "SELECT t.id::text AS id, t.closed_at, t.closed_from_status, t.closed_by, t.closed_batch, t.closed_reason FROM actions t JOIN projects p ON p.id = t.project_id JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id WHERE t.closed_at IS NOT NULL AND a.user_id = $1",
  deliverables:
    "SELECT t.id::text AS id, t.closed_at, t.closed_from_status, t.closed_by, t.closed_batch, t.closed_reason FROM deliverables t JOIN projects p ON p.id = t.project_id JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id WHERE t.closed_at IS NOT NULL AND a.user_id = $1",
  commitments:
    "SELECT t.id::text AS id, t.closed_at, t.closed_from_status, t.closed_by, t.closed_batch, t.closed_reason FROM commitments t WHERE t.closed_at IS NOT NULL AND t.user_id = $1"
} as const;

type ClosedStampRow = {
  id: string;
  closed_at: Date;
  closed_from_status: string | null;
  closed_by: string | null;
  closed_batch: string | null;
  closed_reason: string | null;
};

async function readClosedStamps(sql: Sql, userId: string): Promise<Map<string, ClosedStampRow[]>> {
  const stamps = new Map<string, ClosedStampRow[]>();
  for (const [table, query] of Object.entries(STAMPED_TABLES))
    stamps.set(table, await sql.unsafe<ClosedStampRow[]>(query, [userId]));
  return stamps;
}

/** A row written closed again by the rewrite gets its old stamp back; a row that is no longer closed is left alone. */
async function restoreClosedStamps(sql: Sql, stamps: Map<string, ClosedStampRow[]>): Promise<void> {
  for (const [table, rows] of stamps)
    for (const row of rows)
      await sql.unsafe(
        `UPDATE ${table} SET closed_at = $2, closed_from_status = $3, closed_by = $4, closed_batch = $5, closed_reason = $6
         WHERE id = $1::uuid AND closed_at IS NOT NULL`,
        [row.id, row.closed_at, row.closed_from_status, row.closed_by, row.closed_batch, row.closed_reason]
      );
}

/**
 * The date an action's estimate takes in a whole-state put: the document's own when it carries one; else the stored
 * date while the remaining time is unchanged; else now, as a new or changed figure is said now.
 */
function remainingSetAt(
  given: string | undefined,
  stored: { remaining_minutes: number; remaining_set_at: Date } | undefined,
  remainingMinutes: number
): Date {
  if (given) return new Date(given);
  return stored && stored.remaining_minutes === remainingMinutes ? stored.remaining_set_at : new Date();
}
