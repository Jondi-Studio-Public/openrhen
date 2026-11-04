"use client";

import { useState } from "react";
import { Field } from "@/components/field";
import type { ConditionDefinition } from "@/features/settings/context-summary";

/**
 * The one contact control: a picker over the active `kind: "contact"` conditions, with **None** and
 * **New contact…**. Unlike `LocationPicker`, there is no search behind it — a contact has no address
 * to look up — so a new one is just a name.
 *
 * There is deliberately no free-text field: every commitment contact is a real condition the offers
 * and the editor can resolve the same way (`commitment-contact.ts`). A `contactId` that no longer
 * resolves — archived, or removed from `definitions` — stays selectable as "Contact no longer
 * available" rather than silently reading as **None**.
 */
export function ContactPicker({
  definitions,
  contactId,
  onSelect,
  onCreate,
  label = "Contact"
}: {
  /** Context definitions; the picker offers the active contacts among them. */
  definitions: ConditionDefinition[];
  contactId: string;
  /** Called with the chosen contact's id, or "" for **None**. */
  onSelect: (contactId: string) => void;
  /** Saves a name as a new (or existing) contact condition; resolves to what to select. */
  onCreate: (name: string) => Promise<{ id: string; name: string }>;
  /** The field's own label; the disruption draft asks "Who's affected?" instead. */
  label?: string;
}) {
  const contacts = definitions.filter((entry) => entry.kind === "contact" && entry.status === "active");
  const unresolved = Boolean(contactId) && !contacts.some((entry) => entry.id === contactId);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    if (!name.trim()) return;
    setSaving(true);
    setError("");
    try {
      const created = await onCreate(name);
      onSelect(created.id);
      setCreating(false);
      setName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The contact was not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Field label={label} group>
      <select aria-label={label} value={contactId} onChange={(event) => onSelect(event.target.value)}>
        <option value="">— none —</option>
        {unresolved && <option value={contactId}>Contact no longer available</option>}
        {contacts.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </select>
      {creating ? (
        <div className="geocode-row">
          <input
            aria-label="Contact name"
            value={name}
            placeholder="Sam"
            onChange={(event) => setName(event.target.value)}
          />
          <button type="button" className="quiet small" disabled={saving || !name.trim()} onClick={() => void create()}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="quiet small"
            onClick={() => {
              setCreating(false);
              setName("");
              setError("");
            }}
          >
            Close
          </button>
        </div>
      ) : (
        <button type="button" className="quiet small" onClick={() => setCreating(true)}>
          New contact…
        </button>
      )}
      {error && <small className="form-error">{error}</small>}
    </Field>
  );
}
