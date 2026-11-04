"use client";

import { useMemo, useRef, useState } from "react";
import { newRoutineStep, routineGraphLevels, validateRoutineGraph } from "@/features/routines/routine-editor";
import { RoutineStepTimingFields } from "@/features/routines/components/routine-step-timing-fields";
import { createClientId } from "@/shared/client-id";
import { useModalFocus } from "@/shared/use-modal-focus";
import type { EnergyLevel, RoutinePresetStep } from "@/state/portal-state";
import type { TimeBand } from "@openrhen/contracts";

const energies: EnergyLevel[] = ["high", "medium", "low", "recovery"];

export function RoutineOneOffEditor({
  title,
  steps,
  contexts,
  timeBands,
  onSave,
  onClose
}: {
  title: string;
  steps: RoutinePresetStep[];
  contexts: string[];
  timeBands: TimeBand[];
  onSave: (steps: RoutinePresetStep[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() =>
    steps.map((step, index) => ({
      ...step,
      id: step.id || createClientId(),
      sequence: index,
      dependencyIds: step.dependencyIds ?? [],
      contexts: [...step.contexts]
    }))
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const error = validateRoutineGraph(draft);
  const levels = useMemo(() => routineGraphLevels(draft), [draft]);
  const panel = useRef<HTMLElement>(null);
  // This editor only ever exists mounted (its caller renders it behind `{editingRoutine && ...}`), so
  // it's always the active dialog for as long as it's on screen.
  const { onKeyDown } = useModalFocus({ active: true, trapRef: panel, onClose });
  function patch(id: string, change: Partial<RoutinePresetStep>) {
    setDraft((current) => current.map((step) => (step.id === id ? { ...step, ...change } : step)));
  }
  function add(phase: "before" | "after" = "before") {
    const step = newRoutineStep(createClientId(), draft.length, phase);
    setDraft([...draft, step]);
    setEditingId(step.id);
  }
  function remove(id: string) {
    setDraft(
      draft
        .filter((step) => step.id !== id)
        .map((step) => ({ ...step, dependencyIds: step.dependencyIds.filter((value) => value !== id) }))
    );
    setEditingId(null);
  }
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panel}
        className="routine-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="routine-modal-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header>
          <div>
            <p className="eyebrow">ONE-OFF ROUTINE</p>
            <h2 id="routine-modal-title">Edit routine for {title}</h2>
            <p>These changes apply only to this imported event. The saved preset will not change.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close one-off routine editor" onClick={onClose}>
            ×
          </button>
        </header>
        {error && (
          <p className="form-error routine-message" role="alert">
            {error}
          </p>
        )}
        <div className="routine-modal-board">
          {levels.before.map((column, index) => (
            <div className="routine-level" key={`before-${index}`}>
              <span className="level-label">{index === 0 ? "Starts" : "Then"}</span>
              {column.map((step) => (
                <article className={`routine-tile${editingId === step.id ? " editing" : ""}`} key={step.id}>
                  {editingId === step.id ? (
                    <div className="tile-editor">
                      <div className="tile-editor-heading">
                        <strong>Edit tile</strong>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Collapse tile"
                          onClick={() => setEditingId(null)}
                        >
                          ×
                        </button>
                      </div>
                      <label>
                        <span>Step name</span>
                        <input
                          autoFocus
                          value={step.title}
                          onChange={(event) => patch(step.id, { title: event.target.value })}
                        />
                      </label>
                      <label>
                        <span>Energy</span>
                        <select
                          value={step.energy}
                          onChange={(event) => patch(step.id, { energy: event.target.value as EnergyLevel })}
                        >
                          {energies.map((energy) => (
                            <option key={energy}>{energy}</option>
                          ))}
                        </select>
                      </label>
                      <RoutineStepTimingFields
                        step={step}
                        patch={(change) => patch(step.id, change)}
                        timeBands={timeBands}
                      />
                      <fieldset>
                        <legend>Depends on</legend>
                        {draft
                          .filter((candidate) => candidate.id !== step.id && candidate.phase === step.phase)
                          .map((candidate) => (
                            <label className="dependency-choice" key={candidate.id}>
                              <input
                                type="checkbox"
                                checked={step.dependencyIds.includes(candidate.id)}
                                onChange={(event) => {
                                  const dependencyIds = event.target.checked
                                    ? [...new Set([...step.dependencyIds, candidate.id])]
                                    : step.dependencyIds.filter((id) => id !== candidate.id);
                                  const next = draft.map((item) =>
                                    item.id === step.id ? { ...item, dependencyIds } : item
                                  );
                                  if (!validateRoutineGraph(next)) setDraft(next);
                                }}
                              />
                              <span>{candidate.title || "Untitled tile"}</span>
                            </label>
                          ))}
                      </fieldset>
                      <fieldset>
                        <legend>Required contexts</legend>
                        {contexts.map((context) => (
                          <label className="dependency-choice" key={context}>
                            <input
                              type="checkbox"
                              checked={step.contexts.includes(context)}
                              onChange={(event) =>
                                patch(step.id, {
                                  contexts: event.target.checked
                                    ? [...step.contexts, context]
                                    : step.contexts.filter((item) => item !== context)
                                })
                              }
                            />
                            <span>{context}</span>
                          </label>
                        ))}
                      </fieldset>
                      <div className="tile-actions">
                        <button type="button" onClick={() => setEditingId(null)}>
                          Done
                        </button>
                        <button type="button" className="quiet danger" onClick={() => remove(step.id)}>
                          Remove
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="tile-drag-area">
                        <span>
                          {step.durationMinutes} min · {step.energy}
                        </span>
                        <strong>{step.title || "Untitled tile"}</strong>
                        <small>
                          {step.dependencyIds.length
                            ? `${step.dependencyIds.length} prerequisite${step.dependencyIds.length === 1 ? "" : "s"}`
                            : "No prerequisites"}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="tile-edit icon-button"
                        aria-label={`Edit ${step.title || "untitled tile"}`}
                        onClick={() => setEditingId(step.id)}
                      >
                        ✎
                      </button>
                    </>
                  )}
                </article>
              ))}
            </div>
          ))}
          <div className="routine-level activity-level">
            <span className="level-label">Commitment</span>
            <article className="routine-activity-tile">
              <span>Imported event</span>
              <strong>{title}</strong>
            </article>
          </div>
          {levels.after.map((column, index) => (
            <div className="routine-level" key={`after-${index}`}>
              <span className="level-label">Then</span>
              {column.map((step) => (
                <article className={`routine-tile${editingId === step.id ? " editing" : ""}`} key={step.id}>
                  {editingId === step.id ? (
                    <div className="tile-editor">
                      <div className="tile-editor-heading">
                        <strong>Edit tile</strong>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Collapse tile"
                          onClick={() => setEditingId(null)}
                        >
                          ×
                        </button>
                      </div>
                      <label>
                        <span>Step name</span>
                        <input
                          autoFocus
                          value={step.title}
                          onChange={(event) => patch(step.id, { title: event.target.value })}
                        />
                      </label>
                      <label>
                        <span>Energy</span>
                        <select
                          value={step.energy}
                          onChange={(event) => patch(step.id, { energy: event.target.value as EnergyLevel })}
                        >
                          {energies.map((energy) => (
                            <option key={energy}>{energy}</option>
                          ))}
                        </select>
                      </label>
                      <RoutineStepTimingFields
                        step={step}
                        patch={(change) => patch(step.id, change)}
                        timeBands={timeBands}
                      />
                      <fieldset>
                        <legend>Depends on</legend>
                        {draft
                          .filter((candidate) => candidate.id !== step.id && candidate.phase === step.phase)
                          .map((candidate) => (
                            <label className="dependency-choice" key={candidate.id}>
                              <input
                                type="checkbox"
                                checked={step.dependencyIds.includes(candidate.id)}
                                onChange={(event) => {
                                  const dependencyIds = event.target.checked
                                    ? [...new Set([...step.dependencyIds, candidate.id])]
                                    : step.dependencyIds.filter((id) => id !== candidate.id);
                                  const next = draft.map((item) =>
                                    item.id === step.id ? { ...item, dependencyIds } : item
                                  );
                                  if (!validateRoutineGraph(next)) setDraft(next);
                                }}
                              />
                              <span>{candidate.title || "Untitled tile"}</span>
                            </label>
                          ))}
                      </fieldset>
                      <fieldset>
                        <legend>Required contexts</legend>
                        {contexts.map((context) => (
                          <label className="dependency-choice" key={context}>
                            <input
                              type="checkbox"
                              checked={step.contexts.includes(context)}
                              onChange={(event) =>
                                patch(step.id, {
                                  contexts: event.target.checked
                                    ? [...step.contexts, context]
                                    : step.contexts.filter((item) => item !== context)
                                })
                              }
                            />
                            <span>{context}</span>
                          </label>
                        ))}
                      </fieldset>
                      <div className="tile-actions">
                        <button type="button" onClick={() => setEditingId(null)}>
                          Done
                        </button>
                        <button type="button" className="quiet danger" onClick={() => remove(step.id)}>
                          Remove
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="tile-drag-area">
                        <span>
                          {step.durationMinutes} min · {step.energy}
                        </span>
                        <strong>{step.title || "Untitled tile"}</strong>
                        <small>
                          {step.dependencyIds.length
                            ? `${step.dependencyIds.length} prerequisite${step.dependencyIds.length === 1 ? "" : "s"}`
                            : "No prerequisites"}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="tile-edit icon-button"
                        aria-label={`Edit ${step.title || "untitled tile"}`}
                        onClick={() => setEditingId(step.id)}
                      >
                        ✎
                      </button>
                    </>
                  )}
                </article>
              ))}
            </div>
          ))}
        </div>
        <footer>
          <button type="button" className="quiet" onClick={() => add("before")}>
            Add tile
          </button>
          <button type="button" className="quiet" onClick={() => add("after")}>
            Add step after
          </button>
          <div>
            <button type="button" className="quiet" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              disabled={Boolean(error) || draft.some((step) => !step.title.trim()) || !draft.length}
              onClick={() => onSave(draft.map((step, sequence) => ({ ...step, sequence })))}
            >
              Use for this event
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
