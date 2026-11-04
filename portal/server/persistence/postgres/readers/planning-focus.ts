import { planningFocusPeriods } from "@openrhen/database";
import type { PlanningFocus } from "@/state/portal-state";
import type { Row } from "../db-row";
import { localDateString } from "../row-values";
import type { Sql } from "../sql-pool";

export async function readPlanningFocus(sql: Sql, userId: string): Promise<PlanningFocus[]> {
  const planningFocusRows = await sql<
    (Row<typeof planningFocusPeriods, "id" | "period_start" | "period_end" | "version" | "reviewed_on"> & {
      kind: PlanningFocus["kind"];
      project_ids: unknown;
    })[]
  >`
      SELECT id, kind, period_start, period_end, version, reviewed_on,
        (SELECT COALESCE(json_agg(fp.project_id ORDER BY fp.project_id), '[]'::json)
          FROM planning_focus_projects fp WHERE fp.focus_period_id = planning_focus_periods.id) AS project_ids
      FROM planning_focus_periods WHERE user_id=${userId} ORDER BY period_start DESC, kind LIMIT 24
    `;
  return planningFocusRows.map((row) => ({
    id: row.id,
    version: row.version,
    kind: row.kind,
    periodStart: localDateString(row.period_start),
    periodEnd: localDateString(row.period_end),
    ...(row.reviewed_on ? { reviewedOn: localDateString(row.reviewed_on) } : {}),
    projectIds: Array.isArray(row.project_ids)
      ? row.project_ids.filter((value): value is string => typeof value === "string")
      : []
  }));
}
