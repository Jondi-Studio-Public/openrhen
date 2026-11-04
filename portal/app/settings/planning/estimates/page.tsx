"use client";

import { useMemo, useState, type FormEvent } from "react";
import { usePortal } from "@/state/portal-provider";
import { EstimateCalibrationSection } from "@/features/settings/components/estimate-calibration-section";
import { EstimateBucketsSection } from "@/features/settings/components/estimate-buckets-section";
import { parseEstimateBuckets } from "@/features/settings/settings-format";
import { createClientId } from "@/shared/client-id";
import { isVersionConflictError, useServerDraft } from "@/shared/use-server-draft";
import { SettingsHead } from "@/features/settings/components/settings-head";

/** The quick minute choices offered when estimating new work. */
export default function EstimateBucketsSettingsPage() {
  const { state, ready, saving, saveEntityCommand } = usePortal();
  // Memoized so the joined string is only a new reference when the stored buckets actually change —
  // otherwise every render would hand the hook a "new" server value and defeat the pristine check.
  const storedBuckets = useMemo(
    () => state.settings.estimateBucketsMinutes.join(", "),
    [state.settings.estimateBucketsMinutes]
  );
  const {
    draft: buckets,
    setDraft: setBuckets,
    resetDraft: resetBuckets,
    seededVersion
  } = useServerDraft(storedBuckets, ready, state.settings.version ?? null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);

  async function save(expectedVersion: number | null, estimateBucketsMinutes: number[]) {
    await saveEntityCommand({
      commandId: createClientId(),
      expectedVersion,
      type: "save_entity",
      entityType: "settings",
      entity: { estimateBucketsMinutes }
    });
    resetBuckets(estimateBucketsMinutes.join(", "));
    setError("");
    setConflict(false);
    setSaved(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const estimateBucketsMinutes = parseEstimateBuckets(buckets);
    if (
      !estimateBucketsMinutes.length ||
      estimateBucketsMinutes.some((value) => !Number.isInteger(value) || value < 1 || value > 1_440)
    ) {
      setError("Estimate buckets must be whole minutes between 1 and 1,440.");
      setSaved(false);
      return;
    }
    if (new Set(estimateBucketsMinutes).size !== estimateBucketsMinutes.length) {
      setError("Estimate buckets cannot contain duplicates.");
      setSaved(false);
      return;
    }
    if (!estimateBucketsMinutes.every((value, index, list) => index === 0 || value > list[index - 1]!)) {
      setError("Estimate buckets must be in ascending order.");
      setSaved(false);
      return;
    }
    try {
      await save(seededVersion, estimateBucketsMinutes);
    } catch (reason) {
      if (isVersionConflictError(reason)) {
        setConflict(true);
        setSaved(false);
        return;
      }
      setError(reason instanceof Error ? reason.message : "Estimate buckets were not saved.");
      setSaved(false);
    }
  }

  const reload = () => {
    resetBuckets(storedBuckets);
    setConflict(false);
  };
  const keepMine = async () => {
    const estimateBucketsMinutes = parseEstimateBuckets(buckets);
    try {
      await save(state.settings.version ?? null, estimateBucketsMinutes);
    } catch (reason) {
      if (!isVersionConflictError(reason)) {
        setError(reason instanceof Error ? reason.message : "Estimate buckets were not saved.");
      }
    }
  };

  return (
    <main className="content-page settings-page">
      <SettingsHead
        href="/settings/planning/estimates"
        answer="Quick choices offered when estimating new work, and how finished work adjusts estimates."
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
          Estimate buckets saved.
        </p>
      )}
      <form className="settings-form" onSubmit={submit}>
        <EstimateBucketsSection value={buckets} onChange={setBuckets} />
        <div className="settings-save">
          <button disabled={saving} type="submit">
            {saving ? "Saving…" : "Save estimate buckets"}
          </button>
        </div>
      </form>
      <EstimateCalibrationSection />
    </main>
  );
}
