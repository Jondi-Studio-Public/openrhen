"use client";

import { Field } from "@/components/field";
import { Section } from "@/features/settings/components/settings-fields";

export function EstimateBucketsSection({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Section id="estimate-buckets" title="Estimate buckets" reason="Quick choices used when estimating new work.">
      <Field label="Minutes, smallest to largest" wide>
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="5, 15, 30, 60, 90, 120" />
      </Field>
    </Section>
  );
}
