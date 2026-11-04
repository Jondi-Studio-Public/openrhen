"use client";

import { isClosedStatus } from "@openrhen/contracts";
import type { FormEvent, ReactNode } from "react";
import type { StoredAction, StoredArea, StoredDeliverable, StoredOutcome, StoredProject } from "@/state/portal-state";
import { PrerequisitePicker } from "@/features/plan/components/prerequisite-picker";
import { statuses, type ProjectDraft } from "@/features/plan/plan-drafts";
import { projectInheritedPrivacyFrom } from "@/features/plan/pulse-privacy";
import { Field } from "@/components/field";
import { FormActions, useSubmitGuard } from "@/components/form-actions";
import { StatusField } from "@/components/status-field";

/**
 * Add or edit a project. Both deadlines are offered because the internal one is what the forecast
 * defends, while the external one is the date the world actually knows about.
 */
export function ProjectEditor({
  draft,
  outcomes,
  areas,
  projects = [],
  deliverables = [],
  actions = [],
  onChange,
  onSubmit,
  onCancel,
  open = Boolean(draft.id),
  closeControl
}: {
  draft: ProjectDraft;
  outcomes: StoredOutcome[];
  /** Only for the Private switch's "Private through <area>" display — see `pulse-privacy.ts`. */
  areas?: StoredArea[];
  /** The rest of the plan, for the Prerequisites picker. */
  projects?: StoredProject[];
  deliverables?: StoredDeliverable[];
  actions?: StoredAction[];
  onChange: (draft: ProjectDraft) => void;
  onSubmit: (event: FormEvent) => void | Promise<void>;
  onCancel: () => void;
  /** Whether the card is unfolded; open while editing by default, and a sheet holds it open. */
  open?: boolean;
  /** The Archive / Cancel / Restore control, shown only for a record that exists. */
  closeControl?: ReactNode;
}) {
  const inheritedFrom = areas ? projectInheritedPrivacyFrom(draft.outcomeId, outcomes, areas) : null;
  const guard = useSubmitGuard(onSubmit);
  return (
    <details className="editor-card" open={open}>
      <summary>{draft.id ? "Edit project" : "Add a project"}</summary>
      <form className="editor-grid" onSubmit={guard.onSubmit}>
        <Field label="Outcome">
          <select value={draft.outcomeId} onChange={(event) => onChange({ ...draft, outcomeId: event.target.value })}>
            <option value="">Choose outcome</option>
            {/* Archived outcomes (or outcomes in an archived area) are not offered for new work, but the one the
                project already sits under stays listed. */}
            {outcomes
              .filter(
                (item) =>
                  item.id === draft.outcomeId ||
                  (!isClosedStatus(item.status) &&
                    !isClosedStatus(areas?.find((area) => area.id === item.areaId)?.status ?? ""))
              )
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Project title">
          <input value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} />
        </Field>
        <Field label="Internal deadline">
          <input
            type="datetime-local"
            value={draft.internalDeadlineAt}
            onChange={(event) => onChange({ ...draft, internalDeadlineAt: event.target.value })}
          />
        </Field>
        <Field label="External deadline">
          <input
            type="datetime-local"
            value={draft.externalDeadlineAt}
            onChange={(event) => onChange({ ...draft, externalDeadlineAt: event.target.value })}
          />
        </Field>
        <Field label="Uncertainty">
          <select
            value={draft.uncertainty}
            onChange={(event) =>
              onChange({ ...draft, uncertainty: event.target.value as StoredProject["uncertainty"] })
            }
          >
            <option value="known">Known</option>
            <option value="some">Some uncertainty</option>
            <option value="high">High uncertainty</option>
          </select>
        </Field>
        <Field label="Remaining effort override">
          <input
            type="number"
            min="0"
            value={draft.remainingEffortOverrideMinutes}
            placeholder="Use action estimates"
            onChange={(event) => onChange({ ...draft, remainingEffortOverrideMinutes: event.target.value })}
          />
        </Field>
        <Field label="Consequence (1–5)">
          <input
            type="number"
            min="1"
            max="5"
            value={draft.consequence}
            onChange={(event) => onChange({ ...draft, consequence: Number(event.target.value) })}
          />
        </Field>
        <StatusField
          value={draft.status}
          options={statuses}
          onChange={(status) => onChange({ ...draft, status: status as StoredProject["status"] })}
        />
        <PrerequisitePicker
          self={{ kind: "project", id: draft.id || undefined }}
          plan={{ projects, deliverables, actions }}
          dependencyIds={[]}
          prerequisites={draft.prerequisites ?? []}
          onChange={(split) => onChange({ ...draft, prerequisites: split.prerequisites })}
        />
        {/* Pulse privacy; inherited from the
            area and not editable downward once the area itself is private. */}
        <Field label="Private">
          <input
            type="checkbox"
            checked={Boolean(inheritedFrom) || draft.private}
            disabled={Boolean(inheritedFrom)}
            onChange={(event) => onChange({ ...draft, private: event.target.checked })}
          />
        </Field>
        <p className="microcopy">
          {inheritedFrom ? `Private through ${inheritedFrom}.` : "Hides this project from the published pulse."}
        </p>
        <FormActions editing={Boolean(draft.id)} cancel={onCancel} pending={guard.pending} />
        {draft.id && closeControl}
      </form>
    </details>
  );
}
