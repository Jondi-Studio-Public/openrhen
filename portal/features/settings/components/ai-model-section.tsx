"use client";

import { useState } from "react";
import { Field } from "@/components/field";
import { Section } from "@/features/settings/components/settings-fields";
import type { PlanningSettings } from "@/state/portal-state";

/** Matches the private constructor default each of the three portal server consumers falls back to. */
export const DEFAULT_AI_MODEL = "gpt-5.6-sol";
const KNOWN_MODELS = [DEFAULT_AI_MODEL, "gpt-5", "gpt-5-mini"];
const CUSTOM = "custom";

function ModelPicker({
  label,
  reason,
  value,
  onChange
}: {
  label: string;
  reason: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const isKnownOrDefault = value === undefined || KNOWN_MODELS.includes(value);
  // A stored value outside the known list already means custom; picking "Custom…" from the dropdown
  // forces the same view even before any text is typed, and stays forced until another option is chosen.
  const [forcedCustom, setForcedCustom] = useState(false);
  const isCustom = forcedCustom || !isKnownOrDefault;
  const selectValue = isCustom ? CUSTOM : (value ?? "");
  return (
    <Field label={label} wide>
      <select
        value={selectValue}
        onChange={(event) => {
          const next = event.target.value;
          if (next === CUSTOM) {
            setForcedCustom(true);
            return;
          }
          setForcedCustom(false);
          onChange(next === "" ? undefined : next);
        }}
      >
        <option value="">{`Default (${DEFAULT_AI_MODEL})`}</option>
        {KNOWN_MODELS.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {isCustom && (
        <input
          aria-label={`Custom model id for ${label}`}
          value={isKnownOrDefault ? "" : (value ?? "")}
          placeholder="Model id"
          onChange={(event) => onChange(event.target.value || undefined)}
        />
      )}
      <small>{reason}</small>
    </Field>
  );
}

export function AiModelSection({
  draft,
  onChange
}: {
  draft: PlanningSettings;
  onChange: (patch: Partial<PlanningSettings>) => void;
}) {
  return (
    <Section
      id="ai-models"
      featured
      title="Models"
      reason="Every tool below calls OpenAI's Responses API through the outbound integrations sidecar. Leave a tool on Default to follow this deployment's built-in choice rather than pinning one."
    >
      <ModelPicker
        label="Deliverable workspace chat"
        reason="The phase-aware assistant inside a deliverable's Breakdown, Do the work and Review chat."
        value={draft.deliverableChatModel}
        onChange={(deliverableChatModel) => onChange({ deliverableChatModel })}
      />
      <ModelPicker
        label="Import extraction"
        reason="Reads a pasted brain dump, screenshot, or assignment into an editable import draft."
        value={draft.importExtractorModel}
        onChange={(importExtractorModel) => onChange({ importExtractorModel })}
      />
    </Section>
  );
}
