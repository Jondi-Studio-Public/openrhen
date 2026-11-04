"use client";

import { Field } from "@/components/field";
import { CHECK_IN_ALLOWANCE_DEFAULT_LABEL, CHECK_IN_ALLOWANCE_MAX } from "../pulse-view";

/**
 * "Check-in allowance" on a commitment or a repeating rule: how much
 * longer the plan waits for an answer before it calls you off plan while this is in force. The default is +15 minutes;
 * a custom number of minutes (0 for none) replaces it. `null` is the default, and is what saving sends to restore it.
 */
export function CheckInAllowanceField({
  value,
  onChange
}: {
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const custom = value !== null;
  return (
    <Field label="Check-in allowance" wide>
      <select
        value={custom ? "custom" : "default"}
        onChange={(event) => onChange(event.target.value === "custom" ? (value ?? 30) : null)}
      >
        <option value="default">{CHECK_IN_ALLOWANCE_DEFAULT_LABEL}</option>
        <option value="custom">Custom</option>
      </select>
      {custom && (
        <input
          type="number"
          min={0}
          max={CHECK_IN_ALLOWANCE_MAX}
          step={1}
          aria-label="Check-in allowance in minutes"
          value={value}
          onChange={(event) => {
            // An empty box is "use the default", not a custom 0.
            if (event.target.value.trim() === "") return onChange(null);
            const minutes = Math.floor(Number(event.target.value));
            onChange(Number.isFinite(minutes) ? Math.min(CHECK_IN_ALLOWANCE_MAX, Math.max(0, minutes)) : null);
          }}
        />
      )}
      <small>Extra minutes before a missed check-in counts against you while this is on.</small>
    </Field>
  );
}
