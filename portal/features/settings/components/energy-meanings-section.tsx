"use client";

import { Field } from "@/components/field";
import { Section } from "@/features/settings/components/settings-fields";
import { energyLabel, energyLevels } from "@/features/settings/settings-format";
import type { EnergyLevel, PlanningSettings } from "@/state/portal-state";

export function EnergyMeaningsSection({
  meanings,
  onChange
}: {
  meanings: PlanningSettings["energyMeanings"];
  onChange: (level: EnergyLevel, value: string) => void;
}) {
  return (
    <Section id="energy-meanings" title="Energy meanings" reason="Your practical definition of each capacity level.">
      {energyLevels.map((level) => (
        <Field key={level} label={energyLabel(level)} wide>
          <input value={meanings[level]} onChange={(event) => onChange(level, event.target.value)} />
        </Field>
      ))}
    </Section>
  );
}
