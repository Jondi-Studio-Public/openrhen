"use client";

import { useState } from "react";
import type { PlanningEntityCommand } from "@openrhen/contracts";
import { ArrivalButton } from "@/components/situation-panel";
import { createClientId } from "@/shared/client-id";
import type { PortalState, StoredCommitment } from "@/state/portal-state";
import { LetSomeoneKnow } from "@/features/commitments/components/let-someone-know";
import { clock } from "@/features/now/now-formatting";
import type { NowProtectedCommitment, RunActivityCommand } from "@/features/now/now-model";
import { endDisruptionNow, extendDisruption, isOpenEndedDisruption } from "@/features/disruptions/disruption-commands";
import { canBeFreed } from "@/features/now/free-commitment";
import { EvidenceDetails } from "./evidence-details";
import { FreeControl } from "./free-control";

/**
 * What the protected window is holding the clock for. The legs to and from a located commitment are
 * protected exactly as its buffers are, so they have their own names here; ordinarily the travel
 * panel has already claimed the page by then, and this is the wording if it has not.
 */
function phaseLabel(phase: NowProtectedCommitment["phase"]): string {
  switch (phase) {
    case "setup":
      return "setup buffer";
    case "active":
      return "commitment in progress";
    case "travel":
      return "travelling to it";
    case "arrival":
      return "arrival margin";
    case "return":
      return "travelling back";
    default:
      return "transition buffer";
  }
}

/**
 * What the Start button offers to track. Every phase but `active` tracks only its own window — the
 * button used to send `protectedEndAt` regardless of phase, so pressing it during setup opened a
 * session spanning the whole protected block, titled as the commitment itself.
 */
function phaseButtonLabel(phase: NowProtectedCommitment["phase"]): string {
  switch (phase) {
    case "setup":
      return "Start tracking preparation";
    case "travel":
      return "Start tracking the drive";
    case "arrival":
      return "Start tracking arrival";
    case "transition":
      return "Start tracking the transition";
    case "return":
      return "Start tracking the drive back";
    default:
      return "Start tracking time";
  }
}

/**
 * A confirmed commitment holds the clock, including its setup and transition buffers. Work is not
 * offered against it; the only thing on offer is recording that the time was actually spent on it.
 */
export function ProtectedCommitmentPanel({
  protectedCommitment,
  storedProtectedCommitment,
  state,
  now,
  timezone,
  saving,
  explanation,
  evidence,
  runActivityCommand,
  saveEntityCommand
}: {
  protectedCommitment: NowProtectedCommitment;
  storedProtectedCommitment: StoredCommitment | undefined;
  state: PortalState;
  now: Date;
  timezone: string;
  saving: boolean;
  explanation: string;
  evidence: readonly string[];
  runActivityCommand: RunActivityCommand;
  saveEntityCommand: (command: PlanningEntityCommand) => Promise<void>;
}) {
  // An open-ended disruption is holding the clock on a guess, not a fact — these two live only while
  // that is true, and disappear on their own once the guess is resolved and the record above updates.
  const openEnded = Boolean(storedProtectedCommitment && isOpenEndedDisruption(storedProtectedCommitment));
  const commitmentLocation = storedProtectedCommitment?.locationId
    ? state.conditionDefinitions.find((entry) => entry.id === storedProtectedCommitment.locationId)
    : undefined;
  const [lifecycleSaving, setLifecycleSaving] = useState(false);
  const [lifecycleError, setLifecycleError] = useState("");
  const [errorCommitmentId, setErrorCommitmentId] = useState(protectedCommitment.id);
  if (errorCommitmentId !== protectedCommitment.id) {
    setErrorCommitmentId(protectedCommitment.id);
    setLifecycleError("");
  }
  async function endNow() {
    if (!storedProtectedCommitment) return;
    setLifecycleSaving(true);
    const message = await endDisruptionNow(storedProtectedCommitment, { state, now, saveEntityCommand });
    setLifecycleSaving(false);
    setLifecycleError(message);
  }
  async function extendHour() {
    if (!storedProtectedCommitment) return;
    setLifecycleSaving(true);
    const message = await extendDisruption(storedProtectedCommitment, 60, { state, now, saveEntityCommand });
    setLifecycleSaving(false);
    setLifecycleError(message);
  }
  return (
    <>
      <p className="time">
        {clock(new Date(protectedCommitment.startsAt), timezone)}–
        {clock(new Date(protectedCommitment.endsAt), timezone)} · {phaseLabel(protectedCommitment.phase)}
      </p>
      {/*
        The same disambiguation added earlier lived only as a paragraph below
        the button, several elements after the "commitment in progress" wording it was explaining —
        easy to miss on a quick read, and the reporter hit the identical confusion again after that
        fix had shipped. Answering "which is it?" belongs right next to the phrase that raised the
        question, not after it.
      */}
      {protectedCommitment.phase === "active" ? (
        <p className="microcopy">
          Not tracking time. The schedule already protects this block whether or not tracking is on — start tracking
          below only if you also want the actual time logged.
        </p>
      ) : null}
      <div className="time-details">
        <div>
          <span>Event</span>
          <strong>
            {clock(new Date(protectedCommitment.startsAt), timezone)}–
            {clock(new Date(protectedCommitment.endsAt), timezone)}
          </strong>
        </div>
        <div>
          <span>Protected from</span>
          <strong>{clock(new Date(protectedCommitment.protectedStartAt), timezone)}</strong>
        </div>
        <div>
          <span>Protected until</span>
          <strong>{clock(new Date(protectedCommitment.protectedEndAt), timezone)}</strong>
        </div>
      </div>
      <p className="reason">{explanation}</p>
      {protectedCommitment.late && (
        <div className="actions">
          <LetSomeoneKnow commitmentId={protectedCommitment.id} reason="late" />
        </div>
      )}
      {commitmentLocation && commitmentLocation.id !== state.currentSituation.locationId && (
        <div className="actions">
          <ArrivalButton
            state={state}
            saving={saving}
            locationId={commitmentLocation.id}
            locationName={commitmentLocation.name}
            saveEntityCommand={saveEntityCommand}
          />
        </div>
      )}
      {storedProtectedCommitment?.location ? (
        <p className="microcopy">Location: {storedProtectedCommitment.location}</p>
      ) : null}
      {storedProtectedCommitment?.projectId ? (
        <p className="microcopy">
          Project:{" "}
          {state.projects.find((item) => item.id === storedProtectedCommitment.projectId)?.title ?? "Unknown project"}
        </p>
      ) : null}
      {/* Its own page, for the times the question is "what am I supposed to have done before this?" */}
      <p className="microcopy">
        <a href={`/commitments/${encodeURIComponent(protectedCommitment.id)}`}>Open this commitment</a>
      </p>
      {openEnded && storedProtectedCommitment ? (
        <>
          <p className="microcopy">
            This is held open until {clock(new Date(storedProtectedCommitment.endsAt), timezone)} — a guess, not a fact.
            Say when it's over and the plan rebuilds.
          </p>
          {lifecycleError && (
            <p className="form-error" role="alert">
              {lifecycleError}
            </p>
          )}
          <div className="actions">
            <button type="button" className="quiet small" disabled={lifecycleSaving} onClick={() => void endNow()}>
              Done, heading home
            </button>
            <button type="button" className="quiet small" disabled={lifecycleSaving} onClick={() => void extendHour()}>
              Still out — another hour
            </button>
          </div>
        </>
      ) : null}
      {storedProtectedCommitment && canBeFreed(storedProtectedCommitment, now, new Date(protectedCommitment.endsAt)) ? (
        <FreeControl
          commitment={storedProtectedCommitment}
          awaitingRecalculation={state.planning?.awaitingRecalculation === true}
          saving={saving}
          saveEntityCommand={saveEntityCommand}
        />
      ) : null}
      <div className="actions">
        <button
          disabled={saving}
          onClick={() =>
            void runActivityCommand({
              commandId: createClientId(),
              expectedVersion: storedProtectedCommitment?.version ?? null,
              type: "start_activity",
              targetType: "fixed_commitment",
              targetId: protectedCommitment.id,
              phase: protectedCommitment.phase,
              plannedMinutes:
                protectedCommitment.phase === "active"
                  ? Math.max(
                      1,
                      Math.round((new Date(protectedCommitment.protectedEndAt).getTime() - now.getTime()) / 60_000)
                    )
                  : Math.max(
                      1,
                      Math.round((new Date(protectedCommitment.phaseEndsAt).getTime() - now.getTime()) / 60_000)
                    )
            })
          }
        >
          {phaseButtonLabel(protectedCommitment.phase)}
        </button>
      </div>
      <EvidenceDetails summary="Why work is paused" evidence={evidence} />
    </>
  );
}
