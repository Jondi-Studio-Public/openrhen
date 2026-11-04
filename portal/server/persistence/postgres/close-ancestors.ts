import { CLOSE_TABLE_OF, isClosedStatus, type CloseType } from "@openrhen/contracts";
import type { Sql } from "./sql-pool";

/** The ancestors of a row, top down (area, outcome, project), as (type, stored id). */
export async function ancestorsOf(tx: Sql, type: CloseType, id: string): Promise<{ type: CloseType; id: string }[]> {
  if (type === "outcome") {
    const row = (await tx<{ area_id: string }[]>`SELECT area_id FROM outcomes WHERE id=${id}`)[0];
    return row ? [{ type: "area", id: row.area_id }] : [];
  }
  const chainOfProject = async (projectId: string) => {
    const row = (
      await tx<
        { outcome_id: string; area_id: string }[]
      >`SELECT p.outcome_id, o.area_id FROM projects p JOIN outcomes o ON o.id=p.outcome_id WHERE p.id=${projectId}`
    )[0];
    return row
      ? [
          { type: "area" as const, id: row.area_id },
          { type: "outcome" as const, id: row.outcome_id },
          { type: "project" as const, id: projectId }
        ]
      : [];
  };
  if (type === "project") return (await chainOfProject(id)).slice(0, 2);
  let projectId: string | null = null;
  if (type === "action")
    projectId =
      (await tx<{ project_id: string }[]>`SELECT project_id FROM actions WHERE id=${id}`)[0]?.project_id ?? null;
  if (type === "deliverable")
    projectId =
      (await tx<{ project_id: string }[]>`SELECT project_id FROM deliverables WHERE id=${id}`)[0]?.project_id ?? null;
  if (type === "commitment")
    projectId =
      (await tx<{ project_id: string | null }[]>`SELECT project_id FROM commitments WHERE id=${id}`)[0]?.project_id ??
      null;
  return projectId === null ? [] : chainOfProject(projectId);
}

/**
 * The first closed ancestor of a row, read top down (area, outcome, project) with `FOR SHARE`, so a concurrent close of
 * an ancestor (which takes `FOR NO KEY UPDATE`) waits for the restore that holds it and then sees the restored child.
 */
export async function firstClosedAncestor(
  tx: Sql,
  type: CloseType,
  id: string
): Promise<{ type: CloseType; id: string; status: string; version: number } | null> {
  for (const ancestor of await ancestorsOf(tx, type, id)) {
    const table = CLOSE_TABLE_OF[ancestor.type];
    const row = (
      await tx<
        { status: string; version: number }[]
      >`SELECT status::text AS status, version FROM ${tx(table)} WHERE id=${ancestor.id} FOR SHARE`
    )[0];
    if (row && isClosedStatus(row.status))
      return { type: ancestor.type, id: ancestor.id, status: row.status, version: row.version };
  }
  return null;
}
