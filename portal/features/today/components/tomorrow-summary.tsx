"use client";

import type { TomorrowBrief } from "@/features/today/tomorrow-preview";
import { formatZonedTime } from "@/shared/date-format";
import { Badge } from "@/components/ui/badge";
import styles from "./tomorrow-summary.module.css";

/**
 * What a glance at tomorrow is for, written above tomorrow's canvas: when the night ends, what is
 * fixed first, how much lands, and whether any of it is somewhere else. Every line is a stated fact
 * clipped to that day — the day plan's own selector decides when it is on screen, and the timeline
 * below it is the same one today uses, drawn with no now-line because now is not on that day.
 */
export function TomorrowSummary({ brief, timezone }: { brief: TomorrowBrief; timezone: string }) {
  const time = (value: Date) => formatZonedTime(value, timezone);
  const chips: string[] = [];
  if (brief.commitments > 0) chips.push(plural(brief.commitments, "commitment"));
  if (brief.preparationSteps > 0) chips.push(plural(brief.preparationSteps, "preparation step"));
  if (brief.occurrences > 0) chips.push(plural(brief.occurrences, "recurring window"));
  if (brief.travel) chips.push(`Travel to ${brief.travel.places.join(", ")}`);

  return (
    <div className={styles.brief}>
      <p>
        {brief.sleep
          ? brief.sleep.startsBeforeDay
            ? `Sleep from ${time(brief.sleep.startsAt)} tonight, planned wake ${time(brief.sleep.wakeAt)} · ${hoursLabel(brief.sleep.minutes)}`
            : `Sleep ${time(brief.sleep.startsAt)} to ${time(brief.sleep.wakeAt)} · ${hoursLabel(brief.sleep.minutes)}`
          : "No sleep plan reaches tomorrow morning yet."}
      </p>
      <p>
        {brief.firstCommitment
          ? brief.firstCommitment.startsBeforeDay
            ? `First: ${brief.firstCommitment.title}, already under way from ${time(brief.firstCommitment.startsAt)}`
            : `First: ${brief.firstCommitment.title} at ${time(brief.firstCommitment.startsAt)}`
          : "Nothing fixed tomorrow."}
      </p>
      {chips.length > 0 && (
        <ul className={styles.chips} aria-label="What lands tomorrow">
          {chips.map((chip) => (
            <li key={chip}>
              <Badge tone="accent" dot={false}>
                {chip}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** One decimal place, and no trailing ".0": eight and a half hours is "8.5h", eight is "8h". */
const hoursLabel = (minutes: number) => `${Math.round(minutes / 6) / 10}h`;
