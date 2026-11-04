"use client";

import { Field } from "@/components/field";
import { HourInput, Section } from "@/features/settings/components/settings-fields";
import { dateInput, iso } from "@/features/today/local-datetime";
import { useNow } from "@/shared/clock";
import type { PlanningSettings } from "@/state/portal-state";

export function SleepAndTimeSection({
  draft,
  onChange
}: {
  draft: PlanningSettings;
  onChange: (patch: Partial<PlanningSettings>) => void;
}) {
  const now = useNow("minute");
  return (
    <Section
      id="sleep-and-time"
      featured
      title="Times and limits"
      reason="When you like to sleep and wake, and the limits the planner never breaks."
    >
      <Field label="Preferred bedtime">
        <input
          type="time"
          value={draft.preferredBedtime}
          onChange={(event) => onChange({ preferredBedtime: event.target.value })}
        />
      </Field>
      <Field label="Preferred wake time">
        <input
          type="time"
          value={draft.preferredWakeTime}
          onChange={(event) => onChange({ preferredWakeTime: event.target.value })}
        />
      </Field>
      <Field label="Desired sleep (hours)">
        <HourInput value={draft.desiredSleepMinutes} onChange={(value) => onChange({ desiredSleepMinutes: value })} />
      </Field>
      <Field label="Absolute minimum sleep (hours)">
        <HourInput value={draft.minimumSleepMinutes} onChange={(value) => onChange({ minimumSleepMinutes: value })} />
      </Field>
      <Field label="Maximum awake hours">
        <input
          type="number"
          min="8"
          max="36"
          value={draft.maxAwakeHours}
          onChange={(event) => onChange({ maxAwakeHours: Number(event.target.value) })}
        />
        <small>The hard maximum between waking and starting the next sleep.</small>
      </Field>
      <Field label="Bedtime deviation (minutes)">
        <input
          type="number"
          min="0"
          max="720"
          value={draft.bedtimeDeviationMinutes}
          onChange={(event) => onChange({ bedtimeDeviationMinutes: Number(event.target.value) })}
        />
        <small>
          Sleep is a wall: the engine never shortens a night to make room for work. When the fullest night starts more
          than this many minutes before your preferred bedtime, it warns you and offers the nearer night instead — you
          choose which to keep.
        </small>
      </Field>
      <Field label="When did you last wake?" wide>
        <input
          type="datetime-local"
          value={dateInput(draft.lastWokeAt, draft.timezone)}
          max={dateInput(now.toISOString(), draft.timezone)}
          onChange={(event) =>
            onChange({ lastWokeAt: event.target.value ? iso(event.target.value, draft.timezone) : undefined })
          }
        />
        <small>
          This grounds the maximum-awake calculation until a recorded sleep session supplies the next wake time.
        </small>
      </Field>
      <p className="microcopy field wide settings-pointer">
        To add or correct a night you already slept, open <a href="/sleep">Sleep</a>.
      </p>
    </Section>
  );
}
