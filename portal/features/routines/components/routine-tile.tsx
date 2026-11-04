"use client";

import type { DragEvent } from "react";
import type { CadenceActionOption, RecurringWindowOption } from "@/features/routines/recurring-windows";
import { RoutineStepTimingFields } from "@/features/routines/components/routine-step-timing-fields";
import type { EnergyLevel, RoutinePresetStep } from "@/state/portal-state";
import type { TimeBand } from "@openrhen/contracts";

const energyLevels: EnergyLevel[] = ["high", "medium", "low", "recovery"];

/** One preparation step on the board: a compact card until it is opened, then its own editor. */
export function RoutineTile({
  step,
  allSteps,
  editing,
  setEditingId,
  patchStep,
  deleteStep,
  connect,
  dropConnection,
  reorder,
  contexts,
  recurringWindows,
  cadenceActions,
  timeBands,
  setRef
}: {
  step: RoutinePresetStep;
  allSteps: RoutinePresetStep[];
  editing: boolean;
  setEditingId: (id: string | null) => void;
  patchStep: (id: string, patch: Partial<RoutinePresetStep>) => void;
  deleteStep: (id: string) => void;
  connect: (source: string, target: string) => void;
  dropConnection: (event: DragEvent, target: string) => void;
  reorder: (event: DragEvent, target: string) => void;
  contexts: string[];
  recurringWindows: RecurringWindowOption[];
  cadenceActions: CadenceActionOption[];
  timeBands: TimeBand[];
  setRef: (node: HTMLElement | null) => void;
}) {
  return (
    <article
      ref={setRef}
      className={`routine-tile${editing ? " editing" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        dropConnection(event, step.id);
        reorder(event, step.id);
      }}
    >
      <button
        className="tile-input-handle"
        type="button"
        aria-label={`Connections into ${step.title || "untitled step"}`}
        onClick={() => setEditingId(step.id)}
      >
        ◂
      </button>
      {editing ? (
        <div className="tile-editor">
          <div className="tile-editor-heading">
            <strong>Edit tile</strong>
            <button type="button" className="icon-button" aria-label="Collapse tile" onClick={() => setEditingId(null)}>
              ×
            </button>
          </div>
          <label>
            <span>Step name</span>
            <input
              autoFocus
              value={step.title}
              onChange={(event) => patchStep(step.id, { title: event.target.value })}
            />
          </label>
          <label>
            <span>Linked recurring occurrence</span>
            <select
              disabled={Boolean(step.cadenceActionId)}
              value={step.actionWindowId ?? ""}
              onChange={(event) => {
                const linked = recurringWindows.find((item) => item.id === event.target.value);
                patchStep(step.id, {
                  actionWindowId: event.target.value || undefined,
                  ...(linked ? { durationMinutes: linked.minutes } : {})
                });
              }}
            >
              <option value="">Instruction only</option>
              {recurringWindows.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <small>Completing this routine can satisfy the linked occurrence.</small>
          </label>
          <label>
            <span>Linked cadence action</span>
            <select
              disabled={Boolean(step.actionWindowId)}
              value={step.cadenceActionId ?? ""}
              onChange={(event) => {
                patchStep(step.id, { cadenceActionId: event.target.value || undefined });
              }}
            >
              <option value="">Instruction only</option>
              {cadenceActions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <small>
              Included only on a day that cadence action is due; completing this step records its cadence completion.
            </small>
          </label>
          <label>
            <span>Energy</span>
            <select
              value={step.energy}
              onChange={(event) => patchStep(step.id, { energy: event.target.value as EnergyLevel })}
            >
              {energyLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <RoutineStepTimingFields step={step} patch={(change) => patchStep(step.id, change)} timeBands={timeBands} />
          <fieldset>
            <legend>Depends on</legend>
            {allSteps
              .filter((item) => item.id !== step.id && item.phase === step.phase)
              .map((candidate) => (
                <label className="dependency-choice" key={candidate.id}>
                  <input
                    type="checkbox"
                    checked={step.dependencyIds.includes(candidate.id)}
                    onChange={(event) =>
                      event.target.checked
                        ? connect(candidate.id, step.id)
                        : patchStep(step.id, { dependencyIds: step.dependencyIds.filter((id) => id !== candidate.id) })
                    }
                  />
                  <span>{candidate.title || "Untitled tile"}</span>
                </label>
              ))}
            {allSteps.filter((item) => item.phase === step.phase).length === 1 && (
              <small>No prior connection required.</small>
            )}
          </fieldset>
          <fieldset>
            <legend>Required contexts</legend>
            {contexts.map((context) => (
              <label className="dependency-choice" key={context}>
                <input
                  type="checkbox"
                  checked={step.contexts.includes(context)}
                  onChange={(event) =>
                    patchStep(step.id, {
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
            <button type="button" className="quiet danger" onClick={() => deleteStep(step.id)}>
              Remove tile
            </button>
          </div>
        </div>
      ) : (
        <>
          <div
            className="tile-drag-area"
            draggable
            onClick={() => setEditingId(step.id)}
            onDragStart={(event) => event.dataTransfer.setData("application/x-routine-tile", step.id)}
          >
            <span>
              {step.durationMinutes} min · {step.energy}
            </span>
            <strong>{step.title || "Untitled tile"}</strong>
            <small>
              {step.actionWindowId
                ? "Completes a recurring occurrence"
                : step.cadenceActionId
                  ? "Stands in for a cadence action"
                  : step.dependencyIds.length
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
          <button
            type="button"
            className="tile-output-handle"
            draggable
            onDragStart={(event) => {
              event.stopPropagation();
              event.dataTransfer.setData("application/x-routine-connection", step.id);
            }}
            aria-label={`Drag to connect after ${step.title || "untitled step"}`}
          >
            ▸
          </button>
        </>
      )}
    </article>
  );
}
