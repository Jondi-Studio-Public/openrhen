"use client";

import { useState } from "react";
import type { PlanningEntityCommand } from "@openrhen/contracts";
import type { StoredCommitment } from "@/state/portal-state";
import { freeCommitmentCommand } from "@/features/now/free-commitment";

/**
 * "I'm free" beside a commitment that still reads as holding the clock. Pressing it releases the rest of the
 * commitment to the planner without ending it; the card keeps its old words until the recalculation lands, so
 * once the statement is stored it says that, with the way back, instead of offering the button again.
 */
export function FreeControl({
  commitment,
  awaitingRecalculation,
  saving,
  saveEntityCommand
}: {
  commitment: StoredCommitment;
  awaitingRecalculation: boolean;
  saving: boolean;
  saveEntityCommand: (command: PlanningEntityCommand) => Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  async function send(free: boolean) {
    setWorking(true);
    setError("");
    try {
      await saveEntityCommand(freeCommitmentCommand(commitment, free));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not save. Try again.");
    } finally {
      setWorking(false);
    }
  }
  if (commitment.freedFrom) {
    return (
      <>
        <p className="microcopy" role="status">
          You’re free of {commitment.title}.{" "}
          {awaitingRecalculation
            ? "Working out what’s next…"
            : "The plan is catching up; what’s next will show here in a moment."}
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button type="button" className="quiet small" disabled={saving || working} onClick={() => void send(false)}>
            Undo — I’m still in it
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button type="button" className="quiet" disabled={saving || working} onClick={() => void send(true)}>
          I’m free
        </button>
      </div>
    </>
  );
}
