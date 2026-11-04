import {
  firstPrerequisiteCycle,
  prerequisiteKey,
  prerequisiteNodes,
  prerequisiteRefSchema,
  type PrerequisiteKind,
  type PrerequisiteRef
} from "@openrhen/contracts";
import { InvalidCommandError, notFound } from "./command-errors";
import { stableUuid } from "./command-values";
import type { Sql } from "./sql-pool";

/**
 * Extra prerequisites: every edge `action_dependencies` and
 * `deliverable_dependencies` cannot hold. Stored polymorphically in `entity_prerequisites`, so this
 * module owns what foreign keys would otherwise guarantee: ownership, existence, cleanup and cycles.
 */

/** Parses the wire `prerequisites` of a save entity; undefined means the caller said nothing. */
export function parsePrerequisiteRefs(value: unknown): PrerequisiteRef[] | undefined {
  if (value === undefined) return undefined;
  const parsed = prerequisiteRefSchema.array().safeParse(value);
  if (!parsed.success) throw new InvalidCommandError("Prerequisites are invalid.");
  return parsed.data;
}

/** Resolves wire ids to stored ids, rejecting a self reference, a same-kind reference where the
 * owner has its own dependency list, and any target that is missing or another user's. */
export async function resolvePrerequisiteRefs(
  tx: Sql,
  userId: string,
  owner: PrerequisiteRef,
  refs: PrerequisiteRef[]
): Promise<PrerequisiteRef[]> {
  const resolved = new Map<string, PrerequisiteRef>();
  for (const ref of refs) {
    const id = await stableUuid(`${ref.kind}:${userId}`, ref.id);
    if (ref.kind === owner.kind && owner.kind !== "project")
      throw new InvalidCommandError(`A ${owner.kind} lists other ${owner.kind}s in dependencyIds, not prerequisites.`);
    if (ref.kind === owner.kind && id === owner.id)
      throw new InvalidCommandError(`A ${owner.kind} cannot be its own prerequisite.`);
    resolved.set(prerequisiteKey({ kind: ref.kind, id }), { kind: ref.kind, id });
  }
  await assertPrerequisiteTargetsOwned(tx, userId, [...resolved.values()]);
  return [...resolved.values()];
}

/** Rejects any ref whose target is missing or another user's (an action under a deliverable is not addressable). */
export async function assertPrerequisiteTargetsOwned(tx: Sql, userId: string, refs: PrerequisiteRef[]): Promise<void> {
  for (const kind of ["project", "deliverable", "action"] as const) {
    const ids = refs.filter((ref) => ref.kind === kind).map((ref) => ref.id);
    if (!ids.length) continue;
    const owned = await tx<{ id: string }[]>`
      SELECT t.id FROM ${tx(kind === "project" ? "projects" : kind === "deliverable" ? "deliverables" : "actions")} t
      ${
        kind === "project"
          ? tx`JOIN outcomes o ON o.id=t.outcome_id`
          : kind === "deliverable"
            ? tx`JOIN projects p ON p.id=t.project_id JOIN outcomes o ON o.id=p.outcome_id`
            : tx`JOIN projects p ON p.id=t.project_id JOIN outcomes o ON o.id=p.outcome_id`
      }
      JOIN areas a ON a.id=o.area_id
      WHERE t.id = ANY(${ids}) AND a.user_id=${userId} ${kind === "action" ? tx`AND t.deliverable_id IS NULL` : tx``}`;
    if (owned.length !== new Set(ids).size) throw notFound(kind, null, `A prerequisite ${kind}`);
  }
}

/** Replace-all write of one entity's extra prerequisites. */
export async function replacePrerequisites(tx: Sql, owner: PrerequisiteRef, refs: PrerequisiteRef[]): Promise<void> {
  await tx`DELETE FROM entity_prerequisites WHERE entity_kind=${owner.kind} AND entity_id=${owner.id}`;
  for (const ref of refs)
    await tx`INSERT INTO entity_prerequisites (entity_kind,entity_id,requires_kind,requires_id) VALUES (${owner.kind},${owner.id},${ref.kind},${ref.id})`;
}

/**
 * Adds edges to one entity's prerequisites and keeps the rest (an import row never removes an edge).
 * The caller has checked ownership and runs `assertNoPrerequisiteCycle` once all its writes are in.
 */
export async function addPrerequisites(tx: Sql, owner: PrerequisiteRef, refs: PrerequisiteRef[]): Promise<void> {
  for (const ref of refs)
    await tx`INSERT INTO entity_prerequisites (entity_kind,entity_id,requires_kind,requires_id) VALUES (${owner.kind},${owner.id},${ref.kind},${ref.id}) ON CONFLICT DO NOTHING`;
}

/** Drops every row naming one of these entities, in both directions. */
export async function deletePrerequisitesOf(tx: Sql, kind: PrerequisiteKind, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await tx`DELETE FROM entity_prerequisites WHERE (entity_kind=${kind} AND entity_id = ANY(${ids})) OR (requires_kind=${kind} AND requires_id = ANY(${ids}))`;
}

/** Same, for every entity currently under the given projects (whole-state replacement). */
export async function deletePrerequisitesUnderProjects(tx: Sql, projectIds: string[]): Promise<void> {
  if (!projectIds.length) return;
  await tx`DELETE FROM entity_prerequisites WHERE
    (entity_kind='project' AND entity_id = ANY(${projectIds})) OR (requires_kind='project' AND requires_id = ANY(${projectIds}))
    OR (entity_kind='deliverable' AND entity_id IN (SELECT id FROM deliverables WHERE project_id = ANY(${projectIds})))
    OR (requires_kind='deliverable' AND requires_id IN (SELECT id FROM deliverables WHERE project_id = ANY(${projectIds})))
    OR (entity_kind='action' AND entity_id IN (SELECT id FROM actions WHERE project_id = ANY(${projectIds})))
    OR (requires_kind='action' AND requires_id IN (SELECT id FROM actions WHERE project_id = ANY(${projectIds})))`;
}

/**
 * Throws when the user's combined graph, as currently written in this transaction, has a loop.
 * Called after the write so the post-write graph is exactly what is checked; the transaction rolls back.
 */
export async function assertNoPrerequisiteCycle(tx: Sql, userId: string): Promise<void> {
  const anyRows = await tx<{ one: number }[]>`SELECT 1 AS one FROM entity_prerequisites LIMIT 1`;
  if (!anyRows[0]) return;
  const owned = tx`JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE a.user_id=${userId}`;
  const projects = await tx<
    { id: string; title: string; status: string }[]
  >`SELECT p.id,p.title,p.status FROM projects p ${owned}`;
  const deliverables = await tx<{ id: string; title: string; status: string; project_id: string }[]>`
    SELECT d.id,d.title,d.status,d.project_id FROM deliverables d JOIN projects p ON p.id=d.project_id ${owned}`;
  const actions = await tx<{ id: string; title: string; status: string; project_id: string }[]>`
    SELECT ac.id,ac.title,ac.status,ac.project_id FROM actions ac JOIN projects p ON p.id=ac.project_id ${owned}`;
  const actionEdges = await tx<{ a: string; b: string }[]>`
    SELECT ad.action_id AS a, ad.depends_on_action_id AS b FROM action_dependencies ad JOIN actions ac ON ac.id=ad.action_id JOIN projects p ON p.id=ac.project_id ${owned}`;
  const deliverableEdges = await tx<{ a: string; b: string }[]>`
    SELECT dd.deliverable_id AS a, dd.depends_on_deliverable_id AS b FROM deliverable_dependencies dd JOIN deliverables d ON d.id=dd.deliverable_id JOIN projects p ON p.id=d.project_id ${owned}`;
  const extra = await tx<
    { entity_kind: PrerequisiteKind; entity_id: string; requires_kind: PrerequisiteKind; requires_id: string }[]
  >`
    SELECT ep.entity_kind,ep.entity_id,ep.requires_kind,ep.requires_id FROM entity_prerequisites ep
    WHERE (ep.entity_kind='project' AND ep.entity_id IN (SELECT p.id FROM projects p ${owned}))
       OR (ep.entity_kind='deliverable' AND ep.entity_id IN (SELECT d.id FROM deliverables d JOIN projects p ON p.id=d.project_id ${owned}))
       OR (ep.entity_kind='action' AND ep.entity_id IN (SELECT ac.id FROM actions ac JOIN projects p ON p.id=ac.project_id ${owned}))`;
  const group = (rows: { a: string; b: string }[]) => {
    const map = new Map<string, string[]>();
    for (const row of rows) map.set(row.a, [...(map.get(row.a) ?? []), row.b]);
    return map;
  };
  const actionDeps = group(actionEdges);
  const deliverableDeps = group(deliverableEdges);
  const extras = new Map<string, PrerequisiteRef[]>();
  for (const row of extra) {
    const key = `${row.entity_kind}:${row.entity_id}`;
    extras.set(key, [...(extras.get(key) ?? []), { kind: row.requires_kind, id: row.requires_id }]);
  }
  const nodes = prerequisiteNodes({
    projects: projects.map((row) => ({ ...row, prerequisites: extras.get(`project:${row.id}`) ?? [] })),
    deliverables: deliverables.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      projectId: row.project_id,
      dependencyIds: deliverableDeps.get(row.id) ?? [],
      prerequisites: extras.get(`deliverable:${row.id}`) ?? []
    })),
    actions: actions.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      projectId: row.project_id,
      dependencyIds: actionDeps.get(row.id) ?? [],
      prerequisites: extras.get(`action:${row.id}`) ?? []
    }))
  });
  const loop = firstPrerequisiteCycle(nodes);
  if (loop) {
    const title = nodes.find((node) => node.kind === loop.kind && node.id === loop.id)?.title ?? loop.id;
    throw new InvalidCommandError(`Those prerequisites would create a cycle through ${loop.kind} "${title}".`);
  }
}

/**
 * Every stored extra prerequisite of the user, keyed `kind:id` of the owner. A row whose owner or
 * target is gone (or is a deliverable step, which is not addressable) is dropped, never an error.
 */
export async function readPrerequisiteMap(sql: Sql, userId: string): Promise<Map<string, PrerequisiteRef[]>> {
  const rows = await sql<
    { entity_kind: PrerequisiteKind; entity_id: string; requires_kind: PrerequisiteKind; requires_id: string }[]
  >`
    WITH ents AS (
      SELECT 'project'::text AS kind, p.id FROM projects p JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE a.user_id=${userId}
      UNION ALL
      SELECT 'deliverable', d.id FROM deliverables d JOIN projects p ON p.id=d.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE a.user_id=${userId}
      UNION ALL
      SELECT 'action', ac.id FROM actions ac JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE a.user_id=${userId} AND ac.deliverable_id IS NULL
    )
    SELECT ep.entity_kind, ep.entity_id, ep.requires_kind, ep.requires_id FROM entity_prerequisites ep
    WHERE EXISTS (SELECT 1 FROM ents e WHERE e.kind=ep.entity_kind AND e.id=ep.entity_id)
      AND EXISTS (SELECT 1 FROM ents e WHERE e.kind=ep.requires_kind AND e.id=ep.requires_id)
    ORDER BY ep.created_at, ep.requires_kind, ep.requires_id`;
  const map = new Map<string, PrerequisiteRef[]>();
  for (const row of rows) {
    const key = `${row.entity_kind}:${row.entity_id}`;
    map.set(key, [...(map.get(key) ?? []), { kind: row.requires_kind, id: row.requires_id }]);
  }
  return map;
}
