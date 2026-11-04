import { outcomes } from "@openrhen/database";
import type { StoredOutcome } from "@/state/portal-state";
import type { Row } from "../db-row";
import { iso, localDateString } from "../row-values";
import type { Sql } from "../sql-pool";

export async function readOutcomes(sql: Sql, userId: string): Promise<StoredOutcome[]> {
  const outcomeRows = await sql<
    Row<
      typeof outcomes,
      "id" | "area_id" | "title" | "definition_of_done" | "value" | "status" | "deadline_at" | "review_on" | "version"
    >[]
  >`
      SELECT o.id, o.area_id, o.title, o.definition_of_done, o.value, o.status, o.deadline_at, o.review_on, o.version
      FROM outcomes o JOIN areas a ON a.id = o.area_id
      WHERE a.user_id = ${userId} ORDER BY o.created_at, o.id
    `;
  return outcomeRows.map((row) => ({
    id: row.id,
    version: row.version,
    areaId: row.area_id,
    title: row.title,
    definitionOfDone: row.definition_of_done,
    value: row.value,
    status: row.status,
    ...(iso(row.deadline_at) ? { deadlineAt: iso(row.deadline_at)! } : {}),
    ...(row.review_on ? { reviewOn: localDateString(row.review_on) } : {})
  }));
}
