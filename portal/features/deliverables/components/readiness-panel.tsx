"use client";

import type { DeliverableReadiness } from "@openrhen/contracts";
import type { StoredDeliverable } from "@/state/portal-state";
import { coverageFailureText, phaseOf } from "@/features/deliverables/deliverable-model";
import { localiseIsoText } from "@/shared/date-format";

/** The planner's view of one deliverable, read from the current recommendation's candidate list. */
export interface EngineOpinion {
  rank: number;
  totalScore: number;
  eligible: boolean;
  exclusionReasons: string[];
  recommendedMinutes: number | null;
  recommended: boolean;
}

/**
 * The planner's line about one deliverable, in plain words: whether it is being recommended now, or
 * why not. The rank and score stay out of it, because a number with no scale tells the person nothing.
 */
export function plannerOpinionText(engine: EngineOpinion | null | undefined, timezone?: string): string {
  if (engine === undefined) return "Not looked at by the planner yet.";
  if (engine === null) return "Not in the current plan.";
  if (engine.recommended) {
    return engine.recommendedMinutes === null
      ? "Recommended now."
      : `Recommended now, for ${engine.recommendedMinutes} min.`;
  }
  if (engine.eligible) return "Could be worked on now, but other work comes first.";
  const reasons = engine.exclusionReasons.join("; ") || "no reason given";
  return `Can't be worked on now: ${(timezone ? localiseIsoText(reasons, timezone) : reasons).replace(/\.$/, "")}.`;
}

/**
 * What the shared readiness assessment and the engine say about this deliverable, in words. The
 * coverage failures are the same records that block approval, named here rather than only greying
 * the button; the engine line explains why the deliverable is or is not being recommended.
 */
export function ReadinessPanel({
  deliverable,
  readiness,
  engine,
  timezone
}: {
  deliverable: StoredDeliverable;
  readiness: DeliverableReadiness;
  engine: EngineOpinion | null | undefined;
  /** Reads the instants inside the planner's reasons in this zone; without it they stay as written. */
  timezone?: string;
}) {
  const phase = phaseOf(deliverable);
  const executable = readiness.executableStepIds.length;
  return (
    <section aria-label="Readiness">
      <div className="section-heading">
        <h2>Readiness</h2>
        <span>{readiness.approved ? "Approved" : "Unapproved"}</span>
      </div>
      {readiness.coverageFailures.length > 0 && (
        <div role="alert" className="error workspace-coverage-alert">
          <strong>Approval is blocked until these are fixed:</strong>
          <ul className="workspace-note-list">
            {readiness.coverageFailures.map((failure, index) => (
              <li key={index}>{coverageFailureText(failure)}</li>
            ))}
          </ul>
        </div>
      )}
      {readiness.coverageFailures.length === 0 && phase === "Breakdown" && (
        <p className="microcopy">
          {deliverable.criteria.length && deliverable.steps.length
            ? "Every required criterion has an action and every required action serves a criterion. The breakdown can be approved."
            : "Add at least one criterion and one action, then approve the breakdown."}
        </p>
      )}
      <p className="microcopy">
        {readiness.remainingMinutes === null
          ? "Remaining effort is unknown until the breakdown is approved."
          : `${readiness.remainingMinutes} minutes remaining across the deliverable.`}{" "}
        {executable
          ? `${executable} action${executable === 1 ? "" : "s"} can be worked on now.`
          : readiness.stalled
            ? "Stalled: required work remains but no action can be worked on now."
            : deliverable.steps.length
              ? "No action can be worked on now."
              : ""}
        {readiness.openBlockerIds.length
          ? ` ${readiness.openBlockerIds.length} open blocker${readiness.openBlockerIds.length === 1 ? "" : "s"}.`
          : ""}
        {readiness.contractSatisfied ? " Every required criterion is satisfied." : ""}
      </p>
      <p className="microcopy" data-testid="engine-opinion">
        {plannerOpinionText(engine, timezone)}
      </p>
    </section>
  );
}
