"use client";

import { mergeImportContextOptions } from "@/features/imports/import-contexts";

/**
 * Contexts arriving in an import are not always in the saved catalogue. They are still offered and
 * marked "from import", because refusing to show them would silently drop what the file asked for.
 */
export function ContextChoices({
  options,
  selected,
  disabled = false,
  onChange
}: {
  options: string[];
  selected: string[];
  disabled?: boolean;
  onChange: (contexts: string[]) => void;
}) {
  const choices = mergeImportContextOptions(options, selected);
  const selectedChips = (
    <div className="context-chips">
      {selected.length ? (
        selected.map((context) => (
          <span key={context}>
            {context}
            {!options.includes(context) && <small>from import</small>}
          </span>
        ))
      ) : (
        <em>None selected</em>
      )}
    </div>
  );
  if (disabled) return <div className="context-picker disabled">{selectedChips}</div>;
  return (
    <details className="context-picker">
      <summary>
        <span>{selected.length ? `${selected.length} selected` : "Choose contexts"}</span>
        {selectedChips}
      </summary>
      <div className="choice-list context-picker-options">
        {choices.map((context) => (
          <label key={context}>
            <input
              type="checkbox"
              checked={selected.includes(context)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...new Set([...selected, context])]
                    : selected.filter((item) => item !== context)
                )
              }
            />
            <span>
              {context}
              {!options.includes(context) && <small>from import</small>}
            </span>
          </label>
        ))}
      </div>
    </details>
  );
}
