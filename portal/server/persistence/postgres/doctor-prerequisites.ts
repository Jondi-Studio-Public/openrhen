import type { PrerequisiteKind, PrerequisiteRef } from "@openrhen/contracts";
import type { DoctorPrerequisitesSlice } from "@openrhen/contracts";
import type { Sql } from "./sql-pool";

/**
 * The doctor's prerequisites-and-blockers reader: the plain slice
 * `prerequisiteItems` checks. User-scoped and bounded; items are made for active projects only. A prerequisite
 * target outside the active projects is read too (by id), because a finished one is what makes the edge met.
 * Titles and blocker descriptions are imported data, passed through as data. Writes nothing.
 */

const LIMIT = 500;

const group = <T>(rows: T[], key: (row: T) => string): Map<string, T[]> => {
  const map = new Map<string, T[]>();
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
  return map;
};
/** `IN ()` is a syntax error, so an empty list becomes one id that matches nothing. */
const some = (ids: string[]): string[] => (ids.length ? ids : ["-"]);
const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export async function readPrerequisitesSlice(sql: Sql, userId: string, _now: Date): Promise<DoctorPrerequisitesSlice> {
  const owned = sql`JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id WHERE a.user_id = ${userId}`;

  // The active scope: every project, the deliverables and the top-level actions of the active ones.
  const [projectRows, deliverableRows, actionRows] = await Promise.all([
    sql<{ id: string; title: string; status: string }[]>`
      SELECT p.id::text AS id, p.title, p.status::text AS status FROM projects p ${owned}
      ORDER BY (p.status = 'active') DESC, p.created_at, p.id LIMIT ${LIMIT}`,
    sql<
      {
        id: string;
        project_id: string;
        title: string;
        status: string;
        created_at: Date;
        action_count: number;
        criterion_count: number;
      }[]
    >`
      SELECT d.id::text AS id, d.project_id::text AS project_id, d.title, d.status::text AS status, d.created_at,
        (SELECT count(*)::int FROM actions x WHERE x.deliverable_id = d.id) AS action_count,
        (SELECT count(*)::int FROM deliverable_criteria c WHERE c.deliverable_id = d.id) AS criterion_count
      FROM deliverables d JOIN projects p ON p.id = d.project_id ${owned} AND p.status = 'active'
      ORDER BY d.created_at, d.id LIMIT ${LIMIT}`,
    sql<{ id: string; project_id: string; title: string; status: string }[]>`
      SELECT x.id::text AS id, x.project_id::text AS project_id, x.title, x.status::text AS status
      FROM actions x JOIN projects p ON p.id = x.project_id ${owned} AND p.status = 'active'
      AND x.deliverable_id IS NULL AND x.status::text NOT IN ('done','cancelled','archived')
      ORDER BY x.created_at, x.id LIMIT ${LIMIT}`
  ]);

  const projectIds = projectRows.map((r) => r.id);
  const deliverableIds = deliverableRows.map((r) => r.id);
  const actionIds = actionRows.map((r) => r.id);
  const [extraRows, actionEdges, deliverableEdges] = await Promise.all([
    sql<{ entity_kind: PrerequisiteKind; entity_id: string; requires_kind: PrerequisiteKind; requires_id: string }[]>`
      SELECT ep.entity_kind, ep.entity_id::text AS entity_id, ep.requires_kind, ep.requires_id::text AS requires_id
      FROM entity_prerequisites ep
      WHERE (ep.entity_kind = 'project' AND ep.entity_id::text IN ${sql(some(projectIds))})
         OR (ep.entity_kind = 'deliverable' AND ep.entity_id::text IN ${sql(some(deliverableIds))})
         OR (ep.entity_kind = 'action' AND ep.entity_id::text IN ${sql(some(actionIds))})
      ORDER BY ep.created_at, ep.requires_kind, ep.requires_id LIMIT ${LIMIT * 4}`,
    sql<{ a: string; b: string }[]>`
      SELECT action_id::text AS a, depends_on_action_id::text AS b FROM action_dependencies
      WHERE action_id::text IN ${sql(some(actionIds))} LIMIT ${LIMIT * 4}`,
    sql<{ a: string; b: string }[]>`
      SELECT deliverable_id::text AS a, depends_on_deliverable_id::text AS b FROM deliverable_dependencies
      WHERE deliverable_id::text IN ${sql(some(deliverableIds))} LIMIT ${LIMIT * 4}`
  ]);

  // Targets outside the loaded scope, by id and still user-scoped: their finished state decides the edge.
  const have = {
    project: new Set(projectIds),
    deliverable: new Set(deliverableIds),
    action: new Set(actionIds)
  };
  const want = { project: new Set<string>(), deliverable: new Set<string>(), action: new Set<string>() };
  for (const r of extraRows) if (!have[r.requires_kind].has(r.requires_id)) want[r.requires_kind].add(r.requires_id);
  for (const e of actionEdges) if (!have.action.has(e.b)) want.action.add(e.b);
  for (const e of deliverableEdges) if (!have.deliverable.has(e.b)) want.deliverable.add(e.b);
  const [moreProjects, moreDeliverables, moreActions] = await Promise.all([
    want.project.size
      ? sql<{ id: string; title: string; status: string }[]>`
          SELECT p.id::text AS id, p.title, p.status::text AS status FROM projects p ${owned}
          AND p.id::text IN ${sql([...want.project])} LIMIT ${LIMIT}`
      : [],
    want.deliverable.size
      ? sql<{ id: string; project_id: string; title: string; status: string; created_at: Date }[]>`
          SELECT d.id::text AS id, d.project_id::text AS project_id, d.title, d.status::text AS status, d.created_at
          FROM deliverables d JOIN projects p ON p.id = d.project_id ${owned}
          AND d.id::text IN ${sql([...want.deliverable])} LIMIT ${LIMIT}`
      : [],
    want.action.size
      ? sql<{ id: string; project_id: string; title: string; status: string }[]>`
          SELECT x.id::text AS id, x.project_id::text AS project_id, x.title, x.status::text AS status
          FROM actions x JOIN projects p ON p.id = x.project_id ${owned}
          AND x.id::text IN ${sql([...want.action])} LIMIT ${LIMIT}`
      : []
  ]);

  const extras = group(extraRows, (r) => `${r.entity_kind}:${r.entity_id}`);
  const prerequisitesOf = (kind: PrerequisiteKind, id: string): PrerequisiteRef[] =>
    (extras.get(`${kind}:${id}`) ?? []).map((r) => ({ kind: r.requires_kind, id: r.requires_id }));
  const actionDeps = group(actionEdges, (r) => r.a);
  const deliverableDeps = group(deliverableEdges, (r) => r.a);

  // Blockers and contact links, for active deliverables only.
  const [blockerRows, linkRows] = await Promise.all([
    deliverableIds.length
      ? sql<
          {
            id: string;
            deliverable_id: string;
            description: string;
            category: string;
            state: string;
            created_at: Date;
          }[]
        >`
          SELECT b.id::text AS id, b.deliverable_id::text AS deliverable_id, b.description, b.category::text AS category,
            b.state::text AS state, b.created_at
          FROM deliverable_blockers b
          WHERE b.deliverable_id::text IN ${sql(some(deliverableIds))} AND b.category::text = 'waiting_on_someone'
            AND b.state::text IN ('open','awaiting_response')
          ORDER BY b.created_at, b.id LIMIT ${LIMIT}`
      : [],
    deliverableIds.length
      ? sql<{ from_type: string; from_id: string }[]>`
          SELECT DISTINCT from_type, from_id FROM plan_links
          WHERE user_id = ${userId} AND kind = 'involves' AND status = 'confirmed' AND to_type = 'contact'
            AND from_type = 'deliverable' AND from_id IN ${sql(some(deliverableIds))} LIMIT ${LIMIT}`
      : []
  ]);

  return {
    projects: [...projectRows, ...moreProjects].map((r) => ({ ...r, prerequisites: prerequisitesOf("project", r.id) })),
    deliverables: [
      ...deliverableRows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        title: r.title,
        status: r.status,
        createdAt: iso(r.created_at),
        dependencyIds: (deliverableDeps.get(r.id) ?? []).map((e) => e.b),
        prerequisites: prerequisitesOf("deliverable", r.id),
        actionCount: r.action_count,
        criterionCount: r.criterion_count
      })),
      // Out-of-scope targets: only their finished state matters, so they carry no edges and count as non-empty.
      ...moreDeliverables.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        title: r.title,
        status: r.status,
        createdAt: iso(r.created_at),
        dependencyIds: [],
        prerequisites: [],
        actionCount: 1,
        criterionCount: 1
      }))
    ],
    actions: [...actionRows, ...moreActions].map((r) => ({
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      status: r.status,
      dependencyIds: (actionDeps.get(r.id) ?? []).map((e) => e.b),
      prerequisites: prerequisitesOf("action", r.id)
    })),
    blockers: blockerRows.map((r) => ({
      id: r.id,
      deliverableId: r.deliverable_id,
      description: r.description,
      category: r.category,
      state: r.state,
      createdAt: iso(r.created_at)
    })),
    contactLinkedHandles: linkRows.map((r) => `${r.from_type}:${r.from_id}`)
  };
}
