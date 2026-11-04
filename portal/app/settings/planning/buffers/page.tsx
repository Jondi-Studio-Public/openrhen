"use client";

import { useState, type FormEvent } from "react";
import { usePortal } from "@/state/portal-provider";
import { BuffersSection } from "@/features/settings/components/buffers-section";
import type { PlanningSettings } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { isVersionConflictError, useServerDraft } from "@/shared/use-server-draft";
import { DEFAULT_START_BY_WARNING_MINUTES } from "@openrhen/contracts";
import { SettingsHead } from "@/features/settings/components/settings-head";

/**
 * Setup, transition, and submission buffers. The setup and transition defaults only seed a *new*
 * commitment or import — editing them here never rewrites the buffers already saved on existing
 * commitments, which each keep their own.
 */
export default function BuffersSettingsPage() {
  const { state, ready, saving, saveEntityCommand } = usePortal();
  const { draft, setDraft, resetDraft, markPristine, seededVersion } = useServerDraft<PlanningSettings>(
    state.settings,
    ready,
    state.settings.version ?? null
  );
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const patch = (change: Partial<PlanningSettings>) => setDraft({ ...draft, ...change });

  async function save(expectedVersion: number | null) {
    await saveEntityCommand({
      commandId: createClientId(),
      expectedVersion,
      type: "save_entity",
      entityType: "settings",
      entity: {
        defaultSetupBufferMinutes: draft.defaultSetupBufferMinutes,
        defaultTransitionBufferMinutes: draft.defaultTransitionBufferMinutes,
        submissionBufferMinutes: draft.submissionBufferMinutes,
        submissionBufferPercent: draft.submissionBufferPercent,
        arrivalMarginMinutes: draft.arrivalMarginMinutes,
        startByWarningMinutes: draft.startByWarningMinutes ?? DEFAULT_START_BY_WARNING_MINUTES,
        sessionBreakMinutes: draft.sessionBreakMinutes,
        // Always sent, never omitted: this form always holds a definite answer (a mode, or "no
        // opinion"), so an explicit `null` is what clears a previously chosen mode back to it
        //
        defaultTransportMode: draft.defaultTransportMode ?? null
      }
    });
    markPristine();
    setError("");
    setConflict(false);
    setSaved(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const values = [
      draft.defaultSetupBufferMinutes,
      draft.defaultTransitionBufferMinutes,
      draft.submissionBufferMinutes
    ];
    if (!values.every((value) => Number.isInteger(value) && value >= 0 && value <= 1_440)) {
      setError("Buffer values must be whole minutes between 0 and 1,440.");
      setSaved(false);
      return;
    }
    if (draft.submissionBufferPercent < 0 || draft.submissionBufferPercent > 1) {
      setError("Submission buffer percentage must be between 0% and 100%.");
      setSaved(false);
      return;
    }
    if (
      !Number.isInteger(draft.arrivalMarginMinutes) ||
      draft.arrivalMarginMinutes < 0 ||
      draft.arrivalMarginMinutes > 60
    ) {
      setError("Arrival margin must be a whole number of minutes between 0 and 60.");
      setSaved(false);
      return;
    }
    const startByWarningMinutes = draft.startByWarningMinutes ?? DEFAULT_START_BY_WARNING_MINUTES;
    if (!Number.isInteger(startByWarningMinutes) || startByWarningMinutes < 0 || startByWarningMinutes > 240) {
      setError("Start-by warning lead must be a whole number of minutes between 0 and 240.");
      setSaved(false);
      return;
    }
    if (
      !Number.isInteger(draft.sessionBreakMinutes) ||
      draft.sessionBreakMinutes < 0 ||
      draft.sessionBreakMinutes > 120
    ) {
      setError("Session break must be a whole number of minutes between 0 and 120.");
      setSaved(false);
      return;
    }
    try {
      await save(seededVersion);
    } catch (reason) {
      if (isVersionConflictError(reason)) {
        setConflict(true);
        setSaved(false);
        return;
      }
      setError(reason instanceof Error ? reason.message : "Buffers were not saved.");
      setSaved(false);
    }
  }

  const reload = () => {
    resetDraft(state.settings);
    setConflict(false);
  };
  const keepMine = async () => {
    try {
      await save(state.settings.version ?? null);
    } catch (reason) {
      if (!isVersionConflictError(reason)) {
        setError(reason instanceof Error ? reason.message : "Buffers were not saved.");
      }
    }
  };

  return (
    <main className="content-page settings-page">
      <SettingsHead
        href="/settings/planning/buffers"
        answer="Protected time the planner keeps around commitments; changes here apply to new commitments and imports."
      />
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
          Buffers saved and the seven-day plan was recalculated.
        </p>
      )}
      <form className="settings-form" onSubmit={submit}>
        <BuffersSection draft={draft} onChange={patch} />
        <div className="settings-save">
          <button disabled={saving} type="submit">
            {saving ? "Saving…" : "Save buffers"}
          </button>
        </div>
      </form>
    </main>
  );
}
