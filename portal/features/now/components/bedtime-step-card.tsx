"use client";

import { useState } from "react";
import { createClientId } from "@/shared/client-id";
import type { StoredRoutineStep } from "@/state/portal-state";
import type { RunActivityCommand } from "@/features/now/now-model";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import styles from "./bedtime-step-card.module.css";

/**
 * The next unfinished step of a bedtime or wake routine: start it, or skip it and move the routine
 * along. Shared by both — `label` names which one ("before sleep" / "after waking") since the rest
 * (Start/Skip against the step's own `routine_steps` row) is anchor-agnostic already; a
 * sleep-anchored step is started and skipped exactly like a commitment's own preparation step.
 *
 * The wake routine also passes `onDone` (a step that needs no timer is started and finished in one
 * tap), `position` ("Step 2 of 5"), `onSkipRest` and `nextTask` (the work waiting behind the routine).
 */
export function BedtimeStepCard({
  step,
  label,
  saving,
  runActivityCommand,
  showTitle = true,
  position,
  nextTask,
  onDone,
  onSkipRest
}: {
  step: StoredRoutineStep;
  label: string;
  saving: boolean;
  runActivityCommand: RunActivityCommand;
  /** False where the page headline already is the step's title (the wake routine), so it is not said twice. */
  showTitle?: boolean;
  /** Where this step sits in its routine, counted from 1. */
  position?: { index: number; total: number };
  /** The task that comes after the routine, shown as one line. */
  nextTask?: string | undefined;
  /** Starts and finishes the step in one go. Rejects when the server refuses either half. */
  onDone?: () => Promise<void>;
  /** Skips this step and every one after it. */
  onSkipRest?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmingSkipRest, setConfirmingSkipRest] = useState(false);
  const disabled = saving || busy;
  function run(action: () => Promise<void>) {
    setBusy(true);
    // A refusal is already on the provider's banner; do not also leave it unhandled.
    void action()
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }
  return (
    <Card padded className={styles.card}>
      <div className={styles.text}>
        {showTitle && <strong>{step.title}</strong>}
        <p className={styles.meta}>
          {position && position.total > 1 ? `Step ${position.index} of ${position.total} · ` : ""}
          {step.durationMinutes} min · {label}
        </p>
        {nextTask ? <p className={styles.next}>Next task: {nextTask}</p> : null}
      </div>
      <div className={styles.actions}>
        {onDone ? (
          <Button
            variant="primary"
            size="lg"
            className={styles.primary}
            disabled={disabled}
            onClick={() => run(onDone)}
          >
            Done
          </Button>
        ) : null}
        <Button
          variant={onDone ? "secondary" : "primary"}
          size={onDone ? "md" : "lg"}
          disabled={disabled}
          onClick={() =>
            void runActivityCommand({
              commandId: createClientId(),
              expectedVersion: step.version ?? null,
              type: "start_activity",
              targetType: "routine_step",
              targetId: step.id,
              plannedMinutes: step.durationMinutes
            })
          }
        >
          Start
        </Button>
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() =>
            void runActivityCommand({
              commandId: createClientId(),
              expectedVersion: step.version ?? null,
              type: "skip_routine_step",
              stepId: step.id
            })
          }
        >
          Skip this step
        </Button>
        {onSkipRest && position && position.index < position.total ? (
          confirmingSkipRest ? (
            <>
              <span className={styles.meta} role="status">
                Skip {position.total - position.index + 1} steps?
              </span>
              <Button
                variant="secondary"
                disabled={disabled}
                onClick={() => {
                  setConfirmingSkipRest(false);
                  run(onSkipRest);
                }}
              >
                Yes, skip them
              </Button>
              <Button variant="ghost" disabled={disabled} onClick={() => setConfirmingSkipRest(false)}>
                Keep them
              </Button>
            </>
          ) : (
            <Button variant="ghost" disabled={disabled} onClick={() => setConfirmingSkipRest(true)}>
              Skip the rest of the routine
            </Button>
          )
        ) : null}
      </div>
    </Card>
  );
}
