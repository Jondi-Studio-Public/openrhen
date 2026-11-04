"use client";

import type { RequirementPathway } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";

/**
 * Where a step can be done, in the same shape the action editor uses: everything ticked inside one
 * way is needed together, several ways means any one of them is enough. This is what lets the engine
 * keep a deliverable off the recommendation when the tools it needs are not to hand.
 */
export function RequirementPathways({
  pathways,
  conditionDefinitions,
  editable,
  onChange
}: {
  pathways: RequirementPathway[];
  conditionDefinitions: PortalState["conditionDefinitions"];
  editable: boolean;
  onChange: (pathways: RequirementPathway[]) => void;
}) {
  const available = conditionDefinitions.filter((entry) => entry.status !== "archived");
  const name = (id: string) => conditionDefinitions.find((entry) => entry.id === id)?.name ?? id;
  if (!editable)
    return (
      <small>
        {pathways.length
          ? `Needs ${pathways.map((route) => route.contextIds.map(name).join(" + ")).join(", or ")}`
          : "Can be done anywhere"}
      </small>
    );
  return (
    <fieldset className="field wide">
      <legend>Where can this action be done?</legend>
      <div className="pathway-editor">
        {pathways.map((route, index) => (
          <div className="pathway-route" key={route.id}>
            <div className="pathway-route-heading">
              <strong>{index === 0 ? "This needs" : "Or this needs"}</strong>
              <button
                type="button"
                className="quiet small danger"
                onClick={() => onChange(pathways.filter((_, position) => position !== index))}
              >
                Remove this way
              </button>
            </div>
            <div className="choice-list">
              {available.map((entry) => (
                <label key={entry.id}>
                  <input
                    type="checkbox"
                    checked={route.contextIds.includes(entry.id)}
                    onChange={(event) => {
                      const contextIds = event.target.checked
                        ? [...new Set([...route.contextIds, entry.id])]
                        : route.contextIds.filter((item) => item !== entry.id);
                      onChange(pathways.map((item, position) => (position === index ? { ...item, contextIds } : item)));
                    }}
                  />
                  <span>{entry.name}</span>
                </label>
              ))}
            </div>
            {route.contextIds.length === 0 && (
              <small>Nothing ticked, so this way is dropped on save and places no requirement.</small>
            )}
          </div>
        ))}
        {pathways.length > 1 && <p className="pathway-or">Any one of these is enough</p>}
        <button
          type="button"
          className="quiet small"
          disabled={!available.length}
          onClick={() => onChange([...pathways, { id: createClientId(), contextIds: [] }])}
        >
          {pathways.length ? "Add another way to do this" : "Add a requirement"}
        </button>
        {!pathways.length && <small>No requirement means the action is offered in any situation.</small>}
      </div>
    </fieldset>
  );
}
