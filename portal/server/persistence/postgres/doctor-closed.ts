import { CLOSED_TABLES, type DoctorClosedSlice } from "@openrhen/contracts";
import type { Sql } from "./sql-pool";

/**
 * The closed-stamp family of the data health check: per table in CLOSED_TABLES, the rows holding `closed_at` while
 * not closed and the closed rows with none. User-scoped through each table's owner path; counts only, writes nothing.
 */
const OWNED_BY_USER: Record<keyof typeof CLOSED_TABLES, string> = {
  areas: "t.user_id = $1",
  outcomes: "EXISTS (SELECT 1 FROM areas a WHERE a.id = t.area_id AND a.user_id = $1)",
  projects:
    "EXISTS (SELECT 1 FROM outcomes o JOIN areas a ON a.id = o.area_id WHERE o.id = t.outcome_id AND a.user_id = $1)",
  actions:
    "EXISTS (SELECT 1 FROM projects p JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id WHERE p.id = t.project_id AND a.user_id = $1)",
  deliverables:
    "EXISTS (SELECT 1 FROM projects p JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id WHERE p.id = t.project_id AND a.user_id = $1)",
  commitments: "t.user_id = $1",
  routine_presets: "t.user_id = $1",
  condition_definitions: "t.user_id = $1"
};

export async function readClosedSlice(sql: Sql, userId: string): Promise<DoctorClosedSlice> {
  const tables: DoctorClosedSlice["tables"] = [];
  for (const [table, rule] of Object.entries(CLOSED_TABLES)) {
    // Table and status names come from the CLOSED_TABLES constant, never from input.
    const closed = rule.closed.map((status) => `'${status}'`).join(",");
    const rows = await sql.unsafe<{ stray: number; missing: number }[]>(
      `SELECT count(*) FILTER (WHERE t.closed_at IS NOT NULL AND t.status::text NOT IN (${closed}))::int AS stray,
        count(*) FILTER (WHERE t.closed_at IS NULL AND t.status::text IN (${closed}))::int AS missing
      FROM ${table} t WHERE ${OWNED_BY_USER[table as keyof typeof CLOSED_TABLES]}`,
      [userId]
    );
    const row = rows[0];
    if (row && (row.stray > 0 || row.missing > 0))
      tables.push({ table, strayStamp: row.stray, missingStamp: row.missing });
  }
  return { tables };
}
