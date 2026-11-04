"use client";

import { useState, type FormEvent } from "react";
import { usePortal } from "@/state/portal-provider";
import { EnergyMeaningsSection } from "@/features/settings/components/energy-meanings-section";
import type { EnergyLevel, PlanningSettings } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { isVersionConflictError, useServerDraft } from "@/shared/use-server-draft";
import { SettingsHead } from "@/features/settings/components/settings-head";

/** Your practical definition of each capacity level, read wherever the planner names an energy. */
export default function EnergyMeaningsSettingsPage() {
  const { state, ready, saving, saveEntityCommand } = usePortal();
  const {
    draft: meanings,
    setDraft: setMeanings,
    resetDraft: resetMeanings,
    markPristine,
    seededVersion
  } = useServerDraft<PlanningSettings["energyMeanings"]>(
    state.settings.energyMeanings,
    ready,
    state.settings.version ?? null
  );
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const setMeaning = (level: EnergyLevel, value: string) => setMeanings({ ...meanings, [level]: value });

  async function save(expectedVersion: number | null) {
    await saveEntityCommand({
      commandId: createClientId(),
      expectedVersion,
      type: "save_entity",
      entityType: "settings",
      entity: { energyMeanings: meanings }
    });
    markPristine();
    setError("");
    setConflict(false);
    setSaved(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (Object.values(meanings).some((meaning) => !meaning.trim())) {
      setError("Each energy level needs a clear meaning.");
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
      setError(reason instanceof Error ? reason.message : "Energy meanings were not saved.");
      setSaved(false);
    }
  }

  const reload = () => {
    resetMeanings(state.settings.energyMeanings);
    setConflict(false);
  };
  const keepMine = async () => {
    try {
      await save(state.settings.version ?? null);
    } catch (reason) {
      if (!isVersionConflictError(reason)) {
        setError(reason instanceof Error ? reason.message : "Energy meanings were not saved.");
      }
    }
  };

  return (
    <main className="content-page settings-page">
      <SettingsHead href="/settings/catalogues/energy" answer="What each energy level means for you in practice." />
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
          Energy meanings saved.
        </p>
      )}
      <form className="settings-form" onSubmit={submit}>
        <EnergyMeaningsSection meanings={meanings} onChange={setMeaning} />
        <div className="settings-save">
          <button disabled={saving} type="submit">
            {saving ? "Saving…" : "Save energy meanings"}
          </button>
        </div>
      </form>
    </main>
  );
}
