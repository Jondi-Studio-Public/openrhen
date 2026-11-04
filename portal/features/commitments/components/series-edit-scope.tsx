"use client";

import type { StoredCommitment } from "@/state/portal-state";

/**
 * What a series edit can silently step on, shared by the commitment page's series editor and
 * Schedule's rule editor (the commitment timeline design note, "Warning on a series edit" and "Series
 * edit reaching an occurrence in progress"). Both editors hold the same `state.commitments` the page
 * already loaded and the same `occurrence_in_progress` refusal shape, so the counting and the question
 * live once here rather than drifting between the two forms.
 */

/**
 * How many of the rule's occurrences, on or after `now`, carry their own per-date changes and so
 * would not follow a series edit. Counted from the state the page already holds — no extra fetch.
 */
export function futureCustomOccurrenceCount(commitments: StoredCommitment[], ruleId: string, now: Date): number {
  const cutoff = now.getTime();
  return commitments.filter(
    (item) =>
      item.recurrenceRuleId === ruleId &&
      item.scheduleSource === "custom" &&
      new Date(item.startsAt).getTime() >= cutoff
  ).length;
}

/**
 * "N dates have their own changes and won't follow this edit" — shown before a series save so an
 * override is not invisibly missed. Nothing shown for a count of zero; singular wording for one.
 */
export function PerDateChangesWarning({ count }: { count: number }) {
  if (!count) return null;
  return (
    <p className="form-warning">
      {count === 1
        ? "1 date has its own changes and won't follow this edit."
        : `${count} dates have their own changes and won't follow this edit.`}
    </p>
  );
}

/**
 * The question a series save's `occurrence_in_progress` refusal raises: whether the occurrence
 * currently under way should be changed too. Answering resubmits the same draft with the flag set one
 * way or the other; cancelling leaves the draft open, unsaved, so the editor is not lost, only the
 * question.
 */
export function InProgressOccurrenceQuestion({
  onAnswer,
  onCancel
}: {
  onAnswer: (applyToOccurrenceInProgress: boolean) => void;
  onCancel: () => void;
}) {
  return (
    <div className="form-warning">
      <p>Also change the one happening now?</p>
      <div className="row-actions">
        <button type="button" className="quiet small" onClick={() => onAnswer(true)}>
          Yes, change it too
        </button>
        <button type="button" className="quiet small" onClick={() => onAnswer(false)}>
          No, leave it as it is
        </button>
        <button type="button" className="quiet small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
