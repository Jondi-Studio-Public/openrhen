import type { PortalState } from "@/state/portal-state";

type SessionSourceState = Pick<PortalState, "actions" | "projects" | "deliverables">;

/**
 * The line under a History card's title naming where the session's time came from. A deliverable
 * session carries its deliverable's id where an action session carries its action's, and a commitment
 * session carries the commitment's, so looking every one of them up as an action (as the page once
 * did) named the project of a reconciled deliverable session, the one a person most often ends on
 * an earlier day, "Project unavailable".
 */
export function sessionSource(session: PortalState["completedToday"][number], state: SessionSourceState): string {
  switch (session.targetType) {
    case "sleep":
      return "Protected sleep";
    case "routine_instance":
      return "Routine checklist";
    case "routine_step":
      return "Commitment preparation";
    case "fixed_commitment":
      return "Commitment";
    case "deliverable": {
      const deliverable = state.deliverables.find((item) => item.id === session.actionId);
      return state.projects.find((item) => item.id === deliverable?.projectId)?.title ?? "Deliverable";
    }
    default: {
      const action = state.actions.find((item) => item.id === session.actionId);
      return state.projects.find((item) => item.id === action?.projectId)?.title ?? "Project unavailable";
    }
  }
}
