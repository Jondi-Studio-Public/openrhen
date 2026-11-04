import { z } from "zod";

/**
 * Prerequisites across every kind of planned work.
 *
 * Action to action and deliverable to deliverable edges keep their own `dependencyIds` and tables.
 * Every other edge, including any edge from or to a project, is an `ExtraPrerequisite` carried in
 * `prerequisites`. This module reads both as one graph and owns the two questions the rest of the
 * system asks of it: what is still in the way of an entity, and does a proposed set of edges loop.
 *
 * A prerequisite is satisfied only when it is finished: an action `done`, a deliverable `completed`,
 * a project `done`. A cancelled or archived prerequisite never satisfies, the same as an action today.
 *
 * A parent's prerequisites also hold its children (a deliverable or action waits on its project's
 * prerequisites; an action in a deliverable waits on the deliverable's), because the parent cannot
 * start while something it needs is unfinished.
 */
export const prerequisiteKindSchema = z.enum(["project", "deliverable", "action"]);
export type PrerequisiteKind = z.infer<typeof prerequisiteKindSchema>;

export const prerequisiteRefSchema = z.object({ kind: prerequisiteKindSchema, id: z.string().min(1) });
export type PrerequisiteRef = z.infer<typeof prerequisiteRefSchema>;

export interface PrerequisiteNode {
  kind: PrerequisiteKind;
  id: string;
  title: string;
  /** Finished in the sense this module's header defines. */
  complete: boolean;
  /** The project this sits in, for a deliverable or action. */
  projectId?: string | undefined;
  /** Same-kind edges that live in `dependencyIds` (actions and deliverables). */
  dependencyIds: string[];
  /** Every other edge. */
  prerequisites: PrerequisiteRef[];
}

export interface UnmetPrerequisite extends PrerequisiteRef {
  title: string;
}

export const prerequisiteKey = (ref: PrerequisiteRef): string => `${ref.kind}:${ref.id}`;

/** Flattens a plan state into nodes. Deliverable steps are not nodes: they inherit through their deliverable. */
export function prerequisiteNodes(state: {
  projects: { id: string; title: string; status: string; prerequisites?: PrerequisiteRef[] | undefined }[];
  deliverables: {
    id: string;
    title: string;
    projectId: string;
    status: string;
    dependencyIds: string[];
    prerequisites?: PrerequisiteRef[] | undefined;
  }[];
  actions: {
    id: string;
    title: string;
    projectId: string;
    status: string;
    dependencyIds: string[];
    prerequisites?: PrerequisiteRef[] | undefined;
  }[];
}): PrerequisiteNode[] {
  return [
    ...state.projects.map((project): PrerequisiteNode => ({
      kind: "project",
      id: project.id,
      title: project.title,
      complete: project.status === "done",
      dependencyIds: [],
      prerequisites: project.prerequisites ?? []
    })),
    ...state.deliverables.map((deliverable): PrerequisiteNode => ({
      kind: "deliverable",
      id: deliverable.id,
      title: deliverable.title,
      complete: deliverable.status === "completed",
      projectId: deliverable.projectId,
      dependencyIds: deliverable.dependencyIds,
      prerequisites: deliverable.prerequisites ?? []
    })),
    ...state.actions.map((action): PrerequisiteNode => ({
      kind: "action",
      id: action.id,
      title: action.title,
      complete: action.status === "done",
      projectId: action.projectId,
      dependencyIds: action.dependencyIds,
      prerequisites: action.prerequisites ?? []
    }))
  ];
}

function ownEdges(node: PrerequisiteNode): PrerequisiteRef[] {
  return [...node.dependencyIds.map((id): PrerequisiteRef => ({ kind: node.kind, id })), ...node.prerequisites];
}

/**
 * For every node, the prerequisites still unfinished, its own plus its project's. A reference to a
 * node that is not in the state cannot be proven finished, so it counts as unmet and is named by id.
 * Nodes with nothing in the way are absent from the result.
 */
export function unmetPrerequisites(nodes: PrerequisiteNode[]): Map<string, UnmetPrerequisite[]> {
  const byKey = new Map(nodes.map((node) => [prerequisiteKey(node), node]));
  const unmetOwn = (node: PrerequisiteNode): UnmetPrerequisite[] =>
    ownEdges(node).flatMap((ref): UnmetPrerequisite[] => {
      const target = byKey.get(prerequisiteKey(ref));
      if (target?.complete) return [];
      return [{ ...ref, title: target?.title ?? ref.id }];
    });
  const result = new Map<string, UnmetPrerequisite[]>();
  for (const node of nodes) {
    const parent = node.projectId ? byKey.get(prerequisiteKey({ kind: "project", id: node.projectId })) : undefined;
    const seen = new Set<string>();
    const unmet = [...unmetOwn(node), ...(parent ? unmetOwn(parent) : [])].filter((ref) => {
      const key = prerequisiteKey(ref);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unmet.length) result.set(prerequisiteKey(node), unmet);
  }
  return result;
}

/**
 * Names one entity on a loop, or null when there is none. A project's prerequisite is also its
 * children's, so the walk treats a child as waiting on its project: a project that needs its own
 * deliverable, or a deliverable that needs its own project, is the same deadlock as any other loop.
 */
export function firstPrerequisiteCycle(nodes: PrerequisiteNode[]): PrerequisiteRef | null {
  const byKey = new Map(nodes.map((node) => [prerequisiteKey(node), node]));
  const childrenOf = new Map<string, PrerequisiteRef[]>();
  for (const node of nodes)
    if (node.projectId)
      childrenOf.set(node.projectId, [...(childrenOf.get(node.projectId) ?? []), { kind: node.kind, id: node.id }]);
  // Waiting on a project means waiting for its work to finish, so for this walk a project reference
  // also reaches the project's own deliverables and actions (never for `unmetPrerequisites`).
  const next = (node: PrerequisiteNode): PrerequisiteRef[] => [
    ...ownEdges(node).flatMap((ref) => (ref.kind === "project" ? [ref, ...(childrenOf.get(ref.id) ?? [])] : [ref])),
    ...(node.projectId ? [{ kind: "project" as const, id: node.projectId }] : [])
  ];
  // Waiting on your own project is a loop the child-to-project edge above cannot show, because the
  // project only finishes after its children do.
  for (const node of nodes)
    if (node.projectId && node.prerequisites.some((ref) => ref.kind === "project" && ref.id === node.projectId))
      return { kind: node.kind, id: node.id };
  const visited = new Map<string, "visiting" | "done">();
  const walk = (key: string): PrerequisiteRef | null => {
    const node = byKey.get(key);
    if (!node) return null;
    const seen = visited.get(key);
    if (seen === "done") return null;
    if (seen === "visiting") return { kind: node.kind, id: node.id };
    visited.set(key, "visiting");
    for (const ref of next(node).sort((a, b) => prerequisiteKey(a).localeCompare(prerequisiteKey(b)))) {
      const found = walk(prerequisiteKey(ref));
      if (found) return found;
    }
    visited.set(key, "done");
    return null;
  };
  for (const key of [...byKey.keys()].sort()) {
    const found = walk(key);
    if (found) return found;
  }
  return null;
}

/** The sentence an exclusion or block reason uses, naming what is in the way. */
export function unmetPrerequisiteReason(title: string, unmet: UnmetPrerequisite[]): string {
  const names = unmet.map((ref) => `${ref.kind === "project" ? "project " : ""}${ref.title}`);
  return names.length === 1
    ? `${title} is waiting on ${names[0]}.`
    : `${title} is waiting on ${names.length} prerequisites: ${names.join(", ")}.`;
}
