import type { Sql } from "./sql-pool";

/**
 * The open rows under an area, outcome or project (archive-removals plan D19): outcomes, projects, plain actions and
 * deliverables that are neither finished nor already closed. Deliverable steps are `actions` rows with a
 * `deliverable_id`; they are not the parent's children (they follow their deliverable), so they are left out. Read
 * only: the close command decides what to do with the answer.
 */
export interface OpenChild {
  type: "outcome" | "project" | "action" | "deliverable";
  /** The stored id. */
  id: string;
  title: string;
  status: string;
  version: number;
  /** Whether the row carries a deadline that is someone else's: an outcome's or action's own, or a project's or deliverable's external one. */
  deadlined: boolean;
  /**
   * Whether closing it is the owner's call (plan D9): a deadline, a requirement pathway, prep for a shared commitment.
   * An agent closes only children for which this is false.
   */
  needsOwner: boolean;
}

const OPEN_ACTION = ["inbox", "planned", "active", "doing", "waiting", "blocked"];
const OPEN_DELIVERABLE = [
  "needs_breakdown",
  "ready",
  "in_progress",
  "under_review",
  "awaiting_result",
  "ready_to_complete"
];

export async function resolveOpenChildren(
  tx: Sql,
  parent: { type: "area" | "outcome" | "project"; id: string },
  lock = false
): Promise<OpenChild[]> {
  const forUpdate = lock ? tx`FOR NO KEY UPDATE` : tx``;
  const found: OpenChild[] = [];
  let outcomeIds: string[] = [];
  let projectIds: string[] = [];
  if (parent.type === "area") {
    const outcomes = await tx<
      { id: string; title: string; status: string; version: number; deadlined: boolean }[]
    >`SELECT id, title, status::text AS status, version, (deadline_at IS NOT NULL) AS deadlined FROM outcomes WHERE area_id=${parent.id} ${forUpdate}`;
    outcomeIds = outcomes.map((row) => row.id);
    for (const row of outcomes)
      if (row.status === "active" || row.status === "paused")
        found.push({ type: "outcome", ...row, needsOwner: row.deadlined });
  } else if (parent.type === "outcome") outcomeIds = [parent.id];
  if (parent.type !== "project" && outcomeIds.length > 0) {
    const projects = await tx<
      { id: string; title: string; status: string; version: number; deadlined: boolean }[]
    >`SELECT id, title, status::text AS status, version, (external_deadline_at IS NOT NULL) AS deadlined FROM projects WHERE outcome_id IN ${tx(outcomeIds)} ${forUpdate}`;
    projectIds = projects.map((row) => row.id);
    for (const row of projects)
      if (row.status === "active" || row.status === "paused")
        found.push({ type: "project", ...row, needsOwner: row.deadlined });
  } else if (parent.type === "project") projectIds = [parent.id];
  if (projectIds.length > 0) {
    const actions = await tx<
      { id: string; title: string; status: string; version: number; deadlined: boolean }[]
    >`SELECT id, title, status::text AS status, version, (deadline_at IS NOT NULL) AS deadlined FROM actions WHERE project_id IN ${tx(projectIds)} AND deliverable_id IS NULL ${forUpdate}`;
    const open = actions.filter((row) => OPEN_ACTION.includes(row.status));
    const ids = open.map((row) => row.id);
    const owned = new Set<string>();
    if (ids.length > 0) {
      for (const row of await tx<
        { id: string }[]
      >`SELECT DISTINCT action_id AS id FROM action_requirement_pathways WHERE action_id IN ${tx(ids)}`)
        owned.add(row.id);
      for (const row of await tx<
        { id: string }[]
      >`SELECT ac.id FROM actions ac JOIN commitments c ON c.id=ac.prep_for_commitment_id WHERE ac.id IN ${tx(ids)} AND c.share_to_calendar`)
        owned.add(row.id);
    }
    for (const row of open) found.push({ type: "action", ...row, needsOwner: row.deadlined || owned.has(row.id) });
    const deliverables = await tx<
      { id: string; title: string; status: string; version: number; deadlined: boolean }[]
    >`SELECT id, title, status::text AS status, version, (external_deadline_at IS NOT NULL) AS deadlined FROM deliverables WHERE project_id IN ${tx(projectIds)} ${forUpdate}`;
    for (const row of deliverables)
      if (OPEN_DELIVERABLE.includes(row.status)) found.push({ type: "deliverable", ...row, needsOwner: row.deadlined });
  }
  return found;
}
