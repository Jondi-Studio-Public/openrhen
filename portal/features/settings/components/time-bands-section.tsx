"use client";

import { useState, type FormEvent } from "react";
import { usePortal } from "@/state/portal-provider";
import { Field } from "@/components/field";
import { Section } from "@/features/settings/components/settings-fields";
import { DEFAULT_TIME_BANDS, type TimeBand } from "@openrhen/contracts";
import { createClientId } from "@/shared/client-id";
import { isVersionConflictError, useServerDraft } from "@/shared/use-server-draft";

const HHMM = /^\d{2}:\d{2}$/;

/**
 * Named windows of the day a flexible commitment before-step can prefer
 * Owns its own draft, validation and save — the same
 * `usePortal` + `save_entity` + version-conflict pattern `routine-editor-section.tsx` uses, rather than
 * the page-owns-state split `buffers-section.tsx` uses, so this section is fully testable on its own.
 * A band's id is a stable client id assigned once, at creation, and never rewritten on rename — a
 * routine step names a band by id.
 */
export function TimeBandsSection() {
  const { state, ready, saving, saveEntityCommand } = usePortal();
  const { draft, setDraft, resetDraft, markPristine, seededVersion } = useServerDraft<TimeBand[]>(
    state.settings.timeBands ?? DEFAULT_TIME_BANDS,
    ready,
    state.settings.version ?? null
  );
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);

  function patchBand(id: string, patch: Partial<TimeBand>) {
    setDraft(draft.map((band) => (band.id === id ? { ...band, ...patch } : band)));
    setSaved(false);
  }
  function addBand() {
    setDraft([...draft, { id: createClientId(), name: "", start: "12:00", end: "13:00" }]);
    setSaved(false);
  }
  function deleteBand(id: string) {
    setDraft(draft.filter((band) => band.id !== id));
    setSaved(false);
  }

  async function save(expectedVersion: number | null, timeBands: TimeBand[]) {
    await saveEntityCommand({
      commandId: createClientId(),
      expectedVersion,
      type: "save_entity",
      entityType: "settings",
      entity: { timeBands }
    });
    markPristine();
    setError("");
    setConflict(false);
    setSaved(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.some((band) => !band.name.trim())) {
      setError("Every time band needs a name.");
      setSaved(false);
      return;
    }
    if (draft.some((band) => !HHMM.test(band.start) || !HHMM.test(band.end))) {
      setError("Time bands must use HH:MM.");
      setSaved(false);
      return;
    }
    if (draft.some((band) => band.start >= band.end)) {
      setError("Each band's end must be after its start.");
      setSaved(false);
      return;
    }
    try {
      await save(seededVersion, draft);
    } catch (reason) {
      if (isVersionConflictError(reason)) {
        setConflict(true);
        setSaved(false);
        return;
      }
      setError(reason instanceof Error ? reason.message : "Time bands were not saved.");
      setSaved(false);
    }
  }

  const reload = () => {
    resetDraft(state.settings.timeBands ?? DEFAULT_TIME_BANDS);
    setConflict(false);
  };
  const keepMine = async () => {
    try {
      await save(state.settings.version ?? null, draft);
    } catch (reason) {
      if (!isVersionConflictError(reason)) {
        setError(reason instanceof Error ? reason.message : "Time bands were not saved.");
      }
    }
  };

  return (
    <form className="settings-form" onSubmit={submit}>
      <Section
        id="time-bands"
        title="Time bands"
        reason="Named windows of the day a flexible preparation step can be pinned to, picked in the routine editor."
      >
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {conflict && (
          <div className="form-error" role="alert">
            <p>These settings changed on another device.</p>
            <button type="button" className="quiet small" onClick={reload}>
              Reload
            </button>
            <button type="button" className="quiet small" onClick={keepMine}>
              Keep mine
            </button>
          </div>
        )}
        {saved && (
          <p className="save-notice" role="status">
            Time bands saved.
          </p>
        )}
        {draft.map((band, index) => (
          <Field key={band.id} label={`Band ${index + 1}`} wide group>
            <div className="time-band-row">
              <input
                aria-label={`Band ${index + 1} name`}
                value={band.name}
                onChange={(event) => patchBand(band.id, { name: event.target.value })}
              />
              <input
                aria-label={`Band ${index + 1} start`}
                type="time"
                value={band.start}
                onChange={(event) => patchBand(band.id, { start: event.target.value })}
              />
              <span aria-hidden="true">–</span>
              <input
                aria-label={`Band ${index + 1} end`}
                type="time"
                value={band.end}
                onChange={(event) => patchBand(band.id, { end: event.target.value })}
              />
              <button
                type="button"
                className="quiet danger"
                aria-label={`Delete band ${index + 1}`}
                onClick={() => deleteBand(band.id)}
              >
                Delete
              </button>
            </div>
          </Field>
        ))}
        <button type="button" className="quiet" onClick={addBand}>
          Add band
        </button>
      </Section>
      <div className="settings-save">
        <button disabled={saving} type="submit">
          {saving ? "Saving…" : "Save time bands"}
        </button>
      </div>
    </form>
  );
}
