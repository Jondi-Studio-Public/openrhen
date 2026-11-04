"use client";

import { completeStep, skipSteps } from "@/features/now/wake-commands";
import type { ActiveSession, StoredRoutineStep } from "@/state/portal-state";
import type { RunActivityCommand } from "@/features/now/now-model";
import { BedtimeStepCard } from "./bedtime-step-card";
import { BedtimeStepSessionCard } from "./bedtime-step-session-card";

/**
 * The wake routine's next unfinished step, right after a recorded wake — a separate moment in the
 * day from `SleepPanel`'s "upcoming bedtime tonight" (no countdown/live-seconds concern of its own
 * outside a step actually running), so it gets its own panel rather than a second branch bolted onto
 * that one. See the wake routine design note.
 */
export function WakeRoutinePanel({
  currentWakeStep,
  routineSteps = [],
  nextTask,
  recordedUpTo,
  clock = () => new Date(),
  stepSession,
  secondsRemaining,
  saving,
  runActivityCommand
}: {
  currentWakeStep: StoredRoutineStep | undefined;
  /** Every routine step in the portal state; the wake group is picked out of it for "Step 2 of 5". */
  routineSteps?: readonly StoredRoutineStep[];
  /** Title of the task waiting behind the routine, if the plan has one. */
  nextTask?: string | undefined;
  /** ISO time the record already covers (last session end or wake); Done's backfilled start stays after it. */
  recordedUpTo?: string | undefined;
  /** The server's clock as best the browser can tell; Done's backfilled start is judged against it. */
  clock?: () => Date;
  stepSession: ActiveSession | undefined;
  secondsRemaining: number;
  saving: boolean;
  runActivityCommand: RunActivityCommand;
}) {
  if (!currentWakeStep) return null;
  // `stepSession` is shared with `SleepPanel` and only says "a sleep-anchored step is running
  // somewhere" (`now-model.ts`) — checked against this panel's own current step so a
  // still-open bedtime session from the same tab never renders here as the wake routine's own.
  if (stepSession && stepSession.targetId === currentWakeStep.id) {
    return (
      <BedtimeStepSessionCard
        stepSession={stepSession}
        secondsRemaining={secondsRemaining}
        saving={saving}
        runActivityCommand={runActivityCommand}
      />
    );
  }
  const group = wakeRoutineGroup(routineSteps, currentWakeStep);
  const index = group.findIndex((step) => step.id === currentWakeStep.id);
  return (
    <BedtimeStepCard
      step={currentWakeStep}
      label="after waking"
      saving={saving}
      runActivityCommand={runActivityCommand}
      showTitle={false}
      position={{ index: index + 1, total: group.length }}
      nextTask={nextTask}
      onDone={() => completeStep(currentWakeStep, runActivityCommand, recordedUpTo, clock())}
      onSkipRest={() => skipSteps(group.slice(index), runActivityCommand)}
    />
  );
}

/** The wake routine the current step belongs to, in order, without steps that were cancelled. */
export function wakeRoutineGroup(steps: readonly StoredRoutineStep[], current: StoredRoutineStep): StoredRoutineStep[] {
  const group = steps
    .filter(
      (step) =>
        step.anchorType === current.anchorType &&
        step.anchorId === current.anchorId &&
        step.purpose === current.purpose &&
        step.status !== "cancelled"
    )
    .sort((a, b) => a.sequence - b.sequence);
  return group.some((step) => step.id === current.id) ? group : [current];
}
