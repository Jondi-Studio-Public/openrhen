"use client";

import { Section } from "@/features/settings/components/settings-fields";
import type { RoutinePreset } from "@/state/portal-state";

/** How many preset names the summary names outright before it counts the rest. */
const NAMED_PRESETS = 6;

/**
 * Routines keep their own page: the board is too large to sit inside the settings form, so this
 * section only says what has been saved and opens the builder.
 */
export function RoutinesSummarySection({
  presetId,
  wakePresetId,
  routinePresets
}: {
  presetId: string | undefined;
  wakePresetId: string | undefined;
  routinePresets: RoutinePreset[];
}) {
  const bedtime = routinePresets.find((preset) => preset.id === presetId);
  const wake = routinePresets.find((preset) => preset.id === wakePresetId);
  const named = routinePresets.slice(0, NAMED_PRESETS);
  const remaining = routinePresets.length - named.length;
  return (
    <Section id="routines" title="Routines" reason="Routines are built and saved on their own page.">
      <div className="routines-summary">
        <p>
          {routinePresets.length === 0
            ? "No routines saved yet."
            : `${routinePresets.length} ${routinePresets.length === 1 ? "routine" : "routines"} saved.`}{" "}
          Bedtime routine: <strong>{bedtime ? bedtime.name : "none chosen"}</strong>. Wake routine:{" "}
          <strong>{wake ? wake.name : "none chosen"}</strong>.
        </p>
        {named.length > 0 && (
          <ul>
            {named.map((preset) => (
              <li key={preset.id}>{preset.name}</li>
            ))}
            {remaining > 0 && <li>+{remaining} more</li>}
          </ul>
        )}
        <a className="primary-link" href="/settings/routines">
          Open routine builder
        </a>
      </div>
    </Section>
  );
}
