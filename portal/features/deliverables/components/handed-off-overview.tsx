"use client";

import { useEffect, useState } from "react";
import type { CoordinationState, DeliverableReadiness } from "@openrhen/contracts";
import type { ActiveSession, PortalState, StoredDeliverable } from "@/state/portal-state";
import {
  copyText,
  formatElapsed,
  label,
  phaseLabel,
  phaseOf,
  sessionTiming,
  stepProgress
} from "@/features/deliverables/deliverable-model";
import { formatZonedTime } from "@/shared/date-format";
import { useCoordination, type CoordinationPrompts } from "@/features/deliverables/use-coordination";
import { StepRail } from "./step-rail";
import { CriteriaRail } from "./criteria-rail";
import { BlockerRail } from "./blocker-rail";
import { ReadinessPanel, type EngineOpinion } from "./readiness-panel";

/**
 * Replaces the chat panel in the conversation column while a deliverable is handed off to an
 * external (desktop AI) coordinator: who's coordinating and since when, the phase and step
 * progress, the plan read-only, and a feed of the notes they've posted — plus the two controls to
 * bring the chat back. See the external coordination design note, "The workspace while handed off"
 * and "Bringing it back".
 */
export function HandedOffOverview({
  deliverableId,
  deliverable,
  readiness,
  engine,
  conditionDefinitions,
  session,
  now,
  currentStepTitle,
  timezone,
  reloadKey = 0,
  onCoordination
}: {
  deliverableId: string;
  deliverable: StoredDeliverable;
  readiness: DeliverableReadiness;
  engine: EngineOpinion | null | undefined;
  conditionDefinitions: PortalState["conditionDefinitions"];
  session: ActiveSession | null;
  now: Date;
  currentStepTitle: string | undefined;
  timezone: string;
  reloadKey?: number;
  onCoordination?: (coordination: CoordinationState | null, prompts: CoordinationPrompts | null) => void;
}) {
  const { messages, coordination, prompts, error, reload } = useCoordination(deliverableId, reloadKey);

  // The page decides whether to mount this component or ChatPanel from this same callback, so it
  // learns the instant a drop-off flips `handedOff` back to false and can swap the chat back in.
  // Not before this component's own load lands: its first render holds `null`, and reporting that would
  // swap the chat panel straight back in, which reloads, reads "handed off" and swaps this in again.
  useEffect(() => {
    if (messages === null) return;
    onCoordination?.(coordination, prompts);
  }, [messages, coordination, prompts, onCoordination]);

  const phase = phaseOf(deliverable);
  const progress = stepProgress(deliverable);
  const notes = (messages ?? [])
    .filter((message) => message.role === "external")
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const [bringBackRevealed, setBringBackRevealed] = useState(false);
  const [bringBackCopied, setBringBackCopied] = useState(false);
  const [takingBack, setTakingBack] = useState(false);
  const [takeBackError, setTakeBackError] = useState("");

  async function copyBringBack() {
    if (!prompts) return;
    const ok = await copyText(prompts.bringBack);
    setBringBackCopied(ok);
    if (ok) setTimeout(() => setBringBackCopied(false), 2500);
  }

  async function takeBackWithoutSummary() {
    setTakingBack(true);
    setTakeBackError("");
    try {
      const response = await fetch(`/api/deliverables/${encodeURIComponent(deliverableId)}/handoff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "drop_off", tool: "portal", text: "" })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Could not take the deliverable back.");
      }
      reload();
    } catch (cause) {
      setTakeBackError(cause instanceof Error ? cause.message : "Could not take the deliverable back.");
    } finally {
      setTakingBack(false);
    }
  }

  return (
    <div className="handed-off-overview" aria-label="Coordinated externally">
      <h2>
        Coordinated in {coordination?.tool ?? "a desktop AI"}
        {coordination?.since ? ` since ${formatZonedTime(coordination.since, timezone)}` : ""}
      </h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <p>
        {phaseLabel(phase)} · {progress.done} of {progress.total} actions done
      </p>
      {session && (
        <p className="handed-off-session">
          Session: {currentStepTitle ?? "no action chosen"} · {formatElapsed(sessionTiming(session, now).totalSeconds)}{" "}
          elapsed
        </p>
      )}
      <StepRail
        deliverable={deliverable}
        readiness={readiness}
        conditionDefinitions={conditionDefinitions}
        editable={false}
        currentStepId={session?.stepId}
        stepSeconds={session?.stepSeconds}
        canSwitch={false}
        onSwitchStep={() => {}}
        onEdit={() => {}}
        timezone={timezone}
      />
      <CriteriaRail deliverable={deliverable} editable={false} onEdit={() => {}} />
      <BlockerRail deliverable={deliverable} editable={false} onEdit={() => {}} />
      <ReadinessPanel deliverable={deliverable} readiness={readiness} engine={engine} timezone={timezone} />
      <section aria-label="Notes" className="handed-off-notes">
        <h3>Notes from {coordination?.tool ?? "the desktop AI"}</h3>
        {notes.length === 0 && <p className="empty">No notes yet.</p>}
        <ul className="workspace-note-list">
          {notes.map((note) => (
            <li key={note.id}>
              <small>
                {note.meta?.tool ?? "External tool"} · {label(note.meta?.kind ?? "note")} ·{" "}
                {formatZonedTime(note.createdAt, timezone)}
              </small>
              <p>{note.content}</p>
            </li>
          ))}
        </ul>
      </section>
      <div className="handed-off-bring-back">
        {!bringBackRevealed ? (
          <button type="button" disabled={!prompts} onClick={() => setBringBackRevealed(true)}>
            Bring back to the portal
          </button>
        ) : (
          <div className="handed-off-bring-back-panel">
            <p className="microcopy">
              Paste this into {coordination?.tool ?? "the desktop AI"}. The chat returns here as soon as it records the
              drop-off.
            </p>
            <textarea
              aria-label="Bring-back prompt"
              readOnly
              value={prompts?.bringBack ?? ""}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="small" onClick={() => void copyBringBack()}>
              Copy
            </button>
            {bringBackCopied && (
              <span role="status" className="chat-copy-status">
                Copied.
              </span>
            )}
            <p className="microcopy">Waiting for the drop-off…</p>
          </div>
        )}
        <button
          type="button"
          className="quiet small"
          disabled={takingBack}
          onClick={() => void takeBackWithoutSummary()}
        >
          Take back without a summary
        </button>
        {takeBackError && (
          <p role="alert" className="error">
            {takeBackError}
          </p>
        )}
      </div>
    </div>
  );
}
