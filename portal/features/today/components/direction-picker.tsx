"use client";

import { useState } from "react";
import type { PortalState } from "@/state/portal-state";
import {
  directionActionOptions,
  directionActionPath,
  directionAreaOptions,
  directionOutcomeOptions,
  directionProjectOptions,
  emptyDirectionScope,
  normalizeDirectionScope,
  type DirectionScope
} from "@/features/today/direction-tree";

const maximumWins = 3;

/** Folder-style picker: choose how wide a slice of the plan to look at, then pick the action inside it. */
export function DirectionPicker({
  state,
  selected,
  onChange
}: {
  state: PortalState;
  selected: string[];
  onChange: (actionIds: string[]) => void;
}) {
  const [rawScope, setRawScope] = useState<DirectionScope>(emptyDirectionScope);
  const [actionId, setActionId] = useState("");
  const scope = normalizeDirectionScope(state, rawScope);
  const areas = directionAreaOptions(state);
  const outcomes = directionOutcomeOptions(state, scope);
  const projects = directionProjectOptions(state, scope);
  const actions = directionActionOptions(state, scope);
  const available = actions.filter((option) => !selected.includes(option.id));
  const full = selected.length >= maximumWins;

  function narrow(next: DirectionScope) {
    const normalized = normalizeDirectionScope(state, next);
    setRawScope(normalized);
    if (actionId && !directionActionOptions(state, normalized).some((option) => option.id === actionId))
      setActionId("");
  }

  function add() {
    if (!actionId || full || selected.includes(actionId)) return;
    onChange([...selected, actionId]);
    setActionId("");
  }

  return (
    <div className="direction-picker">
      <div className="direction-cascade">
        <label className="field">
          <span>Area</span>
          <select value={scope.areaId} onChange={(event) => narrow({ ...scope, areaId: event.target.value })}>
            <option value="">All areas</option>
            {areas.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Outcome</span>
          <select value={scope.outcomeId} onChange={(event) => narrow({ ...scope, outcomeId: event.target.value })}>
            <option value="">All outcomes</option>
            {outcomes.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Project</span>
          <select value={scope.projectId} onChange={(event) => narrow({ ...scope, projectId: event.target.value })}>
            <option value="">All projects</option>
            {projects.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Action</span>
          <select
            value={actionId}
            disabled={full || !available.length}
            onChange={(event) => setActionId(event.target.value)}
          >
            <option value="">{available.length ? "Choose an action" : "Nothing left to choose here"}</option>
            {available.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
                {option.detail ? ` · ${option.detail}` : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="direction-cascade-actions">
          <button type="button" disabled={!actionId || full} onClick={add}>
            Add win
          </button>
          {(scope.areaId || scope.outcomeId || scope.projectId) && (
            <button type="button" className="quiet small" onClick={() => narrow(emptyDirectionScope)}>
              Reset folder
            </button>
          )}
        </div>
      </div>
      <p className="microcopy">
        {actions.length} action{actions.length === 1 ? "" : "s"} available in this folder. Narrow by area, outcome, or
        project, or leave a level on “All” to search wider.
      </p>
      {selected.length ? (
        <div className="direction-chips">
          {selected.map((id) => {
            const path = directionActionPath(state, id);
            return (
              <button
                type="button"
                className="quiet small"
                key={id}
                onClick={() => onChange(selected.filter((item) => item !== id))}
              >
                {path.length ? path.join(" / ") : "Unknown action"} ×
              </button>
            );
          })}
        </div>
      ) : (
        <p className="empty">No desired wins chosen yet.</p>
      )}
      {full && <p className="microcopy">Three wins is the maximum. Remove one to swap it for something else.</p>}
    </div>
  );
}
