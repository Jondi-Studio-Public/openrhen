"use client";

import { EvidenceDetails } from "./evidence-details";

/** No work fits, but protected recovery capacity is open, so rest is the deliberate recommendation. */
export function RecoveryPanel({
  recommendedMinutes,
  explanation,
  evidence
}: {
  recommendedMinutes: number;
  explanation: string;
  evidence: readonly string[];
}) {
  return (
    <>
      <p className="time">For {recommendedMinutes} minutes · protected recovery</p>
      <p className="reason">No work fits this window, but recovery capacity is open. {explanation}</p>
      <p className="microcopy">
        Recovery capacity is never converted into work capacity. Change your energy or contexts above if that is no
        longer accurate.
      </p>
      {evidence.length > 0 && <EvidenceDetails summary="Why nothing else fits" evidence={evidence} />}
    </>
  );
}
