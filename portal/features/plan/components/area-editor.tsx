"use client";

import type { FormEvent } from "react";
import type { StoredArea } from "@/state/portal-state";
import { statuses, type AreaDraft } from "@/features/plan/plan-drafts";
import { Field } from "@/components/field";
import { FormActions, useSubmitGuard } from "@/components/form-actions";
import { statusOption } from "@/components/status-option";

/** Add or rename an area. It opens by itself once an existing area has been loaded into the draft. */
export function AreaEditor({
  draft,
  onChange,
  onSubmit,
  onCancel,
  open = Boolean(draft.id)
}: {
  draft: AreaDraft;
  onChange: (draft: AreaDraft) => void;
  onSubmit: (event: FormEvent) => void | Promise<void>;
  onCancel: () => void;
  /** Whether the card is unfolded; open while editing by default, and a sheet holds it open. */
  open?: boolean;
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
        <Field label="Status">
          <select
            value={draft.status}
            onChange={(event) => onChange({ ...draft, status: event.target.value as StoredArea["status"] })}
          >
            {statuses.map(statusOption)}
          </select>
        </Field>
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
      </form>
    </details>
  );
}
