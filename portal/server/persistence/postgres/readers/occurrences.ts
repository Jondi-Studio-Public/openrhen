import { actionOccurrences } from "@openrhen/database";
import type { StoredOccurrence } from "@/state/portal-state";
import type { DbRow } from "../db-row";
import { localDateString } from "../row-values";
import type { Sql } from "../sql-pool";

export async function readOccurrences(
  sql: Sql,
  userId: string,
  window: { from: Date; to: Date }
): Promise<StoredOccurrence[]> {
  const { from: historySince, to: occurrencesThrough } = window;
  // Bounded both ways (see `portal/shared/history-window.ts`). Nothing prunes past occurrences, so
  // unbounded this grew by every window the planner ever materialised, for good.
  const occurrenceRows = await sql<
    (DbRow<typeof actionOccurrences> & {
      window_name: string;
      anchor_source: StoredOccurrence["anchorSource"];
      status: StoredOccurrence["status"];
    })[]
  >`SELECT oc.*,w.name AS window_name FROM action_occurrences oc JOIN action_recurrence_windows w ON w.id=oc.window_id JOIN actions ac ON ac.id=oc.action_id JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE a.user_id=${userId} AND oc.window_ends_at>=${historySince} AND oc.window_starts_at<${occurrencesThrough} ORDER BY oc.window_starts_at`;
  return occurrenceRows.map((row) => ({
    id: row.id,
    version: row.version,
    actionId: row.action_id,
    recurrenceRuleId: row.rule_id,
    windowId: row.window_id,
    windowName: row.window_name,
    localDate: localDateString(row.local_date),
    windowStartsAt: row.window_starts_at.toISOString(),
    windowEndsAt: row.window_ends_at.toISOString(),
    anchorSource: row.anchor_source,
    status: row.status,
    ...(row.routine_covered ? { routineCovered: true } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {})
  }));
}
