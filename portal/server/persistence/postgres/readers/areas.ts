import { areas } from "@openrhen/database";
import type { StoredArea } from "@/state/portal-state";
import type { Row } from "../db-row";
import type { Sql } from "../sql-pool";

export async function readAreas(sql: Sql, userId: string): Promise<StoredArea[]> {
  const areaRows = await sql<
    Row<typeof areas, "id" | "version" | "name" | "description" | "status" | "sort_order" | "private">[]
  >`
      SELECT id, version, name, description, status, sort_order, private FROM areas WHERE user_id = ${userId} ORDER BY sort_order, name
    `;
  return areaRows.map((row) => ({
    id: row.id,
    version: row.version,
    name: row.name,
    status: row.status,
    sortOrder: row.sort_order,
    ...(row.description ? { description: row.description } : {}),
    ...(row.private ? { private: true } : {})
  }));
}
