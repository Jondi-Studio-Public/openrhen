"use client";

import { createClientId } from "@/shared/client-id";
import type { ActiveSession } from "@/state/portal-state";
import { formatRemaining } from "@/features/now/now-formatting";
import type { RunActivityCommand } from "@/features/now/now-model";

/** A bedtime routine step already running, shown inside the sleep panel with its own countdown. */
export function BedtimeStepSessionCard({
  stepSession,
  secondsRemaining,
  saving,
  runActivityCommand
}: {
  stepSession: ActiveSession;
  secondsRemaining: number;
  saving: boolean;
  runActivityCommand: RunActivityCommand;
}) {
  return (
    <div className="row-card">
      <div>
        <strong>{stepSession.targetTitle ?? "Bedtime routine step"}</strong>
        <p className={`countdown${secondsRemaining < 0 ? " overtime" : ""}`}>{formatRemaining(secondsRemaining)}</p>
      </div>
      <div className="actions">
        <button
          disabled={saving}
          onClick={() =>
            void runActivityCommand({
              commandId: createClientId(),
              expectedVersion: stepSession.version ?? null,
              type: stepSession.status === "paused" ? "resume_activity" : "pause_activity",
              sessionId: stepSession.id
            })
          }
        >
          {stepSession.status === "paused" ? "Resume" : "Pause"}
        </button>
        <button
          disabled={saving}
          onClick={() =>
            void runActivityCommand({
              commandId: createClientId(),
              expectedVersion: stepSession.version ?? null,
              type: "finish_activity",
              sessionId: stepSession.id,
              outcome: "completed"
            })
          }
        >
          Mark step done
        </button>
        <button
          className="quiet"
          disabled={saving}
          onClick={() =>
            void runActivityCommand({
              commandId: createClientId(),
              expectedVersion: stepSession.version ?? null,
              type: "finish_activity",
              sessionId: stepSession.id,
              outcome: "blocked",
              note: "Routine step could not continue."
            })
          }
        >
          Blocked
        </button>
        <button
          className="quiet"
          disabled={saving}
          onClick={() =>
            void runActivityCommand({
              commandId: createClientId(),
              expectedVersion: stepSession.version ?? null,
              type: "finish_activity",
              sessionId: stepSession.id,
              outcome: "did_not_start"
            })
          }
        >
          Did not start
        </button>
      </div>
    </div>
  );
}
