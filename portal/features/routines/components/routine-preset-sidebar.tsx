"use client";

import type { RoutinePreset } from "@/state/portal-state";

/** The saved-routine list, split into what is in use and what has been archived. */
export function RoutinePresetSidebar({
  presets,
  showArchived,
  archivedCount,
  openId,
  onShowArchivedChange,
  onOpen
}: {
  presets: RoutinePreset[];
  showArchived: boolean;
  archivedCount: number;
  openId: string | undefined;
  onShowArchivedChange: (showArchived: boolean) => void;
  onOpen: (preset: RoutinePreset) => void;
}) {
  return (
    <aside className="routine-sidebar" aria-label="Saved routines">
      <div className="section-heading">
        <h2>{showArchived ? "Archive" : "Routines"}</h2>
        <span>{presets.length}</span>
      </div>
      <div className="routine-view-tabs" role="group" aria-label="Routine views">
        <button type="button" className={!showArchived ? "active" : ""} onClick={() => onShowArchivedChange(false)}>
          Active
        </button>
        <button type="button" className={showArchived ? "active" : ""} onClick={() => onShowArchivedChange(true)}>
          Archive ({archivedCount})
        </button>
      </div>
      {presets.map((preset) => (
        <button
          type="button"
          className={`preset-choice${openId === preset.id ? " active" : ""}`}
          key={preset.id}
          onClick={() => onOpen(preset)}
        >
          <strong>{preset.name}</strong>
          <span>
            {preset.steps.length} tile{preset.steps.length === 1 ? "" : "s"}
            {showArchived ? " · archived" : ""}
          </span>
        </button>
      ))}
      {!presets.length && (
        <p className="empty">{showArchived ? "No archived routines." : "No active routines. Create one to begin."}</p>
      )}
    </aside>
  );
}
