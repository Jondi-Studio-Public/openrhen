import { CLOSED_STATUSES } from "@openrhen/contracts";
import {
  firstPrerequisiteCycle,
  prerequisiteKey,
  prerequisiteNodes,
  unmetPrerequisites,
  type PrerequisiteKind,
  type PrerequisiteRef,
  type UnmetPrerequisite
} from "@openrhen/contracts";
import type { StoredAction, StoredDeliverable, StoredProject } from "@/state/portal-state";

/**
 * One Prerequisites picker per editor: the person
 * chooses among every other project, deliverable and action, and the choice is written back split the
 * way the wire keeps it. Same-kind action-to-action and deliverable-to-deliverable edges stay in
 * `dependencyIds`; every other edge is a `prerequisites` ref.
 */
export type PrerequisitePlan = {
  projects: StoredProject[];
  deliverables: StoredDeliverable[];
  actions: StoredAction[];
};

export type PrerequisiteSelf = { kind: PrerequisiteKind; id?: string | undefined; projectId?: string | undefined };

export interface PrerequisiteSplit {
  dependencyIds: string[];
  prerequisites: PrerequisiteRef[];
}

/** The editor's two stored lists read as one selection. */
export function unifiedPrerequisites(kind: PrerequisiteKind, split: PrerequisiteSplit): PrerequisiteRef[] {
  return [...split.dependencyIds.map((id): PrerequisiteRef => ({ kind, id })), ...split.prerequisites];
}

/** A selection written back as the wire keeps it: same kind to `dependencyIds`, the rest to `prerequisites`. */
export function splitPrerequisites(kind: PrerequisiteKind, selection: PrerequisiteRef[]): PrerequisiteSplit {
  const seen = new Set<string>();
  const unique = selection.filter((ref) => {
    const key = prerequisiteKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // A project keeps no `dependencyIds`: a project that needs another project is a plain prerequisite.
  if (kind === "project") return { dependencyIds: [], prerequisites: unique };
  return {
    dependencyIds: unique.filter((ref) => ref.kind === kind).map((ref) => ref.id),
    prerequisites: unique.filter((ref) => ref.kind !== kind)
  };
}

export function toggleSelection(
  selection: PrerequisiteRef[],
  ref: PrerequisiteRef,
  checked: boolean
): PrerequisiteRef[] {
  const key = prerequisiteKey(ref);
  const rest = selection.filter((item) => prerequisiteKey(item) !== key);
  return checked ? [...rest, ref] : rest;
}

export interface PrerequisiteGroup {
  kind: PrerequisiteKind;
  label: string;
  options: { ref: PrerequisiteRef; title: string }[];
}

/**
 * Every other project, deliverable and action, grouped by kind. Cancelled or archived work is left
 * out unless it is already chosen, so an existing edge can still be seen and removed.
 */
export function prerequisiteGroups(
  plan: PrerequisitePlan,
  self: PrerequisiteSelf,
  selected: PrerequisiteRef[] = []
): PrerequisiteGroup[] {
  const chosen = new Set(selected.map(prerequisiteKey));
  const keep = (kind: PrerequisiteKind, id: string, status: string) =>
    !(kind === self.kind && id === self.id) &&
    (!CLOSED_STATUSES.has(status) || chosen.has(prerequisiteKey({ kind, id })));
  const groups: PrerequisiteGroup[] = [
    {
      kind: "project",
      label: "Projects",
      options: plan.projects
        .filter((item) => keep("project", item.id, item.status))
        .map((item) => ({ ref: { kind: "project", id: item.id }, title: item.title }))
    },
    {
      kind: "deliverable",
      label: "Deliverables",
      options: plan.deliverables
        .filter((item) => keep("deliverable", item.id, item.status))
        .map((item) => ({ ref: { kind: "deliverable", id: item.id }, title: item.title }))
    },
    {
      kind: "action",
      label: "Actions",
      options: plan.actions
        .filter((item) => keep("action", item.id, item.status))
        .map((item) => ({ ref: { kind: "action", id: item.id }, title: item.title }))
    }
  ];
  return groups.filter((group) => group.options.length > 0);
}

const NEW_ID = "__new__";

/**
 * Refuses a choice that cannot hold: an action or deliverable naming its own kind in `prerequisites`,
 * a child naming its own project, or any loop. Returns the message to show inline, or null.
 */
export function validatePrerequisiteChoice(
  self: PrerequisiteSelf,
  split: PrerequisiteSplit,
  plan: PrerequisitePlan
): string | null {
  const edges = unifiedPrerequisites(self.kind, split);
  if (!edges.length) return null;
  if (self.kind !== "project" && split.prerequisites.some((ref) => ref.kind === self.kind))
    return `A ${self.kind} lists other ${self.kind}s as dependencies, not prerequisites.`;
  if (self.id && edges.some((ref) => ref.kind === self.kind && ref.id === self.id))
    return `A ${self.kind} cannot depend on itself.`;
  if (self.projectId && edges.some((ref) => ref.kind === "project" && ref.id === self.projectId))
    return `A ${self.kind} cannot depend on its own project.`;
  const id = self.id || NEW_ID;
  const base = {
    projects: plan.projects.map((item) => ({ ...item })),
    deliverables: plan.deliverables.map((item) => ({ ...item })),
    actions: plan.actions.map((item) => ({ ...item }))
  };
  const withEdges = <T extends { id: string; dependencyIds: string[]; prerequisites?: PrerequisiteRef[] | undefined }>(
    items: T[],
    extra: () => T
  ): T[] => {
    const found = items.some((item) => item.id === id);
    const list = found ? items : [...items, extra()];
    return list.map((item) =>
      item.id === id ? { ...item, dependencyIds: split.dependencyIds, prerequisites: split.prerequisites } : item
    );
  };
  const projectId = self.projectId ?? "";
  const nodes = prerequisiteNodes({
    projects:
      self.kind === "project"
        ? (base.projects.some((item) => item.id === id)
            ? base.projects
            : [...base.projects, { id, title: "", status: "active" } as StoredProject]
          ).map((item) => (item.id === id ? { ...item, prerequisites: split.prerequisites } : item))
        : base.projects,
    deliverables:
      self.kind === "deliverable"
        ? withEdges(base.deliverables, () => ({ id, title: "", projectId, status: "ready" }) as StoredDeliverable)
        : base.deliverables,
    actions:
      self.kind === "action"
        ? withEdges(base.actions, () => ({ id, title: "", projectId, status: "active" }) as StoredAction)
        : base.actions
  });
  // A loop already in the plan is not this edit's doing, and must not stop an unrelated save.
  if (firstPrerequisiteCycle(prerequisiteNodes(plan))) return null;
  return firstPrerequisiteCycle(nodes) ? "Those prerequisites would create a cycle." : null;
}

/** The map of what each project, deliverable and action is still waiting on, keyed `kind:id`. */
export function waitingOnMap(plan: PrerequisitePlan): Map<string, UnmetPrerequisite[]> {
  return unmetPrerequisites(prerequisiteNodes(plan));
}

export function waitingOn(
  map: Map<string, UnmetPrerequisite[]>,
  kind: PrerequisiteKind,
  id: string
): UnmetPrerequisite[] {
  return map.get(prerequisiteKey({ kind, id })) ?? [];
}

/** "waiting on A, B" for a card; empty when nothing is in the way. */
export function waitingText(unmet: UnmetPrerequisite[]): string {
  return unmet.length ? `waiting on ${unmet.map((ref) => ref.title).join(", ")}` : "";
}
