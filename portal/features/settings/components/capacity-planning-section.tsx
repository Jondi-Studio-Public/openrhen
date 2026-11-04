"use client";

import { Field } from "@/components/field";
import { PercentInput, Section } from "@/features/settings/components/settings-fields";
import type { PlanningSettings } from "@/state/portal-state";

export function CapacityPlanningSection({
  draft,
  onChange
}: {
  draft: PlanningSettings;
  onChange: (patch: Partial<PlanningSettings>) => void;
}) {
  return (
    <Section
      id="capacity-planning"
      title="Capacity planning"
      reason="How much of your automatically calculated free time counts as usable."
    >
      <Field label="Usable free time">
        <PercentInput
          value={draft.defaultUsableFraction}
          onChange={(value) => onChange({ defaultUsableFraction: value })}
        />
        <small>Around 75–85% leaves room for calls, small delays, breaks, and ordinary tasks.</small>
      </Field>
    </Section>
  );
}
