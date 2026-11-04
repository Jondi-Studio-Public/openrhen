"use client";

import { useId } from "react";
import { Chip } from "@/components/ui/chip";
import { clock } from "@/features/now/now-formatting";
import { dateInput, iso } from "@/features/today/local-datetime";
import styles from "../session-logging.module.css";

/** How early the work really began: so many minutes ago, or a moment the person typed. */
export type StartedEarlierChoice = { kind: "ago"; minutes: number } | { kind: "at"; value: string };

const AGO_CHOICES = [10, 30] as const;
/** The server refuses a start more than 24 hours back. */
const LIMIT_MINUTES = 24 * 60;

/** The ISO moment a choice names, read against `now`; undefined while nothing usable is chosen. */
export function startedAtFor(choice: StartedEarlierChoice | null, now: Date, timezone: string): string | undefined {
  if (!choice) return undefined;
  if (choice.kind === "ago") return new Date(now.getTime() - choice.minutes * 60_000).toISOString();
  return choice.value ? iso(choice.value, timezone) : undefined;
}

/** The server allows a start up to five minutes ahead of its clock. */
const FUTURE_GRACE_MS = 5 * 60_000;

/** Why the choice cannot be sent, in plain words, or null when it can. Nothing chosen is fine. */
export function startedEarlierProblem(
  choice: StartedEarlierChoice | null,
  now: Date,
  timezone: string,
  floor?: Date | null,
  /** The start already made, when moving one: the new time must be earlier, or work is dropped. */
  before?: Date
): string | null {
  const at = startedAtFor(choice, now, timezone);
  if (!at) return null;
  const moment = new Date(at).getTime();
  if (moment > now.getTime() + FUTURE_GRACE_MS) return "That time is still ahead.";
  if (moment < now.getTime() - LIMIT_MINUTES * 60_000) return "That is more than 24 hours ago.";
  if (before && moment >= before.getTime()) return `That is not earlier than the start at ${clock(before, timezone)}.`;
  if (floor && moment < floor.getTime())
    return `That is before ${clock(floor, timezone)}, when you woke or your last session ended.`;
  return null;
}

/**
 * The earliest moment the picker may offer, to the next whole minute: the field has no seconds, so a
 * floor of 09:30:45 must start at 09:31 or the picker would allow a time the check then refuses.
 * An unusable floor is ignored.
 */
function earliestMinute(now: Date, floor?: Date | null): number {
  const limit = now.getTime() - LIMIT_MINUTES * 60_000;
  const floorMs = floor?.getTime();
  const later = floorMs !== undefined && Number.isFinite(floorMs) ? Math.max(limit, floorMs) : limit;
  return Math.ceil(later / 60_000) * 60_000;
}

/** "Start from 9:50" when a time is chosen, otherwise plain "Start". */
export function startLabel(startedAt: string | undefined, timezone: string): string {
  return startedAt ? `Start from ${clock(new Date(startedAt), timezone)}` : "Start";
}

/**
 * "Started earlier?": for work that began before Start was tapped. Ten or thirty minutes ago, or a
 * time to pick. Nothing chosen means now. Pressing the chosen chip again clears it.
 */
export function StartedEarlier({
  choice,
  onChange,
  now,
  timezone,
  before,
  floor
}: {
  choice: StartedEarlierChoice | null;
  onChange: (choice: StartedEarlierChoice | null) => void;
  now: Date;
  timezone: string;
  /** Only moments earlier than this are offered, as when moving the start of a session already running. */
  before?: Date | undefined;
  /** Chips that would land before this are disabled: the server would refuse them. */
  floor?: Date | null | undefined;
}) {
  const labelId = useId();
  const problem = startedEarlierProblem(choice, now, timezone, floor, before);
  const offered = AGO_CHOICES.filter(
    (minutes) => !before || now.getTime() - minutes * 60_000 < before.getTime() - 60_000
  );
  const picking = choice?.kind === "at";
  const blocked = (minutes: number) => Boolean(floor) && now.getTime() - minutes * 60_000 < floor!.getTime();
  // A greyed chip with no reason reads as broken: say how far back the start may go.
  const anyBlocked = offered.some(blocked);
  return (
    <div className={styles.earlier}>
      <div className={styles.earlierRow} role="group" aria-labelledby={labelId}>
        <span id={labelId} className={styles.earlierLabel}>
          Started earlier?
        </span>
        {offered.map((minutes) => {
          const pressed = choice?.kind === "ago" && choice.minutes === minutes;
          return (
            <Chip
              key={minutes}
              pressed={pressed}
              disabled={blocked(minutes)}
              onClick={() => onChange(pressed ? null : { kind: "ago", minutes })}
            >
              {minutes} min ago
            </Chip>
          );
        })}
        <Chip pressed={picking} onClick={() => onChange(picking ? null : { kind: "at", value: "" })}>
          Pick a time
        </Chip>
      </div>
      {anyBlocked && floor ? (
        <p className={styles.earlierHint}>Earliest: {clock(floor, timezone)} (you woke or your last session ended)</p>
      ) : null}
      {choice?.kind === "at" ? (
        <label className={styles.earlierField}>
          <span>It started at</span>
          <input
            type="datetime-local"
            value={choice.value}
            min={dateInput(new Date(earliestMinute(now, floor)).toISOString(), timezone)}
            max={dateInput(before ? before.toISOString() : now.toISOString(), timezone)}
            onChange={(event) => onChange({ kind: "at", value: event.target.value })}
          />
        </label>
      ) : null}
      {problem ? (
        <p className={styles.earlierProblem} role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
