"use client";

import type { DeliverableReadiness } from "@openrhen/contracts";
import type { ActiveSession, StoredDeliverable } from "@/state/portal-state";
import type { ClientContinuation } from "@/state/portal-provider";
import {
  continueButtonState,
  criteriaProgress,
  formatElapsed,
  OPEN_BLOCKER_STATES,
  remainingEffortSentence,
  sessionTiming,
  type Phase
} from "@/features/deliverables/deliverable-model";

export type WorkspaceDrawer =
  "details" | "steps" | "criteria" | "sources" | "blockers" | "readiness" | "session" | "proposals";

/**
 * The pinned working set: what is happening right now, and the chip row that opens everything else
 * behind a sheet. Never scrolls away — it is the reason the timer and the current step stay visible
 * without the document itself scrolling.
 */
export function PhaseBar({
  deliverable,
  readiness,
  phase,
  session,
  now,
  currentStepTitle,
  canSwitch,
  saving,
  planningDecisionCurrent,
  continuation,
  pendingProposalCount,
  onPauseResume,
  onContinue,
  onOpen
}: {
  deliverable: StoredDeliverable;
  readiness: DeliverableReadiness;
  phase: Phase;
  session: ActiveSession | null;
  now: Date;
  currentStepTitle: string | undefined;
  canSwitch: boolean;
  saving: boolean;
  planningDecisionCurrent: boolean;
  continuation: ClientContinuation | null;
  pendingProposalCount: number;
  onPauseResume: () => void;
  onContinue: () => void;
  onOpen: (drawer: WorkspaceDrawer) => void;
}) {
  const openBlockers = deliverable.blockers.filter((blocker) => OPEN_BLOCKER_STATES.has(blocker.state)).length;
  const progress = criteriaProgress(deliverable);
  const remainingSentence = remainingEffortSentence(readiness);

  return (
    <div className="workspace-phase-bar" aria-label="Working set">
      <div className="phase-bar-focus">
        {phase === "Review" && (
          <>
            <strong>
              {progress.satisfied}/{progress.required}
            </strong>
            <small>required criteria satisfied</small>
          </>
        )}
        {session && (
          <SessionFocus
            session={session}
            now={now}
            currentStepTitle={currentStepTitle}
            canSwitch={canSwitch}
            saving={saving}
            planningDecisionCurrent={planningDecisionCurrent}
            continuation={continuation}
            remainingSentence={remainingSentence}
            onPauseResume={onPauseResume}
            onContinue={onContinue}
            onOpen={onOpen}
          />
        )}
        {!session && (phase === "Carry out" || phase === "Review") && (
          <>
            <span>Read-only view — start this deliverable from Now to work on it.</span>
            <small>{remainingSentence}</small>
          </>
        )}
        {phase === "Breakdown" && (
          <BreakdownFocus
            deliverable={deliverable}
            readiness={readiness}
            remainingSentence={remainingSentence}
            onOpen={onOpen}
          />
        )}
      </div>
      <div className="workspace-chips">
        <button type="button" className="workspace-chip" onClick={() => onOpen("details")}>
          Details
        </button>
        <button type="button" className="workspace-chip" onClick={() => onOpen("steps")}>
          Actions {deliverable.steps.length}
        </button>
        <button type="button" className="workspace-chip" onClick={() => onOpen("criteria")}>
          Criteria {progress.satisfied}/{progress.total}
        </button>
        <button type="button" className="workspace-chip" onClick={() => onOpen("sources")}>
          Sources {deliverable.sourceFiles.length}
        </button>
        <button
          type="button"
          className={`workspace-chip${openBlockers > 0 ? " error" : ""}`}
          onClick={() => onOpen("blockers")}
        >
          Blockers {openBlockers}
        </button>
        <button type="button" className="workspace-chip" onClick={() => onOpen("readiness")}>
          Readiness
        </button>
        {session && (
          <button type="button" className="workspace-chip" onClick={() => onOpen("session")}>
            Session
          </button>
        )}
        {pendingProposalCount > 0 && (
          <button type="button" className="workspace-chip" onClick={() => onOpen("proposals")}>
            Earlier extraction {pendingProposalCount}
          </button>
        )}
      </div>
    </div>
  );
}

function SessionFocus({
  session,
  now,
  currentStepTitle,
  canSwitch,
  saving,
  planningDecisionCurrent,
  continuation,
  remainingSentence,
  onPauseResume,
  onContinue,
  onOpen
}: {
  session: ActiveSession;
  now: Date;
  currentStepTitle: string | undefined;
  canSwitch: boolean;
  saving: boolean;
  planningDecisionCurrent: boolean;
  continuation: ClientContinuation | null;
  remainingSentence: string;
  onPauseResume: () => void;
  onContinue: () => void;
  onOpen: (drawer: WorkspaceDrawer) => void;
}) {
  const { totalSeconds, remainingSeconds, atCheckpoint, hasStep } = sessionTiming(session, now);
  const continueState = continueButtonState(session, planningDecisionCurrent, continuation);
  return (
    <>
      {hasStep ? (
        <span className="phase-bar-now">Now: {currentStepTitle}</span>
      ) : (
        <span className="error" role="alert">
          No action is chosen: this time is not being credited to any action. Choose “Work on this action”.
        </span>
      )}
      <strong className="phase-bar-timer">{formatElapsed(atCheckpoint ? totalSeconds : remainingSeconds)}</strong>
      <small>
        {atCheckpoint
          ? "The allocation is spent."
          : `${session.plannedMinutes} min session · ${formatElapsed(totalSeconds)} active`}{" "}
        {remainingSentence}
      </small>
      <div className="phase-bar-controls">
        {!atCheckpoint && (
          <button type="button" disabled={saving} onClick={onPauseResume}>
            {session.status === "paused" ? "Resume" : "Pause"}
          </button>
        )}
        {atCheckpoint && (
          <button type="button" disabled={continueState.disabled || saving} onClick={onContinue}>
            {continueState.label}
          </button>
        )}
        {canSwitch && (
          <button type="button" className="quiet small" onClick={() => onOpen("steps")}>
            Switch action
          </button>
        )}
        <button type="button" className="quiet small" onClick={() => onOpen("session")}>
          End session
        </button>
      </div>
    </>
  );
}

function BreakdownFocus({
  deliverable,
  readiness,
  remainingSentence,
  onOpen
}: {
  deliverable: StoredDeliverable;
  readiness: DeliverableReadiness;
  remainingSentence: string;
  onOpen: (drawer: WorkspaceDrawer) => void;
}) {
  const problems = readiness.coverageFailures.length;
  return (
    <>
      <span className="phase-bar-now">{readiness.approved ? "Approved" : "Unapproved breakdown"}</span>
      {problems > 0 ? (
        <button type="button" className="workspace-chip error" onClick={() => onOpen("readiness")}>
          {problems} problem{problems === 1 ? "" : "s"} block approval
        </button>
      ) : (
        <small>
          {deliverable.criteria.length && deliverable.steps.length
            ? "Every required criterion has an action. The breakdown can be approved."
            : "Add at least one criterion and one action."}{" "}
          {remainingSentence}
        </small>
      )}
    </>
  );
}
