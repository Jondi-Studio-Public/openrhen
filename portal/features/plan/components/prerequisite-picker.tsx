"use client";

import { useState } from "react";
import type { PrerequisiteRef } from "@openrhen/contracts";
import {
  prerequisiteGroups,
  splitPrerequisites,
  toggleSelection,
  unifiedPrerequisites,
  type PrerequisitePlan,
  type PrerequisiteSelf,
  type PrerequisiteSplit
} from "@/features/plan/prerequisite-choices";

/**
 * The one Prerequisites picker every editor uses: any other project, deliverable or action, grouped
 * by kind, with a search box once the list is long. It reports the choice already split into
 * `dependencyIds` (same kind) and `prerequisites` (everything else), the way the wire keeps it.
 */
export function PrerequisitePicker({
  self,
  plan,
  dependencyIds,
  prerequisites,
  onChange
}: {
  self: PrerequisiteSelf;
  plan: PrerequisitePlan;
  dependencyIds: string[];
  prerequisites: PrerequisiteRef[];
  onChange: (split: PrerequisiteSplit) => void;
}) {
  const [query, setQuery] = useState("");
  const selection = unifiedPrerequisites(self.kind, { dependencyIds, prerequisites });
  const groups = prerequisiteGroups(plan, self, selection);
  const total = groups.reduce((sum, group) => sum + group.options.length, 0);
  const needle = query.trim().toLowerCase();
  const isChosen = (ref: PrerequisiteRef) => selection.some((item) => item.kind === ref.kind && item.id === ref.id);
  return (
    <fieldset className="dependency-field prerequisite-picker">
      <legend>Prerequisites</legend>
      {total > 8 && (
        <input
          type="search"
          aria-label="Search prerequisites"
          placeholder="Search projects, deliverables, actions"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <div className="prerequisite-options">
        {groups.map((group) => {
          const options = group.options.filter(
            (option) => !needle || isChosen(option.ref) || option.title.toLowerCase().includes(needle)
          );
          if (!options.length) return null;
          return (
            <div className="prerequisite-group" key={group.kind} role="group" aria-label={group.label}>
              <strong>{group.label}</strong>
              {options.map((option) => (
                <label key={`${option.ref.kind}:${option.ref.id}`}>
                  <input
                    type="checkbox"
                    checked={isChosen(option.ref)}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      onChange(splitPrerequisites(self.kind, toggleSelection(selection, option.ref, checked)));
                    }}
                  />
                  {option.title}
                </label>
              ))}
            </div>
          );
        })}
      </div>
      {!total && <span className="empty">Nothing else to depend on yet.</span>}
    </fieldset>
  );
}
