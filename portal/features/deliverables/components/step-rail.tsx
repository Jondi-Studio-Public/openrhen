"use client";

import { useState } from "react";
import type { DeliverableReadiness, RequirementPathway } from "@openrhen/contracts";
import type { PortalState, StoredDeliverable, StoredDeliverableStep } from "@/state/portal-state";
import {
  formatElapsed,
  label,
  newStep,
  removeStep,
  replaceAt,
  stepProgress,
  stepReadinessText
} from "@/features/deliverables/deliverable-model";
import { RequirementPathways } from "./requirement-pathways";
import { StepRequirementsSheet } from "./step-requirements-sheet";

export type EditDeliverable = (change: (current: StoredDeliverable) => StoredDeliverable) => void;

const energies: StoredDeliverableStep["energy"][] = ["high", "medium", "low", "recovery"];

/**
 * The step plan. Every fact the engine's projection carries about a step — effort range, energy,
 * session range, splittable, setup, required, prerequisites, requirement pathways — is authored here,
 * because a value the workspace cannot set is a value the engine plans against blind.
 *
 * In a running Carry-out session the current step is marked and every other executable step offers
 * "Work on this step" in its heading, not inside the collapsed editor: switching must be cheap, or
 * time keeps accruing to whichever step happened to be first.
 *
 * `compact` is the Carry-out context column's variant: the current step and up to three workable ones
 * next, with no editor and no "Add step" — a footer offers the full list instead. The desk frame keeps
 * exactly one context column on screen at a time, so a running session gets the short list that fits.
 */
export function StepRail({
  deliverable,
  readiness,
  conditionDefinitions,
  editable,
  currentStepId,
  stepSeconds,
  canSwitch,
  onSwitchStep,
  onEdit,
  timezone,
  compact = false,
  onShowAll,
  onSaveStepRequirementPathways,
  savingRequirementPathways = false
}: {
  deliverable: StoredDeliverable;
  readiness: DeliverableReadiness;
  conditionDefinitions: PortalState["conditionDefinitions"];
  editable: boolean;
  currentStepId: string | undefined;
  stepSeconds: Record<string, number> | undefined;
  canSwitch: boolean;
  onSwitchStep: (stepId: string) => void;
  onEdit: EditDeliverable;
  timezone: string;
  compact?: boolean;
  onShowAll?: () => void;
  /** Saves one step's requirement pathways on their own, independent of session editability — see
   * `StepRequirementsSheet`. Omit to leave the read-only view exactly as it was (no edit affordance). */
  onSaveStepRequirementPathways?: (stepId: string, pathways: RequirementPathway[]) => Promise<boolean> | boolean;
  savingRequirementPathways?: boolean;
}) {
  const conditionNames = new Map(conditionDefinitions.map((entry) => [entry.id, entry.name]));
  const readinessById = new Map(readiness.steps.map((step) => [step.stepId, step]));
  // Patches merge into the step as it is in the draft at that moment, not the step this render was
  // given, so two edits in the same tick both survive instead of the later one erasing the earlier.
  const setStep = (index: number, patch: Partial<StoredDeliverableStep>) =>
    onEdit((current) => ({
      ...current,
      steps: replaceAt(current.steps, index, { ...current.steps[index]!, ...patch })
    }));
  const progress = stepProgress(deliverable);
  const live = deliverable.steps.filter((step) => step.status !== "cancelled");
  const sorted = [...live].sort((a, b) => a.sortOrder - b.sortOrder);
  const current = currentStepId ? live.find((step) => step.id === currentStepId) : undefined;
  const rest = sorted.filter((step) => step.status !== "done" && step.id !== current?.id).slice(0, 3);
  const rows = compact ? (current ? [current, ...rest] : rest) : deliverable.steps;
  return (
    <section aria-label="Actions">
      <div className="section-heading">
        <h2>Actions</h2>
        {compact ? (
          <span>
            {progress.done} of {progress.total} done
          </span>
        ) : (
          <span>{deliverable.steps.length}</span>
        )}
      </div>
      {rows.map((step) => {
        const index = deliverable.steps.findIndex((item) => item.id === step.id);
        return (
          <StepRow
            key={step.id}
            deliverable={deliverable}
            step={step}
            stepReadiness={readinessById.get(step.id)}
            conditionNames={conditionNames}
            timezone={timezone}
            isCurrent={step.id === currentStepId}
            spent={stepSeconds?.[step.id]}
            editable={editable}
            canSwitch={canSwitch}
            onSwitchStep={onSwitchStep}
            onToggleDone={(done) =>
              setStep(index, {
                status: done ? "done" : "planned",
                ...(done ? { completedAt: new Date().toISOString() } : { completedAt: undefined })
              })
            }
            editor={
              compact
                ? undefined
                : {
                    conditionDefinitions,
                    onChange: (patch) => setStep(index, patch),
                    onRemove: () => onEdit((current) => removeStep(current, step.id)),
                    onSaveRequirementPathways: onSaveStepRequirementPathways
                      ? (pathways: RequirementPathway[]) => onSaveStepRequirementPathways(step.id, pathways)
                      : undefined,
                    savingRequirementPathways
                  }
            }
          />
        );
      })}
      {!compact && !deliverable.steps.length && <p className="empty">No actions yet.</p>}
      {!compact && editable && (
        <button
          type="button"
          className="quiet small"
          onClick={() =>
            onEdit((current) => ({ ...current, steps: [...current.steps, newStep(current.steps.length)] }))
          }
        >
          Add action
        </button>
      )}
      {compact && onShowAll && (
        <button type="button" className="quiet small" onClick={onShowAll}>
          All {progress.total} actions
        </button>
      )}
    </section>
  );
}

/**
 * One step's heading and status line, shared by the full rail and the Carry-out compact list. `editor`
 * carries the collapsed StepEditor disclosure; omitting it (the compact variant) drops the details
 * element entirely rather than rendering it collapsed, since a compact row is never meant to be edited.
 */
function StepRow({
  deliverable,
  step,
  stepReadiness,
  conditionNames,
  timezone,
  isCurrent,
  spent,
  editable,
  canSwitch,
  onSwitchStep,
  onToggleDone,
  editor
}: {
  deliverable: StoredDeliverable;
  step: StoredDeliverableStep;
  stepReadiness: DeliverableReadiness["steps"][number] | undefined;
  conditionNames: Map<string, string>;
  timezone: string;
  isCurrent: boolean;
  spent: number | undefined;
  editable: boolean;
  canSwitch: boolean;
  onSwitchStep: (stepId: string) => void;
  onToggleDone: (done: boolean) => void;
  editor:
    | {
        conditionDefinitions: PortalState["conditionDefinitions"];
        onChange: (patch: Partial<StoredDeliverableStep>) => void;
        onRemove: () => void;
        onSaveRequirementPathways: ((pathways: RequirementPathway[]) => Promise<boolean> | boolean) | undefined;
        savingRequirementPathways: boolean;
      }
    | undefined;
}) {
  const executable = stepReadiness?.executable ?? false;
  return (
    <div className="workspace-item" data-current={isCurrent || undefined}>
      <div className="workspace-step-heading">
        <input
          aria-label={`${step.title || "Untitled action"} complete`}
          type="checkbox"
          checked={step.status === "done"}
          disabled={!editable}
          onChange={(event) => onToggleDone(event.target.checked)}
        />
        <span>
          {isCurrent && <strong>Now: </strong>}
          {step.title || "Untitled action"}
          {!step.required && <small> · optional</small>}
        </span>
        <small>{step.remainingMinutes} min</small>
      </div>
      <div className="workspace-step-meta">
        <small>
          {stepReadiness ? stepReadinessText(stepReadiness, deliverable, conditionNames, timezone) : label(step.status)}
        </small>
        {spent !== undefined && <small>· {formatElapsed(spent)} this session</small>}
        {step.estimateNeedsReview && (
          <small className="error" role="note">
            · overran its estimate; review remaining effort
          </small>
        )}
        {canSwitch && !isCurrent && executable && (
          <button type="button" className="small" onClick={() => onSwitchStep(step.id)}>
            Work on this action
          </button>
        )}
      </div>
      {editor && (
        <details>
          <summary>
            <small>{editable ? "Edit action" : "Details"}</small>
          </summary>
          <StepEditor
            deliverable={deliverable}
            step={step}
            index={-1}
            editable={editable}
            conditionDefinitions={editor.conditionDefinitions}
            onChange={editor.onChange}
            onRemove={editor.onRemove}
            onSaveRequirementPathways={editor.onSaveRequirementPathways}
            savingRequirementPathways={editor.savingRequirementPathways}
          />
        </details>
      )}
    </div>
  );
}

function StepEditor({
  deliverable,
  step,
  editable,
  conditionDefinitions,
  onChange,
  onRemove,
  onSaveRequirementPathways,
  savingRequirementPathways
}: {
  deliverable: StoredDeliverable;
  step: StoredDeliverableStep;
  index: number;
  editable: boolean;
  conditionDefinitions: PortalState["conditionDefinitions"];
  onChange: (patch: Partial<StoredDeliverableStep>) => void;
  onRemove: () => void;
  onSaveRequirementPathways: ((pathways: RequirementPathway[]) => Promise<boolean> | boolean) | undefined;
  savingRequirementPathways: boolean;
}) {
  const stepTitle = (id: string) => deliverable.steps.find((other) => other.id === id)?.title || "Untitled action";
  const [editingRequirements, setEditingRequirements] = useState(false);
  if (!editable)
    return (
      <div className="workspace-item-editor">
        <small>
          Effort {step.optimisticMinutes}/{step.expectedMinutes}/{step.pessimisticMinutes} min · {step.remainingMinutes}{" "}
          remaining · {step.energy} energy · sessions {step.minimumSessionMinutes}–{step.maximumSessionMinutes} min
          {step.setupMinutes ? ` · ${step.setupMinutes} min setup` : ""}
          {step.splittable ? "" : " · not splittable"}
        </small>
        {step.completionCondition && <small>Done when: {step.completionCondition}</small>}
        <small>
          {step.dependencyIds.length
            ? `Depends on ${step.dependencyIds.map(stepTitle).join(", ")}`
            : "No prerequisites"}
        </small>
        <RequirementPathways
          pathways={step.requirementPathways}
          conditionDefinitions={conditionDefinitions}
          editable={false}
          onChange={() => {}}
        />
        {onSaveRequirementPathways && (
          <>
            <button type="button" className="quiet small" onClick={() => setEditingRequirements(true)}>
              Edit requirements
            </button>
            <StepRequirementsSheet
              open={editingRequirements}
              step={step}
              conditionDefinitions={conditionDefinitions}
              saving={savingRequirementPathways}
              onSave={onSaveRequirementPathways}
              onClose={() => setEditingRequirements(false)}
            />
          </>
        )}
      </div>
    );
  const number = (value: string) => Math.max(0, Number(value) || 0);
  return (
    <div className="workspace-item-editor">
      <input
        aria-label="Action title"
        value={step.title}
        placeholder="Name this action"
        onChange={(event) => onChange({ title: event.target.value })}
      />
      <input
        aria-label="Completion condition"
        value={step.completionCondition ?? ""}
        placeholder="Done when…"
        onChange={(event) => onChange({ completionCondition: event.target.value || undefined })}
      />
      <label>
        Optimistic minutes
        <input
          type="number"
          min="1"
          value={step.optimisticMinutes}
          onChange={(event) => onChange({ optimisticMinutes: number(event.target.value) })}
        />
      </label>
      <label>
        Expected minutes
        <input
          type="number"
          min="1"
          value={step.expectedMinutes}
          onChange={(event) => {
            const expected = number(event.target.value);
            // Remaining follows expected until work has been timed against the step; after that the
            // remaining figure is the one the user should correct directly.
            onChange({
              expectedMinutes: expected,
              remainingMinutes: step.lastWorkedAt ? step.remainingMinutes : expected
            });
          }}
        />
      </label>
      <label>
        Pessimistic minutes
        <input
          type="number"
          min="1"
          value={step.pessimisticMinutes}
          onChange={(event) => onChange({ pessimisticMinutes: number(event.target.value) })}
        />
      </label>
      <label>
        Remaining minutes
        <input
          type="number"
          min="0"
          value={step.remainingMinutes}
          onChange={(event) => onChange({ remainingMinutes: number(event.target.value), estimateNeedsReview: false })}
        />
      </label>
      <label>
        Energy
        <select value={step.energy} onChange={(event) => onChange({ energy: event.target.value as never })}>
          {energies.map((value) => (
            <option value={value} key={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label>
        Minimum session minutes
        <input
          type="number"
          min="1"
          value={step.minimumSessionMinutes}
          onChange={(event) => onChange({ minimumSessionMinutes: number(event.target.value) })}
        />
      </label>
      <label>
        Maximum session minutes
        <input
          type="number"
          min="1"
          value={step.maximumSessionMinutes}
          onChange={(event) => onChange({ maximumSessionMinutes: number(event.target.value) })}
        />
      </label>
      <label>
        Setup minutes
        <input
          type="number"
          min="0"
          value={step.setupMinutes}
          onChange={(event) => onChange({ setupMinutes: number(event.target.value) })}
        />
      </label>
      <label className="inline">
        <input
          type="checkbox"
          checked={step.required}
          onChange={(event) => onChange({ required: event.target.checked })}
        />
        Required to complete the deliverable
      </label>
      <label className="inline">
        <input
          type="checkbox"
          checked={step.splittable}
          onChange={(event) => onChange({ splittable: event.target.checked })}
        />
        Can be split across sessions
      </label>
      <label>
        Depends on
        <select
          multiple
          value={step.dependencyIds}
          onChange={(event) =>
            onChange({ dependencyIds: [...event.target.selectedOptions].map((option) => option.value) })
          }
        >
          {deliverable.steps
            .filter((other) => other.id !== step.id)
            .map((other) => (
              <option value={other.id} key={other.id}>
                {other.title || "Untitled action"}
              </option>
            ))}
        </select>
      </label>
      <RequirementPathways
        pathways={step.requirementPathways}
        conditionDefinitions={conditionDefinitions}
        editable
        onChange={(requirementPathways) => onChange({ requirementPathways })}
      />
      <button type="button" className="quiet small danger" onClick={onRemove}>
        Remove action
      </button>
    </div>
  );
}
