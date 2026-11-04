"use client";

import { isClosedStatus } from "@openrhen/contracts";
import { Field } from "./field";
import { statusOption } from "./status-option";

/**
 * An editor's Status control. It offers only the statuses a person sets by hand: closing is its own Archive or Cancel
 * button, so no editor lists `archived` or `cancelled`. A row that is already closed shows its status as text (the
 * Restore button beside it is how it comes back), because a select cannot show a value it does not list and a save
 * must keep the stored closed status as it is.
 */
export function StatusField({
  value,
  options,
  onChange,
  labelOf
}: {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  /** How an option reads, where it is not the stored word spelled out (the commitment form capitalises them). */
  labelOf?: (value: string) => string;
}) {
  if (isClosedStatus(value))
    return (
      <Field label="Status">
        <span className="field-value">{value}</span>
      </Field>
    );
  return (
    <Field label="Status">
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {labelOf
          ? options.map((option) => (
              <option value={option} key={option}>
                {labelOf(option)}
              </option>
            ))
          : options.map(statusOption)}
      </select>
    </Field>
  );
}
