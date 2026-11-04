import { CLOSED_STATUSES } from "@openrhen/contracts";
import type { CoverageFailure, DeliverableReadiness } from "@openrhen/contracts";
import type {
  ActiveSession,
  StoredDeliverable,
  StoredDeliverableBlocker,
  StoredDeliverableCriterion,
  StoredDeliverableStep
} from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { formatZonedTime } from "@/shared/date-format";

/**
 * Pure helpers shared by the Deliverables tab and the workspace. The workspace exists in two modes —
 * an engine-allocated session, where the deliverable is edited and timed, and a read-only view opened
 * from the tab — and both read the same derived facts from here so they never disagree about what
 * phase a deliverable is in or which step comes next.
 */

export type Phase = "Breakdown" | "Carry out" | "Review";
export type WorkspaceMode = "session" | "view";

/** The phase as a person reads it. The stored name "Carry out" is the method's word; on screen it is the doing stage. */
export const phaseLabel = (phase: Phase): string => (phase === "Carry out" ? "Do the work" : phase);

export const label = (value: string) => value.replaceAll("_", " ");
/** M:SS below an hour, H:MM:SS at or above — a session or deliverable can run well past 60 minutes. */
export const formatElapsed = (seconds: number) => {
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60)
      .toString()
      .padStart(2, "0");
    return `${hours}:${minutes}:${secs}`;
  }
  return `${Math.floor(seconds / 60)}:${secs}`;
};
export const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Copies text to the clipboard, resolving `false` rather than throwing when the API is unavailable
 * (an insecure context, an older browser, a denied permission) or fails outright — the caller falls
 * back to a visible, select-all textarea so the prompt can still be copied by hand. Used by the
 * external-coordination copy-prompt affordances in `chat-panel.tsx` and `handed-off-overview.tsx`.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function replaceAt<T>(items: T[], index: number, value: T): T[] {
  return items.map((item, position) => (position === index ? value : item));
}

export const OPEN_BLOCKER_STATES = new Set(["open", "awaiting_response", "possibly_resolved"]);
export const CLOSED_DELIVERABLE_STATUSES = new Set(["completed", ...CLOSED_STATUSES]);

/** Breakdown until both approvals stand; Review once the deliverable has moved past carrying out. */
export function phaseOf(deliverable: StoredDeliverable): Phase {
  if (!deliverable.contractApprovedAt || !deliverable.planApprovedAt) return "Breakdown";
  return deliverable.status === "under_review" || deliverable.status === "ready_to_complete" ? "Review" : "Carry out";
}

/**
 * The status as a card reads it. "needs breakdown" and "ready" are stored states that approving the
 * breakdown moves between, while the phase comes from the approvals themselves, so a deliverable can
 * carry drafted actions under a status that says it has none ("needs breakdown · 0/3 actions") or sit
 * "ready" in the Breakdown phase. Before approval, name that plainly instead of quoting the stored word.
 */
export function statusText(deliverable: StoredDeliverable): string {
  const unapproved = phaseOf(deliverable) === "Breakdown";
  if (unapproved && (deliverable.status === "needs_breakdown" || deliverable.status === "ready"))
    return stepProgress(deliverable).total > 0 ? "breakdown awaiting approval" : "needs breakdown";
  return label(deliverable.status);
}

export function openBlockers(deliverable: StoredDeliverable): StoredDeliverableBlocker[] {
  return deliverable.blockers.filter((blocker) => OPEN_BLOCKER_STATES.has(blocker.state));
}

export function stepProgress(deliverable: StoredDeliverable): { done: number; total: number; remaining: number } {
  const live = deliverable.steps.filter((step) => step.status !== "cancelled");
  return {
    done: live.filter((step) => step.status === "done").length,
    total: live.length,
    remaining: live.filter((step) => step.status !== "done").reduce((sum, step) => sum + step.remainingMinutes, 0)
  };
}

/**
 * The step a session should open on: the executable step earliest in the plan, preferring one already
 * marked doing. Null when nothing is executable, which is when a session must not accrue time to a
 * step it never had.
 */
export function nextExecutableStepId(deliverable: StoredDeliverable, readiness: DeliverableReadiness): string | null {
  const executable = new Set(readiness.executableStepIds);
  const ordered = [...deliverable.steps].sort((a, b) => a.sortOrder - b.sortOrder);
  const doing = ordered.find((step) => step.status === "doing" && executable.has(step.id));
  if (doing) return doing.id;
  return ordered.find((step) => executable.has(step.id))?.id ?? null;
}

export function sessionFor(
  state: { activeSession: ActiveSession | null },
  deliverableId: string
): ActiveSession | null {
  const session = state.activeSession;
  return session?.targetType === "deliverable" && session.targetId === deliverableId ? session : null;
}

export interface SessionTiming {
  totalSeconds: number;
  remainingSeconds: number;
  atCheckpoint: boolean;
  hasStep: boolean;
}

/** The numbers a session timer reads, shared by every place one is drawn — currently the phase bar and the session sheet — so they can never disagree. */
export function sessionTiming(session: ActiveSession, now: Date): SessionTiming {
  const openSeconds =
    session.status === "running" && session.segmentStartedAt
      ? Math.max(0, Math.floor((now.getTime() - new Date(session.segmentStartedAt).getTime()) / 1000))
      : 0;
  const totalSeconds = (session.activeElapsedSeconds ?? 0) + openSeconds;
  const remainingSeconds = Math.max(0, Math.floor((new Date(session.plannedEndAt).getTime() - now.getTime()) / 1000));
  const atCheckpoint = session.status === "feedback" || (session.status === "running" && remainingSeconds === 0);
  const hasStep = Boolean(session.stepId);
  return { totalSeconds, remainingSeconds, atCheckpoint, hasStep };
}

/** What the checkpoint's Continue button should say, and whether it can be pressed (before the caller ORs in `saving`). */
export function continueButtonState(
  session: ActiveSession,
  planningDecisionCurrent: boolean,
  continuation: { safe: boolean; recommendedMinutes: number } | null
): { label: string; disabled: boolean } {
  if (session.status !== "feedback") return { label: "Preparing checkpoint…", disabled: true };
  if (!planningDecisionCurrent) return { label: "Continue unavailable until planning refreshes", disabled: true };
  if (continuation?.safe) return { label: `Continue for ${continuation.recommendedMinutes} min`, disabled: false };
  return { label: "Continuing would displace other work", disabled: true };
}

/** The one sentence naming total remaining effort, or explaining why it isn't known yet — shared so the phase bar reads the same in every phase and session state. */
export function remainingEffortSentence(readiness: DeliverableReadiness): string {
  return readiness.remainingMinutes === null
    ? "Remaining effort becomes known after Breakdown."
    : `${readiness.remainingMinutes} minutes remaining across the deliverable.`;
}

/** How much of the completion contract is met: satisfied vs. required vs. every criterion recorded. */
export function criteriaProgress(deliverable: StoredDeliverable): {
  satisfied: number;
  required: number;
  total: number;
} {
  const required = deliverable.criteria.filter((criterion) => criterion.required);
  return {
    satisfied: required.filter((criterion) => criterion.state === "satisfied").length,
    required: required.length,
    total: deliverable.criteria.length
  };
}

const STATUS_ORDER: Record<StoredDeliverable["status"], number> = {
  in_progress: 0,
  under_review: 1,
  ready_to_complete: 1,
  ready: 2,
  needs_breakdown: 3,
  awaiting_result: 4,
  completed: 5,
  cancelled: 6,
  archived: 7
};

/** In-session first, then live work by status, then by nearest deadline, then title. */
export function sortDeliverables(deliverables: StoredDeliverable[], activeSession: ActiveSession | null) {
  const inSession = activeSession?.targetType === "deliverable" ? activeSession.targetId : null;
  const deadline = (item: StoredDeliverable) => item.internalDeadlineAt ?? item.externalDeadlineAt ?? "9999";
  return [...deliverables].sort((a, b) => {
    if (a.id === inSession) return -1;
    if (b.id === inSession) return 1;
    const status = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (status) return status;
    const due = deadline(a).localeCompare(deadline(b));
    if (due) return due;
    return a.title.localeCompare(b.title);
  });
}

export function coverageFailureText(failure: CoverageFailure): string {
  const name = failure.title || "an untitled record";
  switch (failure.kind) {
    case "uncovered_criterion":
      return `Required criterion “${name}” has no action that makes it true.`;
    case "uncontributing_step":
      return `Required action “${name}” contributes to no criterion.`;
    case "cyclic_prerequisite":
      return `Action “${name}” sits on a prerequisite cycle.`;
  }
}

/** Plain words for why a step cannot be worked on right now. */
export function stepReadinessText(
  readiness: DeliverableReadiness["steps"][number],
  deliverable: StoredDeliverable,
  conditionNames: Map<string, string>,
  timezone: string
): string {
  const title = (id: string) => deliverable.steps.find((step) => step.id === id)?.title || "an untitled action";
  switch (readiness.reason) {
    case undefined:
      return "Ready to work on";
    case "complete":
      return "Done";
    case "cancelled":
      return "Cancelled";
    case "blocked":
      return readiness.blockerIds.length
        ? `Blocked by ${readiness.blockerIds
            .map((id) => deliverable.blockers.find((blocker) => blocker.id === id)?.description || "a blocker")
            .join(", ")}`
        : "Blocked";
    case "prerequisite":
      return readiness.waitingOn.length
        ? `Waiting on ${readiness.waitingOn.map(title).join(", ")}`
        : "On a prerequisite cycle";
    case "situation": {
      const named = (ids: string[]) => ids.map((id) => conditionNames.get(id) ?? id).join(", ");
      // A hold on a commitment context gets its own sentence — "Needs Maths class" reads as a place to
      // be, when what is actually missing is the class being in session right now. When the next
      // occurrence is already known, naming when it starts turns the hold into something actionable
      // instead of just a reason to wait.
      const commitmentHold = readiness.conditionMatch.commitmentHold;
      if (commitmentHold)
        return commitmentHold.availableFrom
          ? `${commitmentHold.unavailableReason} Starts at ${formatZonedTime(commitmentHold.availableFrom, timezone)}.`
          : commitmentHold.unavailableReason;
      if (readiness.conditionMatch.missing.length) return `Needs ${named(readiness.conditionMatch.missing)}`;
      if (readiness.conditionMatch.unknowns.length)
        return `Unknown whether ${named(readiness.conditionMatch.unknowns)}`;
      return "Not possible in the current situation";
    }
    default:
      return "Not available now";
  }
}

export const newStep = (sortOrder = 0): StoredDeliverableStep => ({
  id: createClientId(),
  title: "",
  status: "planned",
  optimisticMinutes: 20,
  expectedMinutes: 30,
  pessimisticMinutes: 45,
  remainingMinutes: 30,
  energy: "medium",
  minimumSessionMinutes: 15,
  maximumSessionMinutes: 60,
  splittable: true,
  setupMinutes: 0,
  required: true,
  sortOrder,
  dependencyIds: [],
  requirementPathways: []
});
export const newCriterion = (sortOrder = 0): StoredDeliverableCriterion => ({
  id: createClientId(),
  key: createClientId(),
  title: "",
  required: true,
  state: "unsatisfied",
  sortOrder,
  stepIds: []
});
export const newBlocker = (): StoredDeliverableBlocker => ({
  id: createClientId(),
  description: "",
  category: "missing_information",
  state: "open",
  stepIds: []
});

/** Removing a step must also drop every reference to it, or the save is refused for a dangling id. */
export function removeStep(deliverable: StoredDeliverable, stepId: string): StoredDeliverable {
  return {
    ...deliverable,
    steps: deliverable.steps
      .filter((step) => step.id !== stepId)
      .map((step, index) => ({
        ...step,
        sortOrder: index,
        dependencyIds: step.dependencyIds.filter((id) => id !== stepId)
      })),
    criteria: deliverable.criteria.map((criterion) => ({
      ...criterion,
      stepIds: criterion.stepIds.filter((id) => id !== stepId)
    })),
    blockers: deliverable.blockers.map((blocker) => ({
      ...blocker,
      stepIds: blocker.stepIds.filter((id) => id !== stepId)
    }))
  };
}
