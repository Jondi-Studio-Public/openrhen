import type { PortalState } from "@/state/portal-state";
import { projectPlanHref } from "@/features/plan/area-grouping";

/** What kind of decision an item waits on, so the Plan banner can count them by kind. */
export type PlanningAttentionKind = "next_step" | "estimate" | "stuck";

/** One place the plan cannot be believed yet, and where to go to deal with it. */
export interface PlanningAttentionItem {
  kind: PlanningAttentionKind;
  text: string;
  href: string;
}

const KIND_WORDS: Record<PlanningAttentionKind, [one: string, many: string]> = {
  next_step: ["project with no next step", "projects with no next step"],
  estimate: ["estimate to review", "estimates to review"],
  stuck: ["action blocked or waiting", "actions blocked or waiting"]
};

/** "2 projects with no next step, 1 estimate to review": the items counted by kind, in a fixed order. */
export function summariseAttention(items: PlanningAttentionItem[]): string {
  return (Object.keys(KIND_WORDS) as PlanningAttentionKind[])
    .map((kind) => {
      const count = items.filter((item) => item.kind === kind).length;
      return count ? `${count} ${KIND_WORDS[kind][count === 1 ? 0 : 1]}` : null;
    })
    .filter((part): part is string => part !== null)
    .join(", ");
}

/**
 * The plan is only as trustworthy as the information behind it, so this lists the places where the
 * plan cannot be believed yet: an active project nothing can advance, an estimate the engine has
 * flagged for review, and work that is parked waiting on something else.
 */
export function planningAttention(state: PortalState): PlanningAttentionItem[] {
  // An action sits on its project's card in Plan; one whose project is gone has only Plan to go to.
  const projectHref = (projectId: string) => {
    const project = state.projects.find((item) => item.id === projectId);
    return project ? projectPlanHref(project, state.outcomes, state.areas) : "/plan";
  };
  const deliverableHref = (id: string) => `/deliverables?deliverable=${encodeURIComponent(id)}`;
  return [
    ...state.projects
      .filter(
        (item) =>
          item.status === "active" &&
          !state.actions.some(
            (action) => action.projectId === item.id && !["done", "cancelled", "archived"].includes(action.status)
          ) &&
          !state.deliverables.some(
            (deliverable) =>
              deliverable.projectId === item.id && !["completed", "cancelled", "archived"].includes(deliverable.status)
          )
      )
      .map((item) => ({
        kind: "next_step" as const,
        text: `${item.title}: add a next action or deliverable`,
        href: projectPlanHref(item, state.outcomes, state.areas)
      })),
    ...state.actions
      .filter((item) => item.estimateNeedsReview)
      .map((item) => ({
        kind: "estimate" as const,
        text: `${item.title}: review remaining effort`,
        href: projectHref(item.projectId)
      })),
    // A deliverable step that overran its estimate is the same doubt at a finer grain: the
    // deliverable's aggregate effort, which is what the engine plans against, cannot be believed.
    ...state.deliverables.flatMap((deliverable) =>
      deliverable.steps
        .filter((step) => step.estimateNeedsReview)
        .map((step) => ({
          kind: "estimate" as const,
          text: `${deliverable.title} · ${step.title}: review remaining effort`,
          href: deliverableHref(deliverable.id)
        }))
    ),
    ...state.actions
      .filter((item) => item.status === "blocked" || item.status === "waiting")
      .map((item) => ({
        kind: "stuck" as const,
        text: `${item.title}: ${item.status === "blocked" ? "blocked" : "waiting on something"}`,
        href: projectHref(item.projectId)
      }))
  ];
}
