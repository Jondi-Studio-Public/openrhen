"use client";

import { useState, type FormEvent } from "react";
import type { StoredAction, StoredDeliverable, StoredProject } from "@/state/portal-state";
import { deliverableDraftFrom, deliverableDraftFromStored, type DeliverableDraft } from "@/features/plan/plan-drafts";
import { PrerequisitePicker } from "@/features/plan/components/prerequisite-picker";
import type { PrerequisiteSplit } from "@/features/plan/prerequisite-choices";
import { Field } from "@/components/field";

const OPEN_STATUSES: ReadonlyArray<StoredDeliverable["status"]> = [
  "needs_breakdown",
  "ready",
  "in_progress",
  "under_review",
  "awaiting_result",
  "ready_to_complete"
];

/**
 * Registering a deliverable is a one-way form rather than an editor, so it stays uncontrolled and is
 * cleared only once the save is accepted. `onRegister` answers whether that happened.
 *
 * The same form re-opens on a registered deliverable to change its planning metadata — deadlines,
 * uncertainty, prerequisite deliverables, importance, consequence — because planning metadata
 * belongs to Plan; the contract and actions stay in-session. Choosing a deliverable to edit remounts
 * the fields with its values as defaults, which is what keeps the form uncontrolled.
 */
export function DeliverableRegisterForm({
  projects,
  deliverables = [],
  actions = [],
  presetProjectId,
  timezone,
  onRegister,
  onUpdate,
  open = false
}: {
  projects: StoredProject[];
  deliverables?: StoredDeliverable[];
  /** For the Prerequisites picker. */
  actions?: StoredAction[];
  /** Preselects the project on a fresh registration, e.g. when opened from that project's own area. */
  presetProjectId?: string;
  /** The planning timezone the deadline fields read and write in — never the browser's (finding 30). */
  timezone: string;
  onRegister: (draft: DeliverableDraft) => Promise<boolean>;
  onUpdate?: (deliverable: StoredDeliverable, draft: DeliverableDraft) => Promise<boolean>;
  /** Whether the card is unfolded; a sheet holds it open since it is the only thing in there. */
  open?: boolean;
}) {
  const [editingId, setEditingId] = useState("");
  const editing = deliverables.find((item) => item.id === editingId);
  const defaults: DeliverableDraft | undefined = editing ? deliverableDraftFromStored(editing, timezone) : undefined;
  const editable = deliverables.filter((item) => OPEN_STATUSES.includes(item.status));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const draft = deliverableDraftFrom(new FormData(formElement));
    if (editing) {
      const saved = onUpdate ? await onUpdate(editing, draft) : false;
      if (saved) setEditingId("");
      return;
    }
    const registered = await onRegister(draft);
    if (registered) formElement.reset();
  }

  return (
    <details className="editor-card" open={open}>
      <summary>{editing ? `Edit ${editing.title}` : "Register a deliverable"}</summary>
      <form className="editor-grid" onSubmit={submit} key={editingId || "new"}>
        {editable.length > 0 && onUpdate && (
          <Field label="Registered deliverable" wide>
            <select value={editingId} onChange={(event) => setEditingId(event.target.value)}>
              <option value="">Register a new one</option>
              {editable.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Project">
          <select name="projectId" defaultValue={defaults?.projectId ?? presetProjectId ?? ""}>
            <option value="">Choose project</option>
            {projects.map((item) => (
              <option value={item.id} key={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Deliverable title">
          <input name="title" placeholder="Assessment 2" defaultValue={defaults?.title ?? ""} />
        </Field>
        <Field label="External deadline">
          <input name="externalDeadlineAt" type="datetime-local" defaultValue={defaults?.externalDeadlineAt ?? ""} />
        </Field>
        <Field label="Internal deadline">
          <input name="internalDeadlineAt" type="datetime-local" defaultValue={defaults?.internalDeadlineAt ?? ""} />
        </Field>
        <Field label="Uncertainty">
          <select name="uncertainty" defaultValue={defaults?.uncertainty ?? "some"}>
            <option value="known">Known</option>
            <option value="some">Some</option>
            <option value="high">High</option>
          </select>
        </Field>
        <Field label="Importance (1–5)">
          <input name="importance" type="number" min="1" max="5" defaultValue={defaults?.importance ?? 3} />
        </Field>
        <Field label="Consequence (1–5)">
          <input name="consequence" type="number" min="1" max="5" defaultValue={defaults?.consequence ?? 3} />
        </Field>
        {/* Pulse privacy. This form is
            uncontrolled (see the module doc comment), so — unlike the other five editors — it shows
            no inherited-through-project state; a project or area already marked private still hides
            this deliverable, the effective privacy is just not previewed here. */}
        <Field label="Private">
          <input type="checkbox" name="private" defaultChecked={defaults?.private ?? false} />
        </Field>
        <p className="microcopy wide">Hides this deliverable from the published pulse.</p>
        <FormPrerequisites
          key={editingId || "new"}
          self={{ kind: "deliverable", id: editingId || undefined, projectId: defaults?.projectId ?? presetProjectId }}
          plan={{ projects, deliverables, actions }}
          initial={{ dependencyIds: defaults?.dependencyIds ?? [], prerequisites: defaults?.prerequisites ?? [] }}
        />
        <div className="form-actions">
          <button type="submit">{editing ? "Save planning details" : "Register deliverable"}</button>
          {editing && (
            <button type="button" className="quiet" onClick={() => setEditingId("")}>
              Cancel
            </button>
          )}
        </div>
        <p className="microcopy wide">
          {editing
            ? "Only planning details change here. The contract and actions are authored in a session opened from Now."
            : "This creates only the schedulable shell. Breakdown begins later, when the planner recommends the deliverable and you press Start from Now."}
        </p>
      </form>
    </details>
  );
}

/**
 * The picker inside this uncontrolled form: it keeps its own selection and posts it as hidden inputs,
 * so `deliverableDraftFrom` reads it from `FormData` like every other field.
 */
function FormPrerequisites({
  self,
  plan,
  initial
}: {
  self: Parameters<typeof PrerequisitePicker>[0]["self"];
  plan: Parameters<typeof PrerequisitePicker>[0]["plan"];
  initial: PrerequisiteSplit;
}) {
  const [split, setSplit] = useState(initial);
  return (
    <div className="wide">
      <PrerequisitePicker
        self={self}
        plan={plan}
        dependencyIds={split.dependencyIds}
        prerequisites={split.prerequisites}
        onChange={setSplit}
      />
      {split.dependencyIds.map((id) => (
        <input type="hidden" name="dependencyIds" value={id} key={id} />
      ))}
      <input type="hidden" name="prerequisites" value={JSON.stringify(split.prerequisites)} />
    </div>
  );
}
