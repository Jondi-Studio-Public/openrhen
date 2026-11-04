"use client";

import { Field } from "@/components/field";
import { Section } from "@/features/settings/components/settings-fields";
import type { PlanningSettings } from "@/state/portal-state";

const DEFAULT_START = "18:00";
const DEFAULT_END = "19:00";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Settings → Planning → Recovery time: a window (overnight when it ends at or before its start) on
 * chosen weekdays that ordinary work is never planned inside. Off is both times null.
 */
export function RecoverySection({
  draft,
  onChange
}: {
  draft: PlanningSettings;
  onChange: (patch: Partial<PlanningSettings>) => void;
}) {
  const enabled = draft.recoveryStartTime !== null && draft.recoveryEndTime !== null;
  const toggleDay = (day: number) => {
    const has = draft.recoveryWeekdays.includes(day);
    // At least one weekday must stay chosen, so the last one cannot be switched off.
    if (has && draft.recoveryWeekdays.length === 1) return;
    onChange({
      recoveryWeekdays: has
        ? draft.recoveryWeekdays.filter((value) => value !== day)
        : [...draft.recoveryWeekdays, day].sort((a, b) => a - b)
    });
  };
  return (
    <Section id="recovery-time" title="Recovery time" reason="A daily window kept clear of planned work.">
      <Field label="Protect recovery time">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? { recoveryStartTime: DEFAULT_START, recoveryEndTime: DEFAULT_END }
                : { recoveryStartTime: null, recoveryEndTime: null }
            )
          }
        />
      </Field>
      {enabled && (
        <>
          <Field label="Recovery starts">
            <input
              type="time"
              step={900}
              value={draft.recoveryStartTime ?? DEFAULT_START}
              onChange={(event) => onChange({ recoveryStartTime: event.target.value || null })}
            />
          </Field>
          <Field label="Recovery ends">
            <input
              type="time"
              step={900}
              value={draft.recoveryEndTime ?? DEFAULT_END}
              onChange={(event) => onChange({ recoveryEndTime: event.target.value || null })}
            />
          </Field>
          <Field label="Days" group wide>
            {WEEKDAYS.map((name, day) => (
              <label className="checkbox-row" key={name}>
                <input type="checkbox" checked={draft.recoveryWeekdays.includes(day)} onChange={() => toggleDay(day)} />
                {name}
              </label>
            ))}
          </Field>
        </>
      )}
      <p className="microcopy">
        Work is never planned inside this time. Commitments and sleep take precedence, and you can skip it for one day
        from Now.
      </p>
    </Section>
  );
}
