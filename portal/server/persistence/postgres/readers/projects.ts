import { projects } from "@openrhen/database";
import type { StoredProject } from "@/state/portal-state";
import type { Row } from "../db-row";
import type { readPrerequisiteMap } from "../prerequisites";
import { iso } from "../row-values";
import type { Sql } from "../sql-pool";

export async function readProjects(
  sql: Sql,
  userId: string,
  prerequisiteMap: Awaited<ReturnType<typeof readPrerequisiteMap>>
): Promise<StoredProject[]> {
  const projectRows = await sql<
    (Row<
      typeof projects,
      | "id"
      | "outcome_id"
      | "title"
      | "status"
      | "uncertainty"
      | "internal_deadline_at"
      | "external_deadline_at"
      | "last_worked_at"
      | "last_reviewed_at"
      | "overdue_seen_at"
      | "created_at"
      | "consequence"
      | "version"
      | "remaining_effort_override_minutes"
      | "actual_completion_ratio"
      | "required_completion_ratio"
      | "private"
    > & { area: string; value: number })[]
  >`
      SELECT p.id, p.outcome_id, p.title, a.name AS area, p.status, p.uncertainty,
        p.internal_deadline_at, p.external_deadline_at, p.last_worked_at, p.last_reviewed_at, p.overdue_seen_at, p.created_at,
        o.value, p.consequence, p.version, p.remaining_effort_override_minutes, p.actual_completion_ratio, p.required_completion_ratio, p.private
      FROM projects p
      JOIN outcomes o ON o.id = p.outcome_id
      JOIN areas a ON a.id = o.area_id
      WHERE a.user_id = ${userId}
      ORDER BY a.sort_order, p.created_at, p.id
    `;
  return projectRows.map((row) => ({
    id: row.id,
    version: row.version,
    outcomeId: row.outcome_id,
    title: row.title,
    area: row.area,
    status: row.status,
    uncertainty: row.uncertainty,
    value: row.value,
    consequence: row.consequence,
    ...(iso(row.internal_deadline_at) ? { internalDeadlineAt: iso(row.internal_deadline_at)! } : {}),
    ...(iso(row.external_deadline_at) ? { externalDeadlineAt: iso(row.external_deadline_at)! } : {}),
    ...(iso(row.last_worked_at) ? { lastWorkedAt: iso(row.last_worked_at)! } : {}),
    ...(iso(row.last_reviewed_at) ? { lastReviewedAt: iso(row.last_reviewed_at)! } : {}),
    ...(iso(row.overdue_seen_at) ? { overdueSeenAt: iso(row.overdue_seen_at)! } : {}),
    ...(iso(row.created_at) ? { createdAt: iso(row.created_at)! } : {}),
    ...(row.actual_completion_ratio !== null ? { actualCompletionRatio: Number(row.actual_completion_ratio) } : {}),
    ...(row.required_completion_ratio !== null
      ? { requiredCompletionRatio: Number(row.required_completion_ratio) }
      : {}),
    ...(row.remaining_effort_override_minutes !== null
      ? { remainingEffortOverrideMinutes: row.remaining_effort_override_minutes }
      : {}),
    ...(row.private ? { private: true } : {}),
    prerequisites: prerequisiteMap.get(`project:${row.id}`) ?? []
  }));
}
