"use client";

import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { usePortal } from "@/state/portal-provider";
import { BedtimeRoutineSection } from "@/features/settings/components/bedtime-routine-section";
import { RoutinesSummarySection } from "@/features/settings/components/routines-summary-section";
import { SleepAndTimeSection } from "@/features/settings/components/sleep-and-time-section";
import { WakeRoutineSection } from "@/features/settings/components/wake-routine-section";
import type { PlanningSettings } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { isVersionConflictError, retryFalseConflict, useServerDraft } from "@/shared/use-server-draft";
import { SettingsHead } from "@/features/settings/components/settings-head";

/**
 * Sleep, on its own page: the one part of Settings that genuinely changes from the phone. The
 * bedtime routine choice sits here too, since it is read alongside sleep every night; the routine's
 * own steps stay on their own page, reached from the summary at the foot.
 */
export default function SleepSettingsPage() {
  const { state, ready, saving, saveEntityCommand } = usePortal();
  const { draft, setDraft, resetDraft, markPristine, seededVersion, seededValue } = useServerDraft<PlanningSettings>(
    state.settings,
    ready,
    state.settings.version ?? null
  );
  const latestSettings = useRef(state.settings);
  useLayoutEffect(() => {
    latestSettings.current = state.settings;
  });
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
        preferredBedtime: draft.preferredBedtime,
        preferredWakeTime: draft.preferredWakeTime,
        desiredSleepMinutes: draft.desiredSleepMinutes,
        minimumSleepMinutes: draft.minimumSleepMinutes,
        maxAwakeHours: draft.maxAwakeHours,
        bedtimeDeviationMinutes: draft.bedtimeDeviationMinutes,
        // Only when the user edited it: the draft's copy predates any "I'm awake" since, and
        // re-sending it (a retry, "Keep mine") would write the old wake time back.
        ...(draft.lastWokeAt && draft.lastWokeAt !== seededValue.lastWokeAt ? { lastWokeAt: draft.lastWokeAt } : {}),
        bedtimeRoutinePresetId: draft.bedtimeRoutinePresetId ?? "",
        wakeRoutinePresetId: draft.wakeRoutinePresetId ?? ""
      }
    });
    markPristine();
    setError("");
    setConflict(false);
    setSaved(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.minimumSleepMinutes < 60 || draft.minimumSleepMinutes > draft.desiredSleepMinutes) {
      setError("Minimum sleep must be at least one hour and cannot exceed desired sleep.");
      setSaved(false);
      return;
    }
    if (draft.maxAwakeHours < 8 || draft.maxAwakeHours > 36) {
      setError("Maximum awake hours must be between 8 and 36.");
      setSaved(false);
      return;
    }
    try {
      await save(seededVersion);
    } catch (reason) {
      if (isVersionConflictError(reason)) {
        const sentKeys: (keyof PlanningSettings)[] = [
          "preferredBedtime",
          "preferredWakeTime",
          "desiredSleepMinutes",
          "minimumSleepMinutes",
          "maxAwakeHours",
          "bedtimeDeviationMinutes",
          "bedtimeRoutinePresetId",
          "wakeRoutinePresetId",
          ...(draft.lastWokeAt !== seededValue.lastWokeAt ? (["lastWokeAt"] as const) : [])
        ];
        try {
          if (
            await retryFalseConflict({
              seeded: seededValue,
              readLatest: () => latestSettings.current,
              keys: sentKeys,
              save
            })
          )
            return;
        } catch (retryReason) {
          setError(retryReason instanceof Error ? retryReason.message : "Sleep settings were not saved.");
          setSaved(false);
          return;
        }
        setConflict(true);
        setSaved(false);
        return;
      }
      setError(reason instanceof Error ? reason.message : "Sleep settings were not saved.");
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
        setError(reason instanceof Error ? reason.message : "Sleep settings were not saved.");
      }
    }
  };

  return (
    <main className="content-page settings-page">
      <SettingsHead
        href="/settings/sleep"
        answer="Your sleep times and limits, and the routines either side of the night."
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
          Sleep settings saved and the seven-day plan was recalculated.
        </p>
      )}
      <form className="settings-form" onSubmit={submit}>
        <SleepAndTimeSection draft={draft} onChange={patch} />
        <BedtimeRoutineSection
          presetId={draft.bedtimeRoutinePresetId}
          routinePresets={state.routinePresets}
          onChange={(bedtimeRoutinePresetId) => patch({ bedtimeRoutinePresetId })}
        />
        <WakeRoutineSection
          presetId={draft.wakeRoutinePresetId}
          routinePresets={state.routinePresets}
          onChange={(wakeRoutinePresetId) => patch({ wakeRoutinePresetId })}
        />
        <div className="settings-save">
          <button disabled={saving} type="submit">
            {saving ? "Saving…" : "Save sleep settings"}
          </button>
        </div>
      </form>
      <RoutinesSummarySection
        presetId={draft.bedtimeRoutinePresetId}
        wakePresetId={draft.wakeRoutinePresetId}
        routinePresets={state.routinePresets}
      />
    </main>
  );
}
