"use client";

import { useState, type FormEvent } from "react";
import { Field } from "@/components/field";
import { Section } from "@/features/settings/components/settings-fields";
import { createClientId } from "@/shared/client-id";
import { usePortal } from "@/state/portal-provider";

/**
 * The reference-code pattern the plan map links by. It saves on its own, apart from the model form, so a pattern
 * and a model are never rewritten together; an empty pattern turns the code rules off.
 */
export function CodePatternCard() {
  const { state, saving, saveEntityCommand } = usePortal();
  const stored = state.settings.planCodePattern ?? "";
  // What the person has typed, or null to show what is stored (so a reload or a save elsewhere shows through).
  const [typed, setTyped] = useState<string | null>(null);
  const value = typed ?? stored;
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await saveEntityCommand({
        commandId: createClientId(),
        expectedVersion: state.settings.version ?? null,
        type: "save_entity",
        entityType: "settings",
        entity: { planCodePattern: value.trim() || null }
      });
      setTyped(null);
      setFailed(false);
      setMessage("Code pattern saved.");
    } catch (reason) {
      setFailed(true);
      setMessage(reason instanceof Error ? reason.message : "The code pattern was not saved.");
    }
  }

  return (
    <form className="settings-form" onSubmit={submit}>
      <Section
        id="reference-codes"
        title="Reference codes"
        reason="Plan map rules link items whose titles share a code this pattern matches. Leave it empty to turn those rules off."
      >
        <Field label="Code pattern" wide>
          <input
            value={value}
            spellCheck={false}
            onChange={(event) => {
              setTyped(event.target.value);
              setMessage("");
            }}
          />
        </Field>
      </Section>
      {message && (
        <p className={failed ? "form-error" : "save-notice"} role={failed ? "alert" : "status"}>
          {message}
        </p>
      )}
      <div className="settings-save">
        <button disabled={saving} type="submit">
          {saving ? "Saving…" : "Save code pattern"}
        </button>
      </div>
    </form>
  );
}
