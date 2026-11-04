import { CLOSED_TABLES, type DoctorClosedSlice } from "@openrhen/contracts";
import { OWNED_BY_USER } from "./closed-ownership";
import type { Sql } from "./sql-pool";

/**
 * The closed-stamp family of the data health check: per table in CLOSED_TABLES, the rows holding `closed_at` while
 * not closed and the closed rows with none. User-scoped through each table's owner path; counts only, writes nothing.
 */

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
