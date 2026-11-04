"use client";

import type { StoredCommitment, StoredCommitmentRecurrenceRule } from "@/state/portal-state";
import { describeCadence } from "@/features/commitments/commitment-routine";

/**
 * The series this occurrence belongs to. Two occurrences of the same rule are otherwise
 * indistinguishable, so the local date is stated as the thing that tells them apart, and editing is
 * offered against the rule — which is the record that actually decides when the rest of them run.
 */
export function CommitmentRecurrencePanel({
  commitment,
  rule,
  onEditSeries
}: {
  commitment: StoredCommitment;
  rule: StoredCommitmentRecurrenceRule | undefined;
  onEditSeries: () => void;
}) {
  return (
    <section className="commitment-section" aria-labelledby="commitment-recurrence-heading">
      <div className="section-heading">
        <h2 id="commitment-recurrence-heading">Recurrence</h2>
      </div>
      {rule ? (
        <>
          <p>
            <strong>{rule.title}</strong> · {describeCadence(rule.repeat, rule.startDate)} · {rule.localStartTime}–
            {rule.localEndTime} {rule.timezone}
          </p>
          <p className="microcopy">
            This is the occurrence on {commitment.localDate ?? "an unrecorded date"}. The series runs from{" "}
            {rule.startDate}
            {rule.endDate ? ` to ${rule.endDate}` : " with no end date"} and is {rule.status}.
          </p>
          <div className="row-actions">
            <button type="button" className="quiet small" onClick={onEditSeries}>
              Edit the series
            </button>
          </div>
        </>
      ) : (
        <p className="empty">
          {commitment.recurrenceRuleId
            ? "This occurrence names a series that is no longer loaded."
            : "A one-off commitment. It repeats nothing and nothing repeats it."}
        </p>
      )}
    </section>
  );
}
