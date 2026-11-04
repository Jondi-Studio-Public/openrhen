"use client";

import { EvidenceDetails } from "./evidence-details";

/**
 * Nothing is available and no recovery capacity is open either; the evidence says why. The pointer
 * to Capture and Plan is only right when the engine actually said the work itself is the problem
 * (`none`); an unrecognised or missing directive is reported as it stands rather than blamed on the
 * plan.
 */
export function NothingFitsPanel({
  explanation,
  evidence,
  workIsTheProblem = true
}: {
  explanation: string;
  evidence: readonly string[];
  /** True only for the engine's own `none` directive. */
  workIsTheProblem?: boolean;
}) {
  return (
    <>
      <p className="reason">
        {explanation}
        {workIsTheProblem ? " Add or adjust work in Capture and Plan." : ""}
      </p>
      {evidence.length > 0 && <EvidenceDetails summary="Why nothing fits" evidence={evidence} />}
    </>
  );
}
