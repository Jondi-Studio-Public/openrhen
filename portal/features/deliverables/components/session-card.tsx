"use client";

import { useState } from "react";
import type { ActiveSession } from "@/state/portal-state";
import type { ClientContinuation } from "@/state/portal-provider";
import { continueButtonState, formatElapsed, sessionTiming } from "@/features/deliverables/deliverable-model";
import { dateInput, iso } from "@/features/today/local-datetime";

export type SessionOutcome = "completed" | "blocked" | "stopped";

/**
 * The timer and the only session controls. Rendered solely inside an engine-allocated session; the
 * read-only view has no timer because no time is being spent.
 *
 * Before the checkpoint: pause or resume, and stop. At the checkpoint the session is awaiting
 * feedback and every honest answer is offered — continue for the minutes the engine says are safe,
 * or end the session saying what happened to the current step (done, blocked, or work remains). Time
 * spent with no step chosen is named plainly, because it accrues to nothing.
 */
export function SessionCard({
  session,
  now,
  currentStepTitle,
  saving,
  planningDecisionCurrent,
  continuation,
  timezone,
  onPauseResume,
  onContinue,
  onFinish
}: {
  session: ActiveSession;
  now: Date;
  currentStepTitle: string | undefined;
  saving: boolean;
  planningDecisionCurrent: boolean;
  continuation: ClientContinuation | null;
  /** The planning timezone: the picker speaks the same wall clock as every other time in the app. */
  timezone: string;
  onPauseResume: () => void;
  onContinue: () => void;
  onFinish: (outcome: SessionOutcome, note: string, endedAt?: string) => void;
}) {
  const [note, setNote] = useState("");
  const [endedEarlier, setEndedEarlier] = useState(false);
  const [endedAtInput, setEndedAtInput] = useState("");
  const { totalSeconds, remainingSeconds, atCheckpoint, hasStep } = sessionTiming(session, now);
  const continueState = continueButtonState(session, planningDecisionCurrent, continuation);
  const segmentStartedAt = session.segmentStartedAt ? new Date(session.segmentStartedAt) : undefined;
  const chosenEndedAt = endedEarlier && segmentStartedAt && endedAtInput ? iso(endedAtInput, timezone) : undefined;
  const finish = (outcome: SessionOutcome) =>
    chosenEndedAt ? onFinish(outcome, note, chosenEndedAt) : onFinish(outcome, note);
  return (
    <section className="session-card" aria-label="Session">
      <span>
        {atCheckpoint ? "Checkpoint reached" : session.status === "paused" ? "Paused" : "Time left in this session"}
      </span>
      <strong>{atCheckpoint ? formatElapsed(totalSeconds) : formatElapsed(remainingSeconds)}</strong>
      <small>
        {atCheckpoint
          ? "The allocation is spent. Continue if there is room in the plan, or say what happened."
          : `${session.plannedMinutes} minute session`}
      </small>
      <small>{formatElapsed(totalSeconds)} active time on this deliverable</small>
      <small>
        {hasStep ? `Timing: ${currentStepTitle ?? "the current action"}` : ""}
        {!hasStep && (
          <span className="error" role="alert">
            No action is chosen: this time is not being credited to any action. Choose “Work on this action”.
          </span>
        )}
      </small>
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
      {atCheckpoint && continuation?.reason && <small>{continuation.reason}</small>}
      <label className="field">
        <span>Optional note</span>
        <input value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      {segmentStartedAt && (
        <label className="field">
          <input
            type="checkbox"
            checked={endedEarlier}
            onChange={(event) => {
              setEndedEarlier(event.target.checked);
              if (!event.target.checked) setEndedAtInput("");
            }}
          />
          <span>Ended earlier</span>
          {endedEarlier && (
            <input
              type="datetime-local"
              aria-label="Ended earlier"
              value={endedAtInput}
              min={dateInput(segmentStartedAt.toISOString(), timezone)}
              max={dateInput(now.toISOString(), timezone)}
              onChange={(event) => setEndedAtInput(event.target.value)}
            />
          )}
        </label>
      )}
      {hasStep && (
        <button type="button" className="quiet" disabled={saving} onClick={() => finish("completed")}>
          Step done — end session
        </button>
      )}
      {hasStep && (
        <button type="button" className="quiet" disabled={saving} onClick={() => finish("blocked")}>
          Step blocked — end session
        </button>
      )}
      <button type="button" className="quiet" disabled={saving} onClick={() => finish("stopped")}>
        Stop — work remains
      </button>
    </section>
  );
}
