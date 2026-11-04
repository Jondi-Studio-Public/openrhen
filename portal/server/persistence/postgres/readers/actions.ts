import {
  actionCadenceCompletions,
  actionDependencies,
  actionPreferences,
  actionRecurrenceRules,
  actionRecurrenceWindows,
  actionRequirementPathways,
  actionRequirements,
  actions
} from "@openrhen/database";
import type { StoredAction } from "@/state/portal-state";
import type { DbRow, Row } from "../db-row";
import type { readPrerequisiteMap } from "../prerequisites";
import { iso, localDateString } from "../row-values";
import type { Sql } from "../sql-pool";

type Recurrence = NonNullable<StoredAction["recurrence"]>;

/** Every action outside a deliverable, with its dependencies, requirement pathways and recurrence rule. */
export async function readActions(
  sql: Sql,
  userId: string,
  prerequisiteMap: Awaited<ReturnType<typeof readPrerequisiteMap>>
): Promise<StoredAction[]> {
  const actionRows = await sql<
    (Row<
      typeof actions,
      | "id"
      | "project_id"
      | "title"
      | "status"
      | "optimistic_minutes"
      | "expected_minutes"
      | "remaining_minutes"
      | "remaining_set_at"
      | "pessimistic_minutes"
      | "energy"
      | "minimum_session_minutes"
      | "maximum_session_minutes"
      | "splittable"
      | "setup_minutes"
      | "importance"
      | "consequence"
      | "available_from"
      | "deadline_at"
      | "latest_start_at"
      | "last_worked_at"
      | "created_at"
      | "dependencies_complete"
      | "estimate_needs_review"
      | "assumed_fields"
      | "version"
      | "scheduling_mode"
      | "notes"
      | "private"
      | "prep_for_commitment_id"
    > & { scheduling_mode: StoredAction["schedulingMode"] })[]
  >`
      SELECT ac.id, ac.project_id, ac.title, ac.status, ac.optimistic_minutes, ac.expected_minutes, ac.remaining_minutes, ac.remaining_set_at, ac.pessimistic_minutes,
        ac.energy, ac.minimum_session_minutes, ac.maximum_session_minutes, ac.splittable, ac.setup_minutes, ac.importance, ac.consequence,
        ac.available_from, ac.deadline_at, ac.latest_start_at, ac.last_worked_at, ac.created_at, ac.dependencies_complete, ac.estimate_needs_review, to_jsonb(ac.assumed_fields) AS assumed_fields, ac.version, ac.scheduling_mode, ac.notes, ac.private, ac.prep_for_commitment_id
      FROM actions ac
      JOIN projects p ON p.id = ac.project_id
      JOIN outcomes o ON o.id = p.outcome_id
      JOIN areas a ON a.id = o.area_id
      WHERE a.user_id = ${userId} AND ac.deliverable_id IS NULL
      ORDER BY ac.sort_order, ac.created_at, ac.id
    `;
  const dependencyRows = await sql<Row<typeof actionDependencies, "action_id" | "depends_on_action_id">[]>`
      SELECT action_id, depends_on_action_id FROM action_dependencies
      WHERE action_id IN (SELECT ac.id FROM actions ac JOIN projects p ON p.id = ac.project_id JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id WHERE a.user_id = ${userId})
      ORDER BY created_at, depends_on_action_id
    `;
  const dependenciesByAction = new Map<string, string[]>();
  for (const row of dependencyRows)
    dependenciesByAction.set(row.action_id, [
      ...(dependenciesByAction.get(row.action_id) ?? []),
      row.depends_on_action_id
    ]);
  const recurrenceRows = await sql<
    (DbRow<typeof actionRecurrenceRules> & { completion_mode: Recurrence["completionMode"] })[]
  >`SELECT r.* FROM action_recurrence_rules r JOIN actions ac ON ac.id=r.action_id JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE a.user_id=${userId}`;
  const recurrenceWindowRows = await sql<
    (DbRow<typeof actionRecurrenceWindows> & { anchor: Recurrence["windows"][number]["anchor"] })[]
  >`SELECT w.* FROM action_recurrence_windows w JOIN action_recurrence_rules r ON r.id=w.rule_id JOIN actions ac ON ac.id=r.action_id JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE a.user_id=${userId} ORDER BY w.created_at,w.id`;
  // A cadence rule's "last done" is read from its completion log, never stored on the rule.
  const cadenceRows = await sql<
    (Row<typeof actionCadenceCompletions, "rule_id"> & {
      last_completed_at: Date;
      last_local_date: string | Date;
      completion_count: number | string;
    })[]
  >`SELECT cc.rule_id, MAX(cc.completed_at) AS last_completed_at, MAX(cc.local_date) AS last_local_date, COUNT(*)::int AS completion_count FROM action_cadence_completions cc JOIN actions ac ON ac.id=cc.action_id JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE a.user_id=${userId} GROUP BY cc.rule_id`;
  const cadenceByRule = new Map(cadenceRows.map((row) => [row.rule_id, row]));
  // a period rule counts completions within its own window/month, not just the latest one, so
  // the full per-date log is loaded alongside the last-completion summary above.
  const cadenceCompletionRows = await sql<
    Row<typeof actionCadenceCompletions, "rule_id" | "local_date">[]
  >`SELECT cc.rule_id, cc.local_date FROM action_cadence_completions cc JOIN actions ac ON ac.id=cc.action_id JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE a.user_id=${userId} ORDER BY cc.local_date`;
  const completionDatesByRule = new Map<string, string[]>();
  for (const row of cadenceCompletionRows)
    completionDatesByRule.set(row.rule_id, [
      ...(completionDatesByRule.get(row.rule_id) ?? []),
      localDateString(row.local_date)
    ]);
  const requirementPathwayRows = await sql<Row<typeof actionRequirementPathways, "id" | "action_id" | "sort_order">[]>`
      SELECT rp.id, rp.action_id, rp.sort_order FROM action_requirement_pathways rp
      JOIN actions ac ON ac.id = rp.action_id JOIN projects p ON p.id = ac.project_id JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
      WHERE a.user_id = ${userId} ORDER BY rp.action_id, rp.sort_order
    `;
  const requirementRows = await sql<Row<typeof actionRequirements, "pathway_id" | "context_key">[]>`
      SELECT req.pathway_id, req.context_key FROM action_requirements req
      JOIN action_requirement_pathways rp ON rp.id = req.pathway_id
      JOIN actions ac ON ac.id = rp.action_id JOIN projects p ON p.id = ac.project_id JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
      WHERE a.user_id = ${userId} ORDER BY req.context_key
    `;
  const preferenceRows = await sql<Row<typeof actionPreferences, "action_id" | "context_key">[]>`
      SELECT pref.action_id, pref.context_key FROM action_preferences pref
      JOIN actions ac ON ac.id = pref.action_id JOIN projects p ON p.id = ac.project_id JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
      WHERE a.user_id = ${userId} ORDER BY pref.context_key
    `;
  const requirementsByPathway = new Map<string, string[]>();
  for (const row of requirementRows)
    requirementsByPathway.set(row.pathway_id, [...(requirementsByPathway.get(row.pathway_id) ?? []), row.context_key]);
  const pathwaysByAction = new Map<string, { id: string; contextIds: string[] }[]>();
  for (const row of requirementPathwayRows) {
    // A pathway is a set of requirements that hold together, so one with no requirements is not
    // "satisfiable anywhere" — the model has no way to express it and the schema rejects it. A
    // single such row made the entire portal state invalid, which turned into an unbreakable
    // save loop on the Now page rather than anything that named the problem. Dropping it here
    // means an action with no requirements reads as unconstrained, which is what it is.
    const contextIds = requirementsByPathway.get(row.id) ?? [];
    if (!contextIds.length) continue;
    pathwaysByAction.set(row.action_id, [...(pathwaysByAction.get(row.action_id) ?? []), { id: row.id, contextIds }]);
  }
  const preferencesByAction = new Map<string, string[]>();
  for (const row of preferenceRows)
    preferencesByAction.set(row.action_id, [...(preferencesByAction.get(row.action_id) ?? []), row.context_key]);
  return actionRows.map((row) => {
    const recurrence = recurrenceRows.find((item) => item.action_id === row.id);
    return {
      id: row.id,
      version: row.version,
      projectId: row.project_id,
      title: row.title,
      status: row.status,
      optimisticMinutes: row.optimistic_minutes,
      expectedMinutes: row.expected_minutes,
      splittable: row.splittable,
      setupMinutes: row.setup_minutes,
      remainingMinutes: row.remaining_minutes,
      ...(iso(row.remaining_set_at) ? { remainingSetAt: iso(row.remaining_set_at)! } : {}),
      pessimisticMinutes: row.pessimistic_minutes,
      energy: row.energy,
      minimumSessionMinutes: row.minimum_session_minutes,
      maximumSessionMinutes: row.maximum_session_minutes,
      importance: row.importance,
      consequence: row.consequence,
      // `action_contexts` is retired — `requirementPathways` is the sole stored source, and
      // this flat mirror is derived from it (the first route, matching what every writer already
      // keeps in step, see `plan-commands.ts`'s `actionCommand`) purely for the engine's own legacy
      // fallback (`evaluateAdmission` in `engine/core`) when an action carries no pathways at all.
      contexts: pathwaysByAction.get(row.id)?.[0]?.contextIds ?? [],
      dependencyIds: dependenciesByAction.get(row.id) ?? [],
      prerequisites: prerequisiteMap.get(`action:${row.id}`) ?? [],
      requirementPathways: pathwaysByAction.get(row.id) ?? [],
      preferences: preferencesByAction.get(row.id) ?? [],
      ...(iso(row.available_from) ? { availableFrom: iso(row.available_from)! } : {}),
      ...(iso(row.deadline_at) ? { deadlineAt: iso(row.deadline_at)! } : {}),
      ...(iso(row.latest_start_at) ? { latestStartAt: iso(row.latest_start_at)! } : {}),
      ...(iso(row.last_worked_at) ? { lastWorkedAt: iso(row.last_worked_at)! } : {}),
      ...(iso(row.created_at) ? { createdAt: iso(row.created_at)! } : {}),
      ...(row.estimate_needs_review ? { estimateNeedsReview: true } : {}),
      // Selected as JSON: a bare text[] comes back as the string `{a,b}` from a client without `fetch_types` (the
      // engine worker, most tests), which the state schema refuses.
      ...(row.assumed_fields.length ? { assumedFields: row.assumed_fields } : {}),
      ...(row.prep_for_commitment_id ? { prepForCommitmentId: row.prep_for_commitment_id } : {}),
      schedulingMode: row.scheduling_mode,
      ...(row.notes ? { notes: row.notes } : {}),
      ...(recurrence
        ? {
            recurrence: {
              id: recurrence.id,
              version: recurrence.version,
              actionId: row.id,
              timezone: recurrence.timezone,
              startDate: localDateString(recurrence.start_date),
              ...(recurrence.end_date ? { endDate: localDateString(recurrence.end_date) } : {}),
              intervalDays: recurrence.interval_days,
              // present only when the rule was saved with a period; `intervalDays` above
              // stays correct either way, so a caller that ignores period keeps working.
              ...(recurrence.period_unit === "days"
                ? { period: { unit: "days" as const, length: recurrence.period_length! } }
                : recurrence.period_unit === "month"
                  ? { period: { unit: "month" as const } }
                  : {}),
              ...(recurrence.target_occurrences !== null ? { targetOccurrences: recurrence.target_occurrences } : {}),
              ...(recurrence.min_spacing_days !== null ? { minSpacingDays: recurrence.min_spacing_days } : {}),
              ...(recurrence.eligible_weekdays ? { eligibleWeekdays: recurrence.eligible_weekdays } : {}),
              ...(completionDatesByRule.get(recurrence.id)?.length
                ? { completionLocalDates: completionDatesByRule.get(recurrence.id) }
                : {}),
              windows: recurrenceWindowRows
                .filter((window) => window.rule_id === recurrence.id)
                .map((window) => ({
                  id: window.id,
                  name: window.name,
                  anchor: window.anchor,
                  ...(window.start_offset_minutes !== null ? { startOffsetMinutes: window.start_offset_minutes } : {}),
                  ...(window.end_offset_minutes !== null ? { endOffsetMinutes: window.end_offset_minutes } : {}),
                  ...(window.local_start_time ? { localStartTime: window.local_start_time.slice(0, 5) } : {}),
                  ...(window.local_end_time ? { localEndTime: window.local_end_time.slice(0, 5) } : {}),
                  ...(window.fallback_start_time && window.fallback_end_time
                    ? {
                        fallback: {
                          startTime: window.fallback_start_time.slice(0, 5),
                          endTime: window.fallback_end_time.slice(0, 5)
                        }
                      }
                    : {})
                })),
              completionMode: recurrence.completion_mode,
              ...(recurrence.target_total_minutes !== null
                ? { targetTotalMinutes: recurrence.target_total_minutes }
                : {}),
              accumulatedMinutes: recurrence.accumulated_minutes,
              ...(recurrence.completed_at ? { completedAt: recurrence.completed_at.toISOString() } : {}),
              ...cadenceSummary(cadenceByRule.get(recurrence.id))
            }
          }
        : {}),
      ...(row.private ? { private: true } : {})
    };
  });
}

/** The completion-log summary a rule carries, or nothing for a rule that has never been done. */
function cadenceSummary(
  row: { last_completed_at: Date; last_local_date: string | Date; completion_count: number | string } | undefined
) {
  if (!row) return {};
  return {
    lastCompletedAt: new Date(row.last_completed_at).toISOString(),
    lastCompletedLocalDate: localDateString(row.last_local_date),
    completionCount: Number(row.completion_count)
  };
}
