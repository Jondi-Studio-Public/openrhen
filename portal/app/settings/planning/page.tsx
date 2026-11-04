"use client";

import { timeZoneOptions } from "@/shared/time-zone-options";
import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { DEFAULT_LOCALE, DISPLAY_LOCALE_OPTIONS, isValidTimeZone } from "@openrhen/contracts";
import { usePortal } from "@/state/portal-provider";
import { Field } from "@/components/field";
import { CapacityPlanningSection } from "@/features/settings/components/capacity-planning-section";
import { RecoverySection } from "@/features/settings/components/recovery-section";
import { Section } from "@/features/settings/components/settings-fields";
import type { PlanningSettings } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { isVersionConflictError, retryFalseConflict, useServerDraft } from "@/shared/use-server-draft";
import { SettingsHead } from "@/features/settings/components/settings-head";

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** A fixed instant, so the date format samples render the same on the server and in the browser. */
const SAMPLE_INSTANT = new Date("2026-03-09T21:00:00Z");

/** The sample instant written in a locale and zone; an unreadable zone falls back to UTC. */
function sampleFor(locale: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit"
  };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(SAMPLE_INSTANT);
  } catch {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(SAMPLE_INSTANT);
  }
}

export { timeZoneOptions };

/**
 * Timezone, the daily planning horizon, and capacity itself: what decides how much of a day the
 * planner is allowed to see and fill. Buffers and estimate buckets are close relatives but each
 * saves on its own page, reached from Settings.
 */
export default function PlanningSettingsPage() {
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
        timezone: draft.timezone,
        locale: draft.locale,
        planningHorizonEnd: draft.planningHorizonEnd,
        defaultUsableFraction: draft.defaultUsableFraction,
        recoveryStartTime: draft.recoveryStartTime,
        recoveryEndTime: draft.recoveryEndTime,
        recoveryWeekdays: draft.recoveryWeekdays
      }
    });
    markPristine();
    setError("");
    setConflict(false);
    setSaved(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!isValidTimeZone(draft.timezone)) {
      setError("Choose a valid IANA timezone, such as Europe/London.");
      setSaved(false);
      return;
    }
    if (!TIME_PATTERN.test(draft.planningHorizonEnd)) {
      setError("Planning horizon end must be a valid time.");
      setSaved(false);
      return;
    }
    if (draft.defaultUsableFraction <= 0 || draft.defaultUsableFraction > 1) {
      setError("Usable capacity must be above 0% and no more than 100%.");
      setSaved(false);
      return;
    }
    if (
      (draft.recoveryStartTime === null) !== (draft.recoveryEndTime === null) ||
      (draft.recoveryStartTime !== null &&
        draft.recoveryEndTime !== null &&
        draft.recoveryStartTime === draft.recoveryEndTime)
    ) {
      setError("Recovery time needs a different start and end; an end before the start runs overnight.");
      setSaved(false);
      return;
    }
    if (
      [draft.recoveryStartTime, draft.recoveryEndTime].some(
        (time) => time !== null && !/^\d\d:(00|15|30|45)$/.test(time)
      )
    ) {
      setError("Recovery time must start and end on a quarter hour.");
      setSaved(false);
      return;
    }
    try {
      await save(seededVersion);
    } catch (reason) {
      if (isVersionConflictError(reason)) {
        try {
          if (
            await retryFalseConflict({
              seeded: seededValue,
              readLatest: () => latestSettings.current,
              keys: [
                "timezone",
                "locale",
                "planningHorizonEnd",
                "defaultUsableFraction",
                "recoveryStartTime",
                "recoveryEndTime",
                "recoveryWeekdays"
              ],
              save
            })
          )
            return;
        } catch (retryReason) {
          setError(retryReason instanceof Error ? retryReason.message : "Planning settings were not saved.");
          setSaved(false);
          return;
        }
        setConflict(true);
        setSaved(false);
        return;
      }
      setError(reason instanceof Error ? reason.message : "Planning settings were not saved.");
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
        setError(reason instanceof Error ? reason.message : "Planning settings were not saved.");
      }
    }
  };

  return (
    <main className="content-page settings-page">
      <SettingsHead
        href="/settings/planning"
        answer="The planner looks seven days ahead while protecting sleep, commitments and places."
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
          Planning settings saved and the seven-day plan was recalculated.
        </p>
      )}
      <form className="settings-form" onSubmit={submit}>
        <Section
          id="timezone-and-horizon"
          featured
          title="Timezone and horizon"
          reason="Where the clock reads from, and how late a day is allowed to run before it counts as tomorrow."
        >
          <Field label="Timezone" wide>
            <input
              list="timezones"
              value={draft.timezone}
              onChange={(event) => patch({ timezone: event.target.value })}
            />
            <datalist id="timezones">
              {timeZoneOptions(draft.timezone).map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </Field>
          <Field label="Date format">
            <select value={draft.locale ?? DEFAULT_LOCALE} onChange={(event) => patch({ locale: event.target.value })}>
              {DISPLAY_LOCALE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {sampleFor(option, draft.timezone)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Planning horizon end">
            <input
              type="time"
              value={draft.planningHorizonEnd}
              onChange={(event) => patch({ planningHorizonEnd: event.target.value })}
            />
            <small>The wall-clock time each day's plan stops reaching past, once nothing sooner remains.</small>
          </Field>
        </Section>
        <CapacityPlanningSection draft={draft} onChange={patch} />
        <RecoverySection draft={draft} onChange={patch} />
        <div className="settings-save">
          <button disabled={saving} type="submit">
            {saving ? "Saving…" : "Save planning settings"}
          </button>
        </div>
      </form>
      <p className="microcopy settings-pointer">
        Buffers and estimate buckets each have their own page, linked from <a href="/settings">Settings</a>.
      </p>
    </main>
  );
}
