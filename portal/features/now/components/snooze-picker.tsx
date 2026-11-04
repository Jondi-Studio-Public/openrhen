"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { dateOnly, nextDayKey } from "@/features/today/local-datetime";
import { formatZonedDate } from "@/shared/date-format";
import { canSnooze, snoozeOptions, snoozeRefusal, startOfLocalDay } from "@/features/now/snooze";
import styles from "./snooze-picker.module.css";

/**
 * "Put it off until ...": Later today, Tomorrow, Next week and Pick a date, each setting the action's
 * "available from" (never blocking it). A choice past the deadline or latest safe start is disabled
 * with the reason beside it, and a picked date past one is refused in words. One component serves the
 * Not now sheet on Now and the block sheet on Day, so the two cannot drift. Renders nothing for an
 * action that cannot be snoozed (a repeating series).
 */
export function SnoozePicker({
  action,
  timezone,
  now,
  disabled = false,
  onSnooze,
  onDone
}: {
  action: {
    schedulingMode?: string | undefined;
    occurrenceId?: string | undefined;
    externalDeadlineAt?: string | undefined;
    latestStartAt?: string | undefined;
    availableFrom?: string | undefined;
  };
  timezone: string;
  now: Date;
  disabled?: boolean;
  /** Receives the ISO instant to set as "available from". */
  onSnooze: (availableFrom: string) => Promise<void> | void;
  /** Called after a successful save, so the host can close its sheet. */
  onDone?: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [day, setDay] = useState("");
  const [error, setError] = useState("");
  if (!canSnooze(action)) return null;

  const options = snoozeOptions(now, timezone).map((option) => ({
    ...option,
    refusal: snoozeRefusal(action, option.at, timezone)
  }));
  const firstRefused = options.find((option) => option.refusal);
  const earliestDay = nextDayKey(dateOnly(now, timezone));

  async function choose(at: Date) {
    const refusal = snoozeRefusal(action, at, timezone);
    if (refusal) {
      setError(refusal);
      return;
    }
    setError("");
    try {
      await onSnooze(at.toISOString());
      onDone?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That was not saved.");
    }
  }

  return (
    <div className={styles.picker}>
      <div className={styles.chips} role="group" aria-label="Come back to it">
        {options.map((option) => (
          <Chip
            key={option.label}
            className={styles.chip}
            pressed={false}
            disabled={disabled || option.refusal !== null}
            title={option.refusal ?? `From ${formatZonedDate(option.at, timezone)}`}
            onClick={() => void choose(option.at)}
          >
            {option.label}
          </Chip>
        ))}
        <Chip
          className={styles.chip}
          pressed={picking}
          disabled={disabled}
          aria-expanded={picking}
          onClick={() => setPicking((open) => !open)}
        >
          Pick a date
        </Chip>
      </div>
      {firstRefused?.refusal ? (
        <p className={styles.note}>
          {firstRefused.label} is out:{" "}
          {firstRefused.refusal.replace(/^That is /, "it is ").replace(/^It is /, "it is ")}
        </p>
      ) : null}
      {picking ? (
        <div className={styles.pick}>
          <label className={styles.field}>
            <span>Come back on</span>
            <input
              type="date"
              min={earliestDay}
              value={day}
              disabled={disabled}
              onChange={(event) => setDay(event.target.value)}
            />
          </label>
          <Button
            variant="secondary"
            size="md"
            disabled={disabled || !day}
            onClick={() => void choose(startOfLocalDay(day, timezone))}
          >
            Set date
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
