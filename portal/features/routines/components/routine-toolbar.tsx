"use client";

import type { ReactNode } from "react";
import type { RoutinePresetDraft } from "@/features/routines/routine-editor";

/** Naming, the status (archiving is its own button) and the two ways to grow the board, above the canvas itself. */
export function RoutineToolbar({
  name,
  status,
  saving,
  dirty,
  onNameChange,
  onAddStep,
  closeControl
}: {
  name: string;
  status: RoutinePresetDraft["status"];
  saving: boolean;
  dirty: boolean;
  onNameChange: (name: string) => void;
  onAddStep: (phase: "before" | "after") => void;
  /** The Archive / Restore control of a routine that exists. */
  closeControl?: ReactNode;
}) {
  return (
    <header className="routine-toolbar">
      <label>
        <span>Routine name</span>
        <input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Campus morning" />
        <small>Use normal spaces. Technical IDs are generated automatically.</small>
      </label>
      <div className="field">
        <span>Status</span>
        <span className="field-value">{status === "archived" ? "Archived" : "Active"}</span>
        {closeControl}
      </div>
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
