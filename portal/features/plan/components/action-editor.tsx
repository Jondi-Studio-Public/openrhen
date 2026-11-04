"use client";

import { selectableProjects } from "@/features/plan/area-grouping";
import type { ReactNode, FormEvent } from "react";
import type { AssumableActionField } from "@openrhen/contracts";
import type {
  PortalState,
  StoredAction,
  StoredArea,
  StoredDeliverable,
  StoredOutcome,
  StoredProject
} from "@/state/portal-state";
import { actionStatuses, type ActionDraft } from "@/features/plan/plan-drafts";
import { assumedInDraft } from "@/features/plan/assumed-fields";
import { belowProjectInheritedPrivacyFrom } from "@/features/plan/pulse-privacy";
import { Field } from "@/components/field";
import { FormActions, useSubmitGuard } from "@/components/form-actions";
import { statusOption } from "@/components/status-option";
import { PrerequisitePicker } from "@/features/plan/components/prerequisite-picker";
import { ActionContextFields } from "@/features/plan/components/action-context-fields";
import { ActionRecurrenceFields } from "@/features/plan/components/action-recurrence-fields";
import { AssumedTag } from "@/features/plan/components/assumed-tag";

/**
 * The full editor for a concrete action: its estimates, the sessions it can be split into, where it
 * can happen, what it waits on, and — when it recurs — the series that keeps producing it.
 */
export function ActionEditor({
  draft,
  projects,
  actions,
  deliverables = [],
  conditionDefinitions,
  outcomes,
  areas,
  onChange,
  onSubmit,
  onCancel,
  open = Boolean(draft.id)
}: {
  draft: ActionDraft;
  projects: StoredProject[];
  actions: StoredAction[];
  /** For the Prerequisites picker; absent offers projects and actions only. */
  deliverables?: StoredDeliverable[];
  conditionDefinitions: PortalState["conditionDefinitions"];
  /** Only for the Private switch's "Private through <name>" display — see `pulse-privacy.ts`. */
  outcomes?: StoredOutcome[];
  areas?: StoredArea[];
  onChange: (draft: ActionDraft) => void;
  onSubmit: (event: FormEvent) => void | Promise<void>;
  onCancel: () => void;
  /** Whether the card is unfolded; open while editing by default, and a sheet holds it open. */
  open?: boolean;
}) {
  const inheritedFrom =
    outcomes && areas ? belowProjectInheritedPrivacyFrom(draft.projectId, projects, outcomes, areas) : null;
  const guard = useSubmitGuard(onSubmit);
  // A value the stored action lists as assumed (a default or a guess) is labelled until it is changed.
  const assumed = assumedInDraft(draft.id ? actions.find((item) => item.id === draft.id) : undefined, draft);
  const labelled = (text: string, field: AssumableActionField): ReactNode =>
    assumed.has(field) ? (
      <>
        {text} <AssumedTag />
      </>
    ) : (
      text
    );
  return (
    <details className="editor-card" open={open}>
      <summary>{draft.id ? "Edit action" : "Add a concrete action"}</summary>
      <form className="editor-grid" onSubmit={guard.onSubmit}>
        <Field label="Project">
          <select value={draft.projectId} onChange={(event) => onChange({ ...draft, projectId: event.target.value })}>
            <option value="">Choose project</option>
            {selectableProjects(projects, draft.projectId).map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Action title">
          <input
            value={draft.title}
            autoFocus={Boolean(draft.id)}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
          />
        </Field>
        <Field label="Details" wide>
          <textarea
            rows={3}
            placeholder="Exact steps, purpose, or context to remember later"
            value={draft.notes}
            onChange={(event) => onChange({ ...draft, notes: event.target.value })}
          />
        </Field>
        <Field label="Scheduling">
          <select
            value={draft.schedulingMode ?? "one_off"}
            onChange={(event) => {
              const schedulingMode = event.target.value as "one_off" | "recurring" | "cadence";
              // Each mode has its own natural ending; switching modes should not drag the other's along.
              onChange({
                ...draft,
                schedulingMode,
                completionMode: schedulingMode === "cadence" ? "manual" : "end_date"
              });
            }}
          >
            <option value="one_off">Once</option>
            <option value="recurring">Recurrence</option>
            <option value="cadence">Cadence</option>
          </select>
          <span className="microcopy">
            {draft.schedulingMode === "recurring"
              ? "On set days, in a window."
              : draft.schedulingMode === "cadence"
                ? "Every so often, when time allows."
                : "Worked until done."}
          </span>
        </Field>
        {draft.schedulingMode === "recurring" && (
          <ActionRecurrenceFields draft={draft} onChange={onChange} mode="recurring" />
        )}
        {draft.schedulingMode === "cadence" && (
          <ActionRecurrenceFields draft={draft} onChange={onChange} mode="cadence" />
        )}
        <Field label={labelled("Optimistic minutes", "optimisticMinutes")}>
          <input
            type="number"
            min="1"
            value={draft.optimisticMinutes}
            onChange={(event) => onChange({ ...draft, optimisticMinutes: Number(event.target.value) })}
          />
        </Field>
        <Field label={labelled("Expected minutes", "expectedMinutes")}>
          <input
            type="number"
            min="1"
            value={draft.expectedMinutes}
            onChange={(event) =>
              onChange({
                ...draft,
                expectedMinutes: Number(event.target.value),
                remainingMinutes: draft.id ? draft.remainingMinutes : Number(event.target.value)
              })
            }
          />
        </Field>
        <Field label={labelled("Pessimistic minutes", "pessimisticMinutes")}>
          <input
            type="number"
            min="1"
            value={draft.pessimisticMinutes}
            onChange={(event) => onChange({ ...draft, pessimisticMinutes: Number(event.target.value) })}
          />
        </Field>
        <Field label={labelled("Remaining minutes", "remainingMinutes")}>
          <input
            type="number"
            min="0"
            value={draft.remainingMinutes}
            onChange={(event) => onChange({ ...draft, remainingMinutes: Number(event.target.value) })}
          />
        </Field>
        <Field label={labelled("Energy", "energy")}>
          <select
            value={draft.energy}
            onChange={(event) => onChange({ ...draft, energy: event.target.value as StoredAction["energy"] })}
          >
            <option value="high">High focus</option>
            <option value="medium">Medium focus</option>
            <option value="low">Low focus</option>
            <option value="recovery">Recovery only</option>
          </select>
        </Field>
        <ActionContextFields draft={draft} conditionDefinitions={conditionDefinitions} onChange={onChange} />
        <Field label={labelled("Minimum session", "minimumSessionMinutes")}>
          <input
            type="number"
            min="1"
            value={draft.minimumSessionMinutes}
            onChange={(event) => onChange({ ...draft, minimumSessionMinutes: Number(event.target.value) })}
          />
        </Field>
        <Field label={labelled("Maximum session", "maximumSessionMinutes")}>
          <input
            type="number"
            min="1"
            value={draft.maximumSessionMinutes}
            onChange={(event) => onChange({ ...draft, maximumSessionMinutes: Number(event.target.value) })}
          />
        </Field>
        <label className="field">
          <span>{labelled("Splittable", "splittable")}</span>
          <span className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.splittable}
              onChange={(event) => onChange({ ...draft, splittable: event.target.checked })}
            />{" "}
            Can be divided across sessions
          </span>
        </label>
        <Field label={labelled("Setup minutes", "setupMinutes")}>
          <input
            type="number"
            min="0"
            value={draft.setupMinutes}
            onChange={(event) => onChange({ ...draft, setupMinutes: Number(event.target.value) })}
          />
        </Field>
        <Field label={labelled("Importance (1–5)", "importance")}>
          <input
            type="number"
            min="1"
            max="5"
            value={draft.importance}
            onChange={(event) => onChange({ ...draft, importance: Number(event.target.value) })}
          />
          {draft.schedulingMode === "cadence" && (
            <small>Decides which due cadence wins free time: a 5 is offered before a 2.</small>
          )}
        </Field>
        <Field label={labelled("Consequence (1–5)", "consequence")}>
          <input
            type="number"
            min="1"
            max="5"
            value={draft.consequence}
            onChange={(event) => onChange({ ...draft, consequence: Number(event.target.value) })}
          />
        </Field>
        <Field label="Available from">
          <input
            type="datetime-local"
            value={draft.availableFrom}
            onChange={(event) => onChange({ ...draft, availableFrom: event.target.value })}
          />
        </Field>
        {(draft.schedulingMode ?? "one_off") === "one_off" && (
          <>
            <Field label="Due date (leave empty for open work)">
              <input
                type="datetime-local"
                value={draft.deadlineAt}
                onChange={(event) => onChange({ ...draft, deadlineAt: event.target.value })}
              />
            </Field>
            <Field label="Latest useful start (derived from the due date; set only to override)">
              <input
                type="datetime-local"
                value={draft.latestStartAt}
                onChange={(event) => onChange({ ...draft, latestStartAt: event.target.value })}
              />
            </Field>
          </>
        )}
        <PrerequisitePicker
          self={{ kind: "action", id: draft.id || undefined, projectId: draft.projectId }}
          plan={{ projects, deliverables, actions }}
          dependencyIds={draft.dependencyIds}
          prerequisites={draft.prerequisites ?? []}
          onChange={(split) => onChange({ ...draft, ...split })}
        />
        <Field label="Status">
          <select
            value={draft.status}
            onChange={(event) => onChange({ ...draft, status: event.target.value as StoredAction["status"] })}
          >
            {actionStatuses.map(statusOption)}
          </select>
        </Field>
        {/* Pulse privacy; inherited from the
            project (or its area) and not editable downward once one of those is private. */}
        <Field label="Private">
          <input
            type="checkbox"
            checked={Boolean(inheritedFrom) || draft.private}
            disabled={Boolean(inheritedFrom)}
            onChange={(event) => onChange({ ...draft, private: event.target.checked })}
          />
        </Field>
        <p className="microcopy">
          {inheritedFrom ? `Private through ${inheritedFrom}.` : "Hides this action from the published pulse."}
        </p>
        <FormActions editing={Boolean(draft.id)} cancel={onCancel} pending={guard.pending} />
      </form>
    </details>
  );
}
