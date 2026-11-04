import { spans } from "@openrhen/database";
import { spanReadRange } from "@/shared/history-window";
import type { StoredSpan } from "@/state/portal-state";
import type { Row } from "../db-row";
import { localDateString } from "../row-values";
import type { Sql } from "../sql-pool";

export async function readSpans(sql: Sql, userId: string, readAt: Date, timezone: string): Promise<StoredSpan[]> {
  const spanRange = spanReadRange(readAt, timezone);
  const spanRows = await sql<
    (Row<typeof spans, "id" | "version" | "title" | "start_date" | "end_date" | "window" | "project_id"> & {
      window: StoredSpan["window"] | null;
    })[]
  >`
      SELECT id, version, title, start_date, end_date, "window", project_id FROM spans
      WHERE user_id=${userId} AND end_date >= ${spanRange.from}::date AND start_date <= ${spanRange.to}::date
      ORDER BY start_date, end_date, id
    `;
  return spanRows.map((row) => ({
    id: row.id,
    version: row.version,
    title: row.title,
    startDate: localDateString(row.start_date),
    endDate: localDateString(row.end_date),
    ...(row.window ? { window: row.window } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {})
  }));
}
