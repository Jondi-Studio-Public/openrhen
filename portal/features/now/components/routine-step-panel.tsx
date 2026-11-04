"use client";

import { routineStepEntity } from "@/features/commitments/routine-step-save";
import { createClientId } from "@/shared/client-id";
import type { PortalState, StoredRoutineStep } from "@/state/portal-state";
import { clock, dayClock, localDate } from "@/features/now/now-formatting";
import type { RunActivityCommand, SaveEntityCommand } from "@/features/now/now-model";

/** A preparation step the engine scheduled ahead of a commitment, offered at the moment it is due. */
export function RoutineStepPanel({
  routineDue,
  state,
  now,
  timezone,
  saving,
  runActivityCommand,
  saveEntityCommand
}: {
  routineDue: StoredRoutineStep;
  state: PortalState;
  now: Date;
  timezone: string;
  saving: boolean;
  runActivityCommand: RunActivityCommand;
  saveEntityCommand: SaveEntityCommand;
}) {
  const commitment = state.commitments.find((item) => item.id === routineDue.commitmentId);
  return (
    <>
      <p className="time">{routineDue.durationMinutes} minutes</p>
      <p className="reason">
        Required for{" "}
        {commitment ? (
          <a href={`/commitments/${encodeURIComponent(commitment.id)}`}>{commitment.title}</a>
        ) : (
          "an upcoming commitment"
        )}{" "}
        at{" "}
        {commitment && localDate(new Date(commitment.startsAt), timezone) !== localDate(now, timezone)
          ? dayClock(commitment.startsAt, timezone)
          : clock(new Date(commitment?.startsAt ?? now), timezone)}
        .
      </p>
      <div className="actions">
        <button
          disabled={saving}
          onClick={() =>
            void runActivityCommand({
              commandId: createClientId(),
              expectedVersion: routineDue.version ?? null,
              type: "start_activity",
              targetType: "routine_step",
              targetId: routineDue.id,
              plannedMinutes: routineDue.durationMinutes
            })
          }
        >
          Start preparation
        </button>
        <button
          type="button"
          className="quiet"
          disabled={saving}
          onClick={() =>
            void saveEntityCommand({
              commandId: createClientId(),
              expectedVersion: routineDue.version ?? null,
              type: "save_entity",
              entityType: "routine_step",
              entity: routineStepEntity(routineDue, { status: "skipped" })
            })
          }
        >
          Skip
        </button>
      </div>
    </>
  );
}
