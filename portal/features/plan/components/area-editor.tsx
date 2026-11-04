"use client";

import type { FormEvent, ReactNode } from "react";
import type { StoredArea } from "@/state/portal-state";
import { statuses, type AreaDraft } from "@/features/plan/plan-drafts";
import { Field } from "@/components/field";
import { FormActions, useSubmitGuard } from "@/components/form-actions";
import { StatusField } from "@/components/status-field";

/** Add or rename an area. It opens by itself once an existing area has been loaded into the draft. */
export function AreaEditor({
  draft,
  onChange,
  onSubmit,
  onCancel,
  open = Boolean(draft.id),
  closeControl
}: {
  draft: AreaDraft;
  onChange: (draft: AreaDraft) => void;
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
      <summary>{draft.id ? "Edit area" : "Add an area"}</summary>
      <form className="editor-grid" onSubmit={guard.onSubmit}>
        <Field label="Name">
          <input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
        </Field>
        <Field label="Description">
          <input
            value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })}
          />
        </Field>
        <StatusField
          value={draft.status}
          options={statuses}
          onChange={(status) => onChange({ ...draft, status: status as StoredArea["status"] })}
        />
        {/*
          Pulse privacy: an area has no
          ancestor of its own, so this is always its own flag, editable either way.
        */}
        <Field label="Private">
          <input
            type="checkbox"
            checked={draft.private}
            onChange={(event) => onChange({ ...draft, private: event.target.checked })}
          />
        </Field>
        <p className="microcopy">Hides this area, and everything under it, from the published pulse.</p>
        <FormActions editing={Boolean(draft.id)} cancel={onCancel} pending={guard.pending} />
        {draft.id && closeControl}
      </form>
    </details>
  );
}
