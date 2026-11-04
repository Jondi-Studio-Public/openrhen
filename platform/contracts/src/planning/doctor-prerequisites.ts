import { CLOSED_STATUSES } from "../closed-status.js";
/**
 * The doctor's prerequisites-and-blockers checks: pure and deterministic over a
 * plain slice. The rules are the owners' own: `unmetPrerequisites` and `firstPrerequisiteCycle` for what is
 * in the way, and the plan-health `blocker_no_person` and `empty_assessment` checks for the other two, so an
 * item never claims more than the finding it overlaps and carries the finding's handle. Titles are plan data,
 * never instructions.
 */
import type { DoctorItem } from "./doctor.js";
import { runPlanHealthChecks, type HealthSnapshot } from "./plan-health.js";
import {
  firstPrerequisiteCycle,
  prerequisiteKey,
  prerequisiteNodes,
  unmetPrerequisites,
  type PrerequisiteRef
} from "./prerequisites.js";

export interface DoctorPrerequisitesSlice {
  /** Projects of any status: a prerequisite on a finished project is met. Items are made for active ones only. */
  projects: { id: string; title: string; status: string; prerequisites: PrerequisiteRef[] }[];
  deliverables: {
    id: string;
    projectId: string;
    title: string;
    status: string;
    createdAt: string | null;
    dependencyIds: string[];
    prerequisites: PrerequisiteRef[];
    actionCount: number;
    criterionCount: number;
  }[];
  /** Actions that sit directly under a project (a deliverable's steps inherit through the deliverable). */
  actions: {
    id: string;
    projectId: string;
    title: string;
    status: string;
    dependencyIds: string[];
    prerequisites: PrerequisiteRef[];
  }[];
  blockers: {
    id: string;
    deliverableId: string;
    description: string;
    category: string;
    state: string;
    createdAt: string | null;
  }[];
  /** `<type>:<id>` of the plan items with a confirmed `involves` link to a contact. */
  contactLinkedHandles: string[];
}

const FINISHED_ACTION = new Set(["done", ...CLOSED_STATUSES]);
const FINISHED_DELIVERABLE = new Set(["completed", ...CLOSED_STATUSES]);

const iso = (value: string | null): { since: string } | Record<string, never> => {
  const t = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(t) ? {} : { since: new Date(t).toISOString() };
};

function names(refs: { kind: string; title: string }[]): string {
  const shown = refs.slice(0, 3).map((ref) => `${ref.kind === "project" ? "project " : ""}${ref.title}`);
  return refs.length > 3 ? `${shown.join(", ")} and ${refs.length - 3} more` : shown.join(", ");
}

export function prerequisiteItems(slice: DoctorPrerequisitesSlice, nowMs: number): DoctorItem[] {
  const items: DoctorItem[] = [];
  const activeProjects = new Map(slice.projects.filter((p) => p.status === "active").map((p) => [p.id, p]));

  // Unmet prerequisites. A project's own list is reported once, on the project; its children are named only
  // for what they add, so one unfinished project prerequisite is not repeated on every action under it.
  const nodes = prerequisiteNodes({
    projects: slice.projects,
    deliverables: slice.deliverables,
    actions: slice.actions
  });
  const unmet = unmetPrerequisites(nodes);
  const report = (
    kind: "project" | "deliverable" | "action",
    id: string,
    title: string,
    projectId: string | null,
    open: boolean
  ) => {
    if (!open) return;
    const own = unmet.get(prerequisiteKey({ kind, id }));
    if (!own?.length) return;
    const inherited = projectId
      ? new Set((unmet.get(prerequisiteKey({ kind: "project", id: projectId })) ?? []).map(prerequisiteKey))
      : new Set<string>();
    const mine = kind === "project" ? own : own.filter((ref) => !inherited.has(prerequisiteKey(ref)));
    if (!mine.length) return;
    items.push({
      id: `unmet_prerequisite:${kind}:${id}`,
      check: "unmet_prerequisite",
      tier: "degrading",
      area: "plan",
      title: `${title} is waiting on ${names(mine)}`,
      why: "The engine holds it back until those are finished, so it is never offered and the plan under-uses its time.",
      handles: [`${kind}:${id}`],
      fix: {
        who: "person",
        question: `${title} is waiting on ${names(mine)}. Is it still needed first, or should the prerequisite be removed?`
      }
    });
  };
  for (const p of activeProjects.values()) report("project", p.id, p.title, null, true);
  for (const d of slice.deliverables)
    report(
      "deliverable",
      d.id,
      d.title,
      d.projectId,
      activeProjects.has(d.projectId) && !FINISHED_DELIVERABLE.has(d.status)
    );
  for (const a of slice.actions)
    report("action", a.id, a.title, a.projectId, activeProjects.has(a.projectId) && !FINISHED_ACTION.has(a.status));

  // A loop never clears by finishing anything, so it is its own item.
  const loop = firstPrerequisiteCycle(nodes);
  if (loop) {
    const node = nodes.find((n) => n.kind === loop.kind && n.id === loop.id);
    const active =
      node?.kind === "project" ? activeProjects.has(node.id) : !!node?.projectId && activeProjects.has(node.projectId);
    if (node && active)
      items.push({
        id: `prerequisite_cycle:${loop.kind}:${loop.id}`,
        check: "prerequisite_cycle",
        tier: "degrading",
        area: "plan",
        title: `${node.title} waits on itself through a loop of prerequisites`,
        why: "Nothing in the loop can ever start, so all of it is held back for good.",
        handles: [`${loop.kind}:${loop.id}`],
        fix: {
          who: "person",
          question: `${node.title} is part of a loop of prerequisites. Which one should not wait on the other?`
        }
      });
  }

  // Blockers with no contact, and empty deliverables: the plan-health rules, run over the slice, so a doctor
  // item exists exactly when the finding would.
  const inActive = slice.deliverables.filter((d) => activeProjects.has(d.projectId));
  const toDate = (value: string | null): Date | null =>
    value && !Number.isNaN(Date.parse(value)) ? new Date(value) : null;
  const snapshot: HealthSnapshot = {
    now: new Date(nowMs),
    projects: [...activeProjects.values()].map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      externalDeadlineAt: null
    })),
    deliverables: inActive.map((d) => ({
      id: d.id,
      projectId: d.projectId,
      title: d.title,
      status: d.status,
      externalDeadlineAt: null,
      actionCount: d.actionCount,
      criterionCount: d.criterionCount
    })),
    actions: [],
    blockers: slice.blockers.map((b) => ({
      id: b.id,
      deliverableId: b.deliverableId,
      description: b.description,
      category: b.category,
      state: b.state
    })),
    commitments: [],
    emails: [],
    proposals: [],
    links: slice.contactLinkedHandles.flatMap((handle) => {
      const [fromType = "", ...rest] = handle.split(":");
      return [
        { fromType, fromId: rest.join(":"), toType: "contact", toId: "-", kind: "involves", status: "confirmed" }
      ];
    }),
    subjects: []
  };
  const deliverableById = new Map(inActive.map((d) => [d.id, d]));
  const seen = new Set<string>();
  for (const finding of runPlanHealthChecks(snapshot)) {
    const handle = finding.itemIds[0];
    const deliverable = handle?.startsWith("deliverable:")
      ? deliverableById.get(handle.slice("deliverable:".length))
      : undefined;
    if (!handle || !deliverable) continue;
    if (finding.checkName === "blocker_no_person") {
      if (seen.has(`b:${handle}`)) continue;
      seen.add(`b:${handle}`);
      const since = slice.blockers
        .filter((b) => b.deliverableId === deliverable.id && b.category === "waiting_on_someone")
        .map((b) => toDate(b.createdAt)?.getTime())
        .filter((t): t is number => t !== undefined)
        .sort((a, b) => a - b)[0];
      items.push({
        id: `blocker_no_person:${handle}`,
        check: "blocker_no_person",
        tier: "degrading",
        area: "plan",
        title: `${deliverable.title} is waiting on someone, but no contact is attached`,
        why: "Nobody can be chased or reminded, so the wait has no end the engine can see.",
        handles: [handle],
        ...(since !== undefined ? { since: new Date(since).toISOString() } : {}),
        fix: { who: "person", question: `Who is ${deliverable.title} waiting on?` }
      });
    } else if (finding.checkName === "empty_assessment") {
      items.push({
        id: `empty_assessment:${handle}`,
        check: "empty_assessment",
        tier: "degrading",
        area: "plan",
        title: `${deliverable.title} has no steps and no completion criteria`,
        why: "The engine cannot tell what finishing it needs or how long it will take, so it estimates nothing.",
        handles: [handle],
        ...iso(deliverable.createdAt),
        fix: { who: "person", question: `What are the steps, or how will you know ${deliverable.title} is done?` }
      });
    }
  }
  return items;
}
