"use client";

import type { RoutinePresetDraft } from "@/features/routines/routine-editor";

/** Naming, archiving and the two ways to grow the board, above the canvas itself. */
export function RoutineToolbar({
  name,
  status,
  saving,
  dirty,
  onNameChange,
  onStatusChange,
  onAddStep
}: {
  name: string;
  status: RoutinePresetDraft["status"];
  saving: boolean;
  dirty: boolean;
  onNameChange: (name: string) => void;
  onStatusChange: (status: RoutinePresetDraft["status"]) => void;
  onAddStep: (phase: "before" | "after") => void;
}) {
  return (
    <header className="routine-toolbar">
      <label>
        <span>Routine name</span>
        <input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Campus morning" />
        <small>Use normal spaces. Technical IDs are generated automatically.</small>
      </label>
      <label>
        <span>Status</span>
        <select value={status} onChange={(event) => onStatusChange(event.target.value as RoutinePresetDraft["status"])}>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
        </select>
      </label>
      <div className="toolbar-actions">
        <button type="button" className="quiet" onClick={() => onAddStep("before")}>
          Add tile
        </button>
        <button type="button" className="quiet" onClick={() => onAddStep("after")}>
          Add step after
        </button>
        <button disabled={saving || !dirty}>{saving ? "Saving…" : "Save routine"}</button>
      </div>
    </header>
  );
}
