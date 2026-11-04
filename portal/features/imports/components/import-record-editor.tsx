"use client";

import { useState } from "react";
import { RoutineOneOffEditor } from "@/features/routines/components/routine-one-off-editor";
import { isCalendarImportRecord } from "@/features/imports/calendar-selection";
import { ImportRecordCard, type ImportRecordCardProps } from "./import-record-card";
import type { RoutinePresetStep } from "@/state/portal-state";

/**
 * A calendar record is selected rather than removed: the same `removed` flag, presented as a tick,
 * because "do not import this event" is what the user means when they untick one of their own events.
 */
export function ImportRecordEditor(props: ImportRecordCardProps) {
  const [editingRoutine, setEditingRoutine] = useState(false);
  const { record, routinePresets, patchRoutineSteps, conditionCatalog, timeBands } = props;
  const steps = record.relationships.routineSteps
    ? (JSON.parse(record.relationships.routineSteps) as RoutinePresetStep[])
    : [];
  const preset = routinePresets.find((item) => item.id === record.relationships.routinePresetId);
  const title = String(record.fields.title?.value ?? record.importKey);
  const calendar = isCalendarImportRecord(record);
  return (
    <div className={`import-record-wrapper${calendar ? " calendar-event-record" : ""}`}>
      {calendar && (
        <label className={`calendar-event-selector${record.removed ? "" : " selected"}`}>
          <input type="checkbox" checked={!record.removed} onChange={() => props.toggleRemoved(record.id)} />
          <span>
            <strong>{record.removed ? "Select event" : "Event selected"}</strong>
            <small>
              {record.removed
                ? "This event will not be imported."
                : "This event will be included when the batch is committed."}
            </small>
          </span>
        </label>
      )}
      <ImportRecordCard {...props} />
      {record.entityType === "fixed_commitment" && record.operation !== "delete" && steps.length > 0 && (
        <div className="routine-import-summary">
          <div>
            <strong>{preset?.name ?? "One-off preparation routine"}</strong>
            <span>
              {steps.length} tile{steps.length === 1 ? "" : "s"} selected · preset remains unchanged
            </span>
          </div>
          <button
            type="button"
            className="quiet small"
            disabled={record.removed}
            onClick={() => setEditingRoutine(true)}
          >
            Edit for this event
          </button>
        </div>
      )}
      {editingRoutine && (
        <RoutineOneOffEditor
          title={title}
          steps={steps}
          contexts={conditionCatalog}
          timeBands={timeBands}
          onClose={() => setEditingRoutine(false)}
          onSave={(next) => {
            patchRoutineSteps(record.id, next);
            setEditingRoutine(false);
          }}
        />
      )}
    </div>
  );
}
