"use client";

import type { PortalState } from "@/state/portal-state";
import type { ActionDraft } from "@/features/plan/plan-drafts";
import { Field } from "@/components/field";

/**
 * Where an action can happen. Everything ticked inside one route is required together, and several
 * routes mean any one of them is enough — which is the only way "at home, or outdoors" can be said
 * without lying about either. Preferences shade the ranking and never block the work.
 */
export function ActionContextFields({
  draft,
  conditionDefinitions,
  onChange
}: {
  draft: ActionDraft;
  conditionDefinitions: PortalState["conditionDefinitions"];
  onChange: (draft: ActionDraft) => void;
}) {
  const available = conditionDefinitions.filter((entry) => entry.status !== "archived");
  return (
    <>
      <Field label="Where can this be done?" wide group>
        <div className="pathway-editor">
          {draft.pathways.map((route, index) => (
            <div className="pathway-route" key={index}>
              <div className="pathway-route-heading">
                <strong>{index === 0 ? "This needs" : "Or this needs"}</strong>
                {draft.pathways.length > 1 && (
                  <button
                    type="button"
                    className="quiet small danger"
                    onClick={() =>
                      onChange({
                        ...draft,
                        pathways: draft.pathways.filter((_, position) => position !== index)
                      })
                    }
                  >
                    Remove this way
                  </button>
                )}
              </div>
              <div className="choice-list">
                {available.map((entry) => (
                  <label key={entry.id}>
                    <input
                      type="checkbox"
                      checked={route.includes(entry.id)}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...new Set([...route, entry.id])]
                          : route.filter((item) => item !== entry.id);
                        onChange({
                          ...draft,
                          pathways: draft.pathways.map((item, position) => (position === index ? next : item))
                        });
                      }}
                    />
                    <span>{entry.name}</span>
                  </label>
                ))}
              </div>
              {route.length === 0 && <small>Nothing ticked, so this way places no requirement at all.</small>}
            </div>
          ))}
          {draft.pathways.length > 1 && <p className="pathway-or">Any one of these is enough</p>}
          <button
            type="button"
            className="quiet small"
            onClick={() => onChange({ ...draft, pathways: [...draft.pathways, []] })}
          >
            Add another way to do this
          </button>
        </div>
        <small>
          Everything ticked inside one way is needed together. Several ways means any one of them is enough — that is
          how “at home, or outdoors” is said.
        </small>
      </Field>
      <Field label="Prefers, but does not need" wide group>
        <div className="choice-list">
          {available.map((entry) => (
            <label key={entry.id}>
              <input
                type="checkbox"
                checked={draft.preferences.includes(entry.id)}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    preferences: event.target.checked
                      ? [...new Set([...draft.preferences, entry.id])]
                      : draft.preferences.filter((item) => item !== entry.id)
                  })
                }
              />
              <span>{entry.name}</span>
            </label>
          ))}
        </div>
        <small>These shade the ranking without ever blocking the work.</small>
      </Field>
    </>
  );
}
