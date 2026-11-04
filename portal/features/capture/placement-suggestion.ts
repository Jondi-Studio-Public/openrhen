import type { CaptureItem, PortalState } from "@/state/portal-state";

/**
 * The project the `capture_placement` add-on suggested for a capture, when it is `on`.
 * It sits in `proposedFields.placementSuggestion` beside the prefilled `projectId`; the editor shows it with
 * its reason so a prefilled project is never a silent one. In `shadow` nothing is written, so there is none.
 */
export interface PlacementSuggestion {
  projectId: string;
  projectTitle: string;
  reason: string;
  /** "rules" or "local model", for the line the editor shows. */
  by: "rules" | "local model";
}

export function placementSuggestion(
  item: Pick<CaptureItem, "proposedFields" | "status"> | null,
  state: Pick<PortalState, "projects">
): PlacementSuggestion | null {
  const raw = item?.proposedFields?.placementSuggestion;
  if (item?.status !== "pending" || typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const project = state.projects.find((candidate) => candidate.id === record.projectId);
  if (!project || typeof record.reason !== "string") return null;
  return {
    projectId: project.id,
    projectTitle: project.title,
    reason: record.reason,
    by: typeof record.proposer === "string" && record.proposer.startsWith("model:") ? "local model" : "rules"
  };
}
