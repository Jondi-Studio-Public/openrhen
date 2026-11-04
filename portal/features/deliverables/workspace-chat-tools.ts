import { createClientId } from "@/shared/client-id";
import { isClosedStatus } from "@openrhen/contracts";
import type {
  BlockerCategory,
  CriterionState,
  StoredDeliverable,
  StoredDeliverableBlocker
} from "@/state/portal-state";

export interface StepCompletion {
  stepTitles: string[];
  evidenceNote: string;
}

export interface BlockerReport {
  description: string;
  category: BlockerCategory;
  stepTitles: string[];
  proposedResolution?: string;
}

export interface BlockerResolution {
  blockerDescription: string;
  resolutionNote: string;
  /** The substance of what the blocking party said, retained as a durable source. See route.ts. */
  feedback?: string;
}

export interface CriterionReview {
  criteria: {
    title: string;
    state: CriterionState;
    evidenceNote: string;
  }[];
  summary: string;
}

export interface Submission {
  waitingFor: string;
  category: BlockerCategory;
  proposedResolution?: string;
}

export interface WorkspaceUpdate {
  deliverable: StoredDeliverable;
  matchedTitles: string[];
  changed: boolean;
}

export interface StepCompletionUpdate extends WorkspaceUpdate {
  /**
   * Blockers structurally re-recorded because a completed step carried `reblockOnComplete` — for
   * example a resubmit step that hands revised work back for another look. `stepTitles` names
   * whichever of this step's direct dependents actually got gated, so the person can be told exactly
   * what is waiting again. Empty when nothing completed this call carried the metadata, which is the
   * ordinary case and how an approval path ends the loop instead of re-arming it.
   */
  reblocked: { description: string; stepTitles: string[] }[];
}

const normalized = (value: string) => value.trim().toLocaleLowerCase();

const OPEN_BLOCKER_STATES = new Set<StoredDeliverableBlocker["state"]>([
  "open",
  "awaiting_response",
  "possibly_resolved"
]);

/**
 * Records an external blocker as an aggregate entry, linked to the named existing steps it gates.
 * The step statuses stay untouched: readiness derives "blocked" from the open blocker's stepIds, so
 * clearing the blocker restores the steps without a second edit. An open blocker with the same
 * description is treated as the same report, so replays are idempotent.
 */
export function recordBlocker(
  deliverable: StoredDeliverable,
  report: BlockerReport,
  createdAt = new Date().toISOString(),
  id = createClientId()
): WorkspaceUpdate {
  const requested = new Set(report.stepTitles.map(normalized).filter(Boolean));
  const matchedTitles: string[] = [];
  const stepIds: string[] = [];
  for (const step of deliverable.steps) {
    if (!requested.has(normalized(step.title))) continue;
    matchedTitles.push(step.title);
    stepIds.push(step.id);
  }
  const duplicate = deliverable.blockers.some(
    (blocker) =>
      OPEN_BLOCKER_STATES.has(blocker.state) && normalized(blocker.description) === normalized(report.description)
  );
  if (duplicate) return { deliverable, matchedTitles, changed: false };
  const blocker: StoredDeliverableBlocker = {
    id,
    description: report.description,
    category: report.category,
    state: "open",
    createdAt,
    stepIds,
    ...(report.proposedResolution ? { proposedResolution: report.proposedResolution } : {})
  };
  return {
    deliverable: { ...deliverable, blockers: [...deliverable.blockers, blocker] },
    matchedTitles,
    changed: true
  };
}

/**
 * Resolves the blocker matching the given description. `matchedTitles` carries the matched blocker
 * description so the caller can tell "no such blocker" from "already resolved"; replays change nothing.
 *
 * A deliverable in `awaiting_result` holds no claim on work time for as long as it has an open
 * blocker (see `engine/core/src/scheduling/deliverables.ts`); resolving the last one is therefore the
 * signal that the wait is over, and returns it to `under_review` so `record_review` can run against
 * whatever the resolution's `feedback` retained. A second open blocker (an ordinary one recorded while
 * waiting) keeps it there — only clearing the last open blocker moves the status.
 */
export function resolveBlocker(
  deliverable: StoredDeliverable,
  resolution: BlockerResolution,
  resolvedAt = new Date().toISOString()
): WorkspaceUpdate {
  const target = normalized(resolution.blockerDescription);
  const matchedTitles: string[] = [];
  let changed = false;
  const blockers = deliverable.blockers.map((blocker) => {
    if (normalized(blocker.description) !== target) return blocker;
    matchedTitles.push(blocker.description);
    if (blocker.state === "resolved" || blocker.state === "dismissed") return blocker;
    changed = true;
    const note = resolution.resolutionNote.trim();
    const noteLine = note ? `Resolved: ${note}` : "";
    const resolutionNotes =
      noteLine && !blocker.resolutionNotes?.split("\n").includes(noteLine)
        ? [blocker.resolutionNotes?.trim(), noteLine].filter(Boolean).join("\n")
        : blocker.resolutionNotes;
    return {
      ...blocker,
      state: "resolved" as const,
      resolvedAt: blocker.resolvedAt ?? resolvedAt,
      ...(resolutionNotes ? { resolutionNotes } : {})
    };
  });
  const noneOpen = !blockers.some((blocker) => OPEN_BLOCKER_STATES.has(blocker.state));
  const returnsFromWaiting = changed && deliverable.status === "awaiting_result" && noneOpen;
  return {
    deliverable: changed
      ? { ...deliverable, blockers, ...(returnsFromWaiting ? { status: "under_review" as const } : {}) }
      : deliverable,
    matchedTitles,
    changed
  };
}

/**
 * Records that the work is done and handed to someone else, moving the deliverable to
 * `awaiting_result` so the engine stops offering it time it cannot use. The blocker it records names
 * no steps — the work is finished, nothing is stuck — so `deliverable-readiness.ts` never reports a
 * step blocked because of it; it exists only so `resolveBlocker`'s "last open blocker" rule has
 * something to clear when the result comes back. `submittedAt` is set once and never cleared by a
 * resolution, so a rejected result and a re-submission both read as "this has been sent before."
 */
export function submitForResult(
  deliverable: StoredDeliverable,
  submission: Submission,
  submittedAt = new Date().toISOString()
): StoredDeliverable {
  const blocker: StoredDeliverableBlocker = {
    id: createClientId(),
    description: submission.waitingFor,
    category: submission.category,
    state: "open",
    createdAt: submittedAt,
    stepIds: [],
    ...(submission.proposedResolution ? { proposedResolution: submission.proposedResolution } : {})
  };
  return {
    ...deliverable,
    status: "awaiting_result",
    submittedAt: deliverable.submittedAt ?? submittedAt,
    blockers: [...deliverable.blockers, blocker]
  };
}

/**
 * Records only explicitly named, existing steps as done. Matching by title keeps generated tool
 * arguments human-readable while refusing to invent plan records. Replays are idempotent.
 *
 * A step that carries `reblockOnComplete` and is newly finished by this call (not already done)
 * structurally re-records that description as a fresh open blocker — the conditional re-arm a
 * revision loop needs so a resubmit step's completion does not silently free the work it hands back
 * to. `recordBlocker`'s dedupe only checks OPEN blockers, so re-recording a description that was
 * previously resolved creates a genuinely new open entry rather than being swallowed as a duplicate.
 * The blocker gates whichever of the step's own direct dependents exist — the same "only the step(s)
 * it directly stops" rule the model itself follows when it calls record_blocker — so an approval path
 * that creates no such step and completes no such step re-arms nothing at all.
 */
export function markStepsComplete(
  deliverable: StoredDeliverable,
  completion: StepCompletion,
  completedAt = new Date().toISOString()
): StepCompletionUpdate {
  const requested = new Set(completion.stepTitles.map(normalized).filter(Boolean));
  const evidence = completion.evidenceNote.trim();
  const evidenceLine = evidence ? `Completion evidence: ${evidence}` : "";
  const matchedTitles: string[] = [];
  let changed = false;
  const newlyCompleted: StoredDeliverable["steps"] = [];
  const steps = deliverable.steps.map((step) => {
    if (!requested.has(normalized(step.title))) return step;
    // A closed step is restored through the close route, never reopened to done by a chat completion.
    if (isClosedStatus(step.status)) return step;
    matchedTitles.push(step.title);
    const details =
      evidenceLine && !step.details?.split("\n").includes(evidenceLine)
        ? [step.details?.trim(), evidenceLine].filter(Boolean).join("\n")
        : step.details;
    if (step.status === "done" && step.details === details) return step;
    changed = true;
    if (step.status !== "done") newlyCompleted.push(step);
    return {
      ...step,
      status: "done" as const,
      remainingMinutes: 0,
      lastWorkedAt: completedAt,
      completedAt: step.completedAt ?? completedAt,
      ...(details ? { details } : {})
    };
  });
  let result: StoredDeliverable = changed ? { ...deliverable, steps, lastWorkedAt: completedAt } : deliverable;
  const reblocked: { description: string; stepTitles: string[] }[] = [];
  for (const step of newlyCompleted) {
    const reblock = step.reblockOnComplete;
    if (!reblock) continue;
    // Dependents are read from the pre-completion graph — completion never changes dependencyIds —
    // and named by title because recordBlocker resolves its own step links the same way the model's
    // own record_blocker calls do, keeping this one code path for both origins of a blocker.
    const dependentTitles = deliverable.steps
      .filter((other) => other.dependencyIds.includes(step.id))
      .map((other) => other.title);
    const update = recordBlocker(
      result,
      { description: reblock.description, category: reblock.category, stepTitles: dependentTitles },
      completedAt
    );
    if (update.changed) {
      result = update.deliverable;
      changed = true;
      reblocked.push({ description: reblock.description, stepTitles: update.matchedTitles });
    }
  }
  return { deliverable: result, matchedTitles, changed, reblocked };
}

/**
 * Records a criterion-by-criterion audit. Review notes are appended without replacing source notes,
 * and a successful replay does not duplicate them. Passing every required criterion makes the
 * deliverable ready for the person's final completion action; it never completes the deliverable.
 */
export function recordCriterionReview(deliverable: StoredDeliverable, review: CriterionReview): WorkspaceUpdate {
  const requested = new Map(review.criteria.map((item) => [normalized(item.title), item]));
  const matchedTitles: string[] = [];
  let changed = false;
  const criteria = deliverable.criteria.map((criterion) => {
    const result = requested.get(normalized(criterion.title));
    if (!result) return criterion;
    matchedTitles.push(criterion.title);
    const evidence = result.evidenceNote.trim();
    const reviewNote = evidence ? `Review: ${evidence}` : "";
    const notes =
      reviewNote && !criterion.notes?.split("\n").includes(reviewNote)
        ? [criterion.notes?.trim(), reviewNote].filter(Boolean).join("\n")
        : criterion.notes;
    if (criterion.state === result.state && criterion.notes === notes) return criterion;
    changed = true;
    return { ...criterion, state: result.state, ...(notes ? { notes } : {}) };
  });
  const contractSatisfied = criteria
    .filter((criterion) => criterion.required)
    .every((criterion) => criterion.state === "satisfied" || criterion.state === "not_applicable");
  const status = contractSatisfied ? "ready_to_complete" : "under_review";
  if (deliverable.status !== status) changed = true;
  return {
    deliverable: changed ? { ...deliverable, criteria, status } : deliverable,
    matchedTitles,
    changed
  };
}
