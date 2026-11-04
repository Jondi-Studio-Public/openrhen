"use client";

import { useState } from "react";
import type { ActiveSession, PortalState } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { clock, formatRemaining } from "@/features/now/now-formatting";
import type { RunActivityCommand } from "@/features/now/now-model";

/**
 * A deliverable session is run from its workspace — the action plan, blockers and per-action timing
 * only make sense there — but pausing or stopping for now needs no context beyond "protect this
 * time or don't", so those two live here too (leaving unexpectedly on the phone
 * shouldn't require opening the workspace first). Both reuse the same `pause_activity` /
 * `finish_activity(stopped)` commands the workspace's own session card already sends. One note
 * field serves both: pausing carries it onto `sessions.result_note` ("put in what came up"), and it is what the paused state then displays back.
 */
export function DeliverableSessionPanel({
  session,
  state,
  now,
  timezone,
  saving,
  secondsRemaining,
  sessionCheckpointReached,
  runActivityCommand
}: {
  session: ActiveSession;
  state: PortalState;
  now: Date;
  timezone: string;
  saving: boolean;
  secondsRemaining: number;
  sessionCheckpointReached: boolean;
  runActivityCommand: RunActivityCommand;
}) {
  const [note, setNote] = useState("");
  const atCheckpoint = sessionCheckpointReached || session.status === "feedback";
  async function pauseOrResume() {
    await runActivityCommand({
      commandId: createClientId(),
      expectedVersion: session.version ?? null,
      type: session.status === "paused" ? "resume_activity" : "pause_activity",
      sessionId: session.id,
      ...(session.status !== "paused" && note.trim() ? { note: note.trim() } : {})
    });
    setNote("");
  }
  async function stop() {
    await runActivityCommand({
      commandId: createClientId(),
      expectedVersion: session.version ?? null,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "stopped",
      ...(note.trim() ? { note: note.trim() } : {})
    });
    setNote("");
  }
  const deliverable = state.deliverables.find((item) => item.id === session.targetId);
  const step = deliverable?.steps.find((item) => item.id === session.stepId);
  // The unit this work belongs to. "Exercise G" alone says nothing about what it is part of.
  const project = deliverable ? state.projects.find((item) => item.id === deliverable.projectId) : undefined;
  return (
    <>
      <div className="status-row">
        <p className="eyebrow">
          {atCheckpoint
            ? "Checkpoint reached"
            : session.status === "paused"
              ? "Deliverable paused"
              : "Deliverable in progress"}
        </p>
        <time>{clock(now, timezone, true)}</time>
      </div>
      {project && <p className="area-label">{project.title}</p>}
      <h1>{deliverable?.title ?? session.targetTitle ?? "Deliverable"}</h1>
      <p className="time">
        {step
          ? `Current action: ${step.title}`
          : "No action chosen — this time is credited to no action. Choose one in the workspace."}
      </p>
      <p className={`countdown${secondsRemaining < 0 ? " overtime" : ""}`}>{formatRemaining(secondsRemaining)}</p>
      <p className="reason">
        {atCheckpoint
          ? "The protected work period has ended. Continue, finish the action, or stop for now in the workspace."
          : "Pause or stop here if something came up. Open the workspace for the action plan, blockers and finishing an action."}
      </p>
      {session.status === "paused" && session.note && <p className="reason">Paused: {session.note}</p>}
      {!atCheckpoint && session.status !== "paused" && (
        <label className="field">
          <span>Optional note — what came up</span>
          <input value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
      )}
      {!atCheckpoint && (
        <div className="actions">
          <button type="button" disabled={saving} onClick={() => void pauseOrResume()}>
            {session.status === "paused" ? "Resume" : "Pause"}
          </button>
        </div>
      )}
      {!atCheckpoint && session.status !== "paused" && (
        <div className="actions">
          <button type="button" className="quiet" disabled={saving} onClick={() => void stop()}>
            Stop — work remains
          </button>
        </div>
      )}
      <div className="actions">
        <a className="button-link" href={`/deliverables?deliverable=${encodeURIComponent(session.targetId ?? "")}`}>
          Open workspace
        </a>
      </div>
    </>
  );
}
