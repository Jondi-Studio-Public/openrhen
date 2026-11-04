"use client";

import type { TimeBand } from "@openrhen/contracts";
import type { RoutinePresetStep } from "@/state/portal-state";

/**
 * The routine-step-timing fields shared by the preset editor's tile and the one-off editor: hands-on
 * time, the wait after it, when it must start by, and — for a flexible step ahead of the commitment —
 * how early it can start and which time bands it prefers. Both callers own the rest of their tile
 * editor (name, energy, dependencies, contexts); this is only the timing half.
 */
export function RoutineStepTimingFields({
  step,
  patch,
  timeBands
}: {
  step: RoutinePresetStep;
  patch: (change: Partial<RoutinePresetStep>) => void;
  timeBands: TimeBand[];
}) {
  return (
    <>
      <div className="tile-field-grid">
        <label>
          <span>Hands-on</span>
          <input
            disabled={Boolean(step.actionWindowId)}
            type="number"
            min="1"
            value={step.durationMinutes}
            onChange={(event) => patch({ durationMinutes: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>Then wait</span>
          <input
            type="number"
            min="0"
            value={step.waitAfterMinutes ?? 0}
            onChange={(event) => patch({ waitAfterMinutes: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>
            Must start by {step.phase !== "after" ? "(at least N min before it starts)" : "(within N min of it ending)"}
          </span>
          <input
            type="number"
            min="1"
            value={step.mustStartByMinutes ?? ""}
            onChange={(event) => {
              const value = Number(event.target.value);
              patch({ mustStartByMinutes: event.target.value === "" || value === 0 ? undefined : value });
            }}
          />
        </label>
        <label>
          <span>Timing</span>
          <select
            value={step.timingRule}
            onChange={(event) => patch({ timingRule: event.target.value as RoutinePresetStep["timingRule"] })}
          >
            <option value="contiguous">Directly before</option>
            <option value="flexible">Within lead window</option>
          </select>
        </label>
        {step.timingRule === "flexible" && (
          <label>
            <span>Earliest</span>
            <input
              type="number"
              min="1"
              value={step.maxLeadMinutes ?? 60}
              onChange={(event) => patch({ maxLeadMinutes: Number(event.target.value) })}
            />
          </label>
        )}
      </div>
      {step.timingRule === "flexible" && step.phase !== "after" && (
        <fieldset>
          <legend>Preferred time bands</legend>
          {timeBands.map((band) => (
            <label className="dependency-choice" key={band.id}>
              <input
                type="checkbox"
                checked={(step.preferredBands ?? []).includes(band.id)}
                onChange={(event) =>
                  patch({
                    preferredBands: event.target.checked
                      ? [...(step.preferredBands ?? []), band.id]
                      : (step.preferredBands ?? []).filter((id) => id !== band.id)
                  })
                }
              />
              <span>{band.name}</span>
            </label>
          ))}
          {!timeBands.length && <small>No time bands defined yet.</small>}
        </fieldset>
      )}
    </>
  );
}
