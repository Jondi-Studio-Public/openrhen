"use client";

import type { DeliverableReadiness } from "@openrhen/contracts";
import type { StoredDeliverable } from "@/state/portal-state";
import type { Phase } from "@/features/deliverables/deliverable-model";

/**
 * The phase transitions and the save. Approve stays disabled while coverage fails, and the failures
 * themselves are named in the readiness panel so the person knows what to fix. Only rendered inside
 * a session: the read-only view changes nothing.
 */
export function WorkspaceActions({
  deliverable,
  readiness,
  phase,
  dirty,
  saving,
  onSave,
  onApprove,
  onBeginReview,
  onMarkComplete
}: {
  deliverable: StoredDeliverable;
  readiness: DeliverableReadiness;
  phase: Phase;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onApprove: () => void;
  onBeginReview: () => void;
  onMarkComplete: () => void;
}) {
  const requiredOpen = deliverable.steps.some((step) => step.required && !["done", "cancelled"].includes(step.status));
  return (
    <footer className="workspace-actions">
      <button type="button" onClick={onSave} disabled={!dirty || saving}>
        Save changes
      </button>
      {phase === "Breakdown" && (
        <button
          type="button"
          className="quiet"
          onClick={onApprove}
          disabled={dirty || saving || readiness.coverageFailures.length > 0 || !deliverable.criteria.length}
          title={
            readiness.coverageFailures.length
              ? "Fix the coverage problems named under Readiness first."
              : dirty
                ? "Save your changes first."
                : undefined
          }
        >
          Approve breakdown and start the work
        </button>
      )}
      {phase === "Carry out" && (
        <button type="button" className="quiet" disabled={requiredOpen || saving} onClick={onBeginReview}>
          Begin Review
        </button>
      )}
      {phase === "Review" && (
        <button
          type="button"
          className="quiet"
          disabled={!readiness.contractSatisfied || saving}
          onClick={onMarkComplete}
        >
          Mark deliverable complete
        </button>
      )}
    </footer>
  );
}
