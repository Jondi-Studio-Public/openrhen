"use client";

import { useRef, useState, type FormEvent } from "react";
import { Field } from "@/components/field";
import { Sheet } from "@/components/sheet";
import { usePortal } from "@/state/portal-provider";
import { DisruptionRefusedError, postDisruption, retryableCommandId } from "../disruption-client";
import {
  EMPTY_DISRUPTION_DRAFT,
  buildDisruptionBody,
  missingDisruption,
  missingSentence,
  type DisruptionDraft
} from "../disruption-model";
import { rememberDisruption } from "../disruption-undo";
import { DisruptionFields } from "./disruption-fields";
import styles from "./reentry-panel.module.css";

/**
 * "Something else" when the pulse is unknown and no check-in is waiting to be answered: the same disruption form the
 * check-in sheet carries, posted on its own. Everything is required, because a deviation with less than this is off plan.
 */
export function DisruptionSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, acceptServerState } = usePortal();
  const [draft, setDraft] = useState<DisruptionDraft>(EMPTY_DISRUPTION_DRAFT);
  const idSlot = useRef<{ key: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const now = new Date();
    const missing = missingDisruption(draft, now, state.settings.timezone);
    if (missing.length > 0) return setError(missingSentence(missing));
    setBusy(true);
    setError("");
    try {
      const done = await postDisruption(
        buildDisruptionBody(draft, now, state.settings.timezone, retryableCommandId(idSlot, JSON.stringify(draft)))
      );
      if (done.state) acceptServerState(done.state);
      rememberDisruption({ commandId: done.revertible, doing: done.doing, until: done.until });
      idSlot.current = null;
      setDraft(EMPTY_DISRUPTION_DRAFT);
      onClose();
    } catch (failure) {
      setError(
        failure instanceof DisruptionRefusedError && failure.missing.length > 0
          ? missingSentence(failure.missing)
          : failure instanceof Error
            ? failure.message
            : "The disruption was not saved."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="What's happening instead?">
      <form className="editor-grid" onSubmit={submit}>
        <Field label="What are you doing?">
          <input value={draft.doing} onChange={(event) => setDraft({ ...draft, doing: event.target.value })} />
        </Field>
        <DisruptionFields draft={draft} onChange={setDraft} definitions={state.conditionDefinitions} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className={styles.bar}>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" className="quiet" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}
