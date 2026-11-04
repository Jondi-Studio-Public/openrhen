"use client";

import type { StoredDeliverable } from "@/state/portal-state";
import {
  CLOSED_DELIVERABLE_STATUSES,
  label,
  phaseLabel,
  type Phase,
  type WorkspaceMode
} from "@/features/deliverables/deliverable-model";

/**
 * Where the deliverable is up to, and whether this page can change it. The three-stage strip is the same in
 * both modes; only the badge differs — a session reports its save state, a view says it is read-only.
 */
export function WorkspaceHeader({
  deliverable,
  projectTitle,
  phase,
  mode,
  currentStepTitle,
  dirty,
  onBack
}: {
  deliverable: StoredDeliverable;
  projectTitle: string | undefined;
  phase: Phase;
  mode: WorkspaceMode;
  currentStepTitle: string | undefined;
  dirty: boolean;
  onBack: () => void;
}) {
  // A closed deliverable is past its phases: the strip reads as finished, not stuck in the doing stage.
  const closed = CLOSED_DELIVERABLE_STATUSES.has(deliverable.status);
  const done = deliverable.status === "completed";
  const subtitle = closed
    ? done
      ? "Everything on the contract is satisfied. This record is closed."
      : "This deliverable is closed; the record is read-only."
    : (currentStepTitle ??
      (phase === "Breakdown"
        ? "Define what done means and make the work resumable"
        : phase === "Review"
          ? "Check the evidence against the completion contract"
          : "Choose the next useful action"));
  return (
    <div className="deliverable-workspace-topbar">
      <header className="deliverable-workspace-header">
        {/* The project is the unit this work belongs to — without it an "Exercise G" is adrift. */}
        <p className="eyebrow">
          {projectTitle ? `${projectTitle.toUpperCase()} · ` : ""}
          {closed ? label(deliverable.status).toUpperCase() : phaseLabel(phase).toUpperCase()}
          {!closed && mode === "view" ? " · READ-ONLY VIEW" : ""}
        </p>
        <h1>{deliverable.title}</h1>
        <p>{!closed && mode === "session" && currentStepTitle ? `Current action: ${currentStepTitle}` : subtitle}</p>
      </header>
      <div className="actions flush workspace-topbar-meta">
        <div className="workspace-save-state">
          {closed ? label(deliverable.status) : mode === "view" ? "Read-only" : dirty ? "Unsaved changes" : "Saved"}
        </div>
        <button type="button" className="quiet small" onClick={onBack}>
          All deliverables
        </button>
        <div className="bcr-strip" aria-label="Stage progress">
          <span className={done || phase !== "Breakdown" ? "done" : "active"}>
            1 <small>Breakdown</small>
          </span>
          <span className={done ? "done" : phase === "Carry out" ? "active" : phase === "Review" ? "done" : ""}>
            2 <small>Do the work</small>
          </span>
          <span className={done ? "done" : phase === "Review" ? "active" : ""}>
            3 <small>Review</small>
          </span>
        </div>
      </div>
    </div>
  );
}
