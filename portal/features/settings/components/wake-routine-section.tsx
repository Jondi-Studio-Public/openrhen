"use client";

import { Field } from "@/components/field";
import { Section } from "@/features/settings/components/settings-fields";
import type { RoutinePreset } from "@/state/portal-state";

export function WakeRoutineSection({
  presetId,
  routinePresets,
  onChange
}: {
  presetId: string | undefined;
  routinePresets: RoutinePreset[];
  onChange: (presetId: string | undefined) => void;
}) {
  return (
    <Section
      id="wake-routine"
      title="Wake routine"
      reason="A linked routine is scheduled immediately after each recorded wake."
    >
      <Field label="Routine" wide>
        <select value={presetId ?? ""} onChange={(event) => onChange(event.target.value || undefined)}>
          <option value="">None</option>
          {routinePresets
            .filter((item) => item.status === "active" || item.id === presetId)
            .map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
        </select>
        <small>Timed from your planned wake; pressing I’m awake re-times it from when you actually woke.</small>
      </Field>
    </Section>
  );
}
