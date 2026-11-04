"use client";

import { isClosedStatus } from "@openrhen/contracts";
import type { FormEvent, ReactNode } from "react";
import type { StoredArea, StoredOutcome } from "@/state/portal-state";
import { statuses, type OutcomeDraft } from "@/features/plan/plan-drafts";
import { Field } from "@/components/field";
import { FormActions, useSubmitGuard } from "@/components/form-actions";
import { StatusField } from "@/components/status-field";

/** Add or edit an outcome: the result an area is aiming at, and the sentence that decides it is done. */
export function OutcomeEditor({
  draft,
  areas,
  onChange,
  onSubmit,
  onCancel,
  open = Boolean(draft.id),
  closeControl
}: {
  draft: OutcomeDraft;
  areas: StoredArea[];
  onChange: (draft: OutcomeDraft) => void;
  onSubmit: (event: FormEvent) => void | Promise<void>;
  onCancel: () => void;
  /** Whether the card is unfolded; open while editing by default, and a sheet holds it open. */
  open?: boolean;
  /** The Archive / Cancel / Restore control, shown only for a record that exists. */
  closeControl?: ReactNode;
}) {
  const guard = useSubmitGuard(onSubmit);
  return (
    <details className="editor-card" open={open}>
      <summary>{draft.id ? "Edit outcome" : "Add an outcome"}</summary>
      <form className="editor-grid" onSubmit={guard.onSubmit}>
        <Field label="Area">
          <select value={draft.areaId} onChange={(event) => onChange({ ...draft, areaId: event.target.value })}>
            <option value="">Choose area</option>
            {/* Archived areas are not offered for new work, but one the outcome already sits in stays listed. */}
            {areas
              .filter((item) => !isClosedStatus(item.status) || item.id === draft.areaId)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Outcome">
          <input value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} />
        </Field>
        <Field label="Definition of done" wide>
          <input
            value={draft.definitionOfDone}
            onChange={(event) => onChange({ ...draft, definitionOfDone: event.target.value })}
          />
        </Field>
        <Field label="Value (1–5)">
          <input
            type="number"
            min="1"
            max="5"
            value={draft.value}
            onChange={(event) => onChange({ ...draft, value: Number(event.target.value) })}
          />
        </Field>
        <Field label="Deadline">
          <input
            type="datetime-local"
            value={draft.deadlineAt}
            onChange={(event) => onChange({ ...draft, deadlineAt: event.target.value })}
          />
        </Field>
        <Field label="Review date">
          <input
            type="date"
            value={draft.reviewOn}
            onChange={(event) => onChange({ ...draft, reviewOn: event.target.value })}
          />
        </Field>
        <StatusField
          value={draft.status}
          options={statuses}
          onChange={(status) => onChange({ ...draft, status: status as StoredOutcome["status"] })}
        />
        <FormActions editing={Boolean(draft.id)} cancel={onCancel} pending={guard.pending} />
        {draft.id && closeControl}
      </form>
    </details>
  );
}
