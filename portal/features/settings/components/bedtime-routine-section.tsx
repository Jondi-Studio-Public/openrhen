"use client";

import { Field } from "@/components/field";
import { Section } from "@/features/settings/components/settings-fields";
import type { RoutinePreset } from "@/state/portal-state";

export function BedtimeRoutineSection({
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
      id="bedtime-routine"
      title="Bedtime routine"
      reason="A linked routine is scheduled immediately before each planned sleep block."
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
      </Field>
    </Section>
  );
}
