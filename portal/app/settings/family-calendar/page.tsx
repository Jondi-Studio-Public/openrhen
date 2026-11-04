"use client";

import { useState, type FormEvent } from "react";
import { calendarSinkConnection, primarySourceLabel } from "@openrhen/contracts";
import { usePortal } from "@/state/portal-provider";
import { Field } from "@/components/field";
import { Section } from "@/features/settings/components/settings-fields";
import type { PlanningSettings } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { isVersionConflictError, useServerDraft } from "@/shared/use-server-draft";
import { SettingsHead } from "@/features/settings/components/settings-head";

/**
 * Family calendar sharing settings: the master switch to enable publishing to the calendar provider,
 * the default for roster shifts, and the read-only publish window.
 */
export default function FamilyCalendarSettingsPage() {
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
        calendarShareEnabled: draft.calendarShareEnabled,
        sharePrimaryEvents: draft.sharePrimaryEvents
      }
    });
    markPristine();
    setError("");
    setConflict(false);
    setSaved(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await save(seededVersion);
    } catch (reason) {
      if (isVersionConflictError(reason)) {
        setConflict(true);
        setSaved(false);
        return;
      }
      setError(reason instanceof Error ? reason.message : "Family calendar settings were not saved.");
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
        setError(reason instanceof Error ? reason.message : "Family calendar settings were not saved.");
      }
    }
  };

  // The registry names the shared calendar and the roster; a build with neither reads generically.
  const sink = calendarSinkConnection();
  const sinkCalendar = sink ? `${sink.label} calendar` : "shared calendar";
  const rosterName = primarySourceLabel();
  const windowEnv = sink ? Object.keys(sink.config).find((name) => name.endsWith("PUBLISH_WINDOW_DAYS")) : undefined;

  return (
    <main className="content-page settings-page">
      <SettingsHead
        href="/settings/family-calendar"
        answer={`Share chosen commitments with the household ${sinkCalendar}, and decide which imported events are shared by default.`}
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
          Family calendar settings saved.
        </p>
      )}
      <form className="settings-form" onSubmit={submit}>
        <Section
          id="family-calendar-main"
          title="Publishing"
          reason={`Enable or disable sharing your commitments with the household ${sinkCalendar}.`}
        >
          <Field label="Share with family calendar" wide>
            <label>
              <input
                type="checkbox"
                checked={draft.calendarShareEnabled ?? false}
                onChange={(event) => patch({ calendarShareEnabled: event.target.checked })}
              />
              <span>Share chosen commitments with family calendar</span>
            </label>
          </Field>
        </Section>

        <Section
          id="family-calendar-defaults"
          title="Imported event defaults"
          reason={`When events are imported from ${rosterName}, whether they are shared by default.`}
        >
          <Field label={`Share ${rosterName} events`} wide>
            <label>
              <input
                type="checkbox"
                checked={draft.sharePrimaryEvents ?? false}
                onChange={(event) => patch({ sharePrimaryEvents: event.target.checked })}
              />
              <span>{`Share imported ${rosterName} events by default`}</span>
            </label>
          </Field>
        </Section>

        <Section
          id="family-calendar-window"
          title="Publish window"
          reason="The range of dates that can be shared with the family calendar."
        >
          <Field label="Window size" wide>
            <p>
              Configured via deployment: {windowEnv ? <code>{windowEnv}</code> : "the publish window setting"}, default
              90 days.
            </p>
          </Field>
        </Section>

        <div className="settings-save">
          <button disabled={saving} type="submit">
            {saving ? "Saving…" : "Save family calendar settings"}
          </button>
        </div>
      </form>
    </main>
  );
}
