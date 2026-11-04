"use client";

import type { ImportRecord } from "@openrhen/contracts";
import { Field } from "@/components/field";
import { ContextChoices } from "./context-choices";
import type { PortalState } from "@/state/portal-state";

type PreviewStep = {
  id?: string;
  title: string;
  durationMinutes: number;
  timingRule: string;
  maxLeadMinutes?: number;
  energy: string;
  contexts: string[];
};

/**
 * A commitment can arrive with the preparation it needs. The steps are edited here as a copy carried
 * on the record, so changing them never edits the saved preset the record was seeded from.
 */
export function ImportRecordRoutinePreview({
  record,
  conditionCatalog,
  routinePresets,
  selectRoutine,
  patchRoutineSteps
}: {
  record: ImportRecord;
  conditionCatalog: string[];
  routinePresets: PortalState["routinePresets"];
  selectRoutine: (id: string, value: string) => void;
  patchRoutineSteps: (id: string, steps: unknown[]) => void;
}) {
  const routineSteps = record.relationships.routineSteps
    ? (JSON.parse(record.relationships.routineSteps) as PreviewStep[])
    : [];
  return (
    <div className="routine-preview">
      <label className="field">
        <span>Preparation routine</span>
        <select
          value={record.relationships.routinePresetId ?? ""}
          onChange={(event) => selectRoutine(record.id, event.target.value)}
        >
          <option value="">None</option>
          {routinePresets
            .filter((item) => item.status === "active" || item.id === record.relationships.routinePresetId)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
      </label>
      {routineSteps.map((step, index) => (
        <div className="import-fields" key={step.id ?? index}>
          <label className="field">
            <span>Step {index + 1}</span>
            <input
              value={step.title}
              onChange={(event) =>
                patchRoutineSteps(
                  record.id,
                  routineSteps.map((item, position) =>
                    position === index ? { ...item, title: event.target.value } : item
                  )
                )
              }
            />
          </label>
          <label className="field">
            <span>Minutes</span>
            <input
              type="number"
              min="1"
              value={step.durationMinutes}
              onChange={(event) =>
                patchRoutineSteps(
                  record.id,
                  routineSteps.map((item, position) =>
                    position === index ? { ...item, durationMinutes: Number(event.target.value) } : item
                  )
                )
              }
            />
          </label>
          <Field label="Required contexts" group>
            <ContextChoices
              options={conditionCatalog}
              selected={step.contexts}
              onChange={(contexts) =>
                patchRoutineSteps(
                  record.id,
                  routineSteps.map((item, position) => (position === index ? { ...item, contexts } : item))
                )
              }
            />
          </Field>
          <button
            type="button"
            className="quiet small"
            onClick={() =>
              patchRoutineSteps(
                record.id,
                routineSteps.filter((_, position) => position !== index)
              )
            }
          >
            Remove step
          </button>
        </div>
      ))}
    </div>
  );
}
