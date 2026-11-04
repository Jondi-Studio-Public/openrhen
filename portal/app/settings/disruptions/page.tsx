"use client";

import { useMemo, useState, type FormEvent } from "react";
import { usePortal } from "@/state/portal-provider";
import { Field } from "@/components/field";
import { MinuteInput, Section } from "@/features/settings/components/settings-fields";
import type { PlanningSettings } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { isVersionConflictError, useServerDraft } from "@/shared/use-server-draft";
import { SettingsHead } from "@/features/settings/components/settings-head";

type WhenDraft = { id: string; label: string; delayMinutes: number };
type DurationKind = "minutes" | "rest_of_day" | "unknown";
type DurationDraft = { id: string; label: string; kind: DurationKind; minutes: number };

const durationKindLabel: Record<DurationKind, string> = {
  minutes: "Minutes",
  rest_of_day: "Rest of day",
  unknown: "No idea (guesses to bedtime, or an hour if logged after the fact)"
};

function move<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/**
 * The presets the disruption capture form offers, edited here so the fast, one-handed form on Now
 * never hardcodes them. The four kinds keep their fixed set — only the label is yours to change — the
 * same way `commitments`'s CHECK constraint fixes them server-side; when and duration are free
 * lists, add, remove and reorder included.
 */
export default function DisruptionSettingsPage() {
  const { state, ready, saving, saveEntityCommand } = usePortal();
  const settingsVersion = state.settings.version ?? null;
  const {
    draft: kindLabels,
    setDraft: setKindLabels,
    resetDraft: resetKindLabels,
    markPristine: markKindLabelsPristine,
    seededVersion: kindLabelsVersion
  } = useServerDraft<PlanningSettings["disruptionKindLabels"]>(
    state.settings.disruptionKindLabels,
    ready,
    settingsVersion
  );
  const {
    draft: whens,
    setDraft: setWhens,
    resetDraft: resetWhens,
    markPristine: markWhensPristine,
    seededVersion: whensVersion
  } = useServerDraft<WhenDraft[]>(state.settings.disruptionWhenPresets, ready, settingsVersion);
  // Memoized so the mapped array is only a new reference when the stored presets actually change —
  // otherwise every render would hand the hook a "new" server value and defeat the pristine check.
  const durationsServerValue = useMemo<DurationDraft[]>(
    () => state.settings.disruptionDurationPresets.map((preset) => ({ ...preset, minutes: preset.minutes ?? 60 })),
    [state.settings.disruptionDurationPresets]
  );
  const {
    draft: durations,
    setDraft: setDurations,
    resetDraft: resetDurations,
    markPristine: markDurationsPristine,
    seededVersion: durationsVersion
  } = useServerDraft<DurationDraft[]>(durationsServerValue, ready, settingsVersion);
  const {
    draft: retroFallbackMinutes,
    setDraft: setRetroFallbackMinutes,
    resetDraft: resetRetroFallback,
    markPristine: markRetroFallbackPristine,
    seededVersion: retroFallbackVersion
  } = useServerDraft(state.settings.disruptionRetroFallbackMinutes, ready, settingsVersion);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);

  // The whole page saves as one command, but each section reseeds independently while untouched —
  // so the version this save was actually composed against is the oldest of the four, not the live
  // one: whichever section has been sitting dirty longest is the one a concurrent edit could clash
  // with. A `null` seeded version is not "no opinion" — it means that section's draft was seeded
  // before any version was known, which is the oldest possible state, older than any number. It must
  // win outright over the other three's live versions, not be skipped by them.
  const seededVersion = [kindLabelsVersion, whensVersion, durationsVersion, retroFallbackVersion].reduce<number | null>(
    (oldest, value) => (oldest === null || value === null ? null : Math.min(oldest, value)),
    Infinity
  );

  async function save(expectedVersion: number | null) {
    await saveEntityCommand({
      commandId: createClientId(),
      expectedVersion,
      type: "save_entity",
      entityType: "settings",
      entity: {
        disruptionKindLabels: kindLabels,
        disruptionWhenPresets: whens,
        disruptionDurationPresets: durations.map((item) =>
          item.kind === "minutes" ? item : { id: item.id, label: item.label, kind: item.kind }
        ),
        disruptionRetroFallbackMinutes: retroFallbackMinutes
      }
    });
    markKindLabelsPristine();
    markWhensPristine();
    markDurationsPristine();
    markRetroFallbackPristine();
    setError("");
    setConflict(false);
    setSaved(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (Object.values(kindLabels).some((label) => !label.trim())) {
      setError("Every disruption kind needs a label.");
      setSaved(false);
      return;
    }
    if (!whens.length || whens.some((item) => !item.label.trim())) {
      setError('Add at least one "when" preset, each with a label.');
      setSaved(false);
      return;
    }
    if (!durations.length || durations.some((item) => !item.label.trim())) {
      setError("Add at least one duration preset, each with a label.");
      setSaved(false);
      return;
    }
    if (retroFallbackMinutes < 1 || retroFallbackMinutes > 1_440) {
      setError("The retro fallback must be between 1 and 1,440 minutes.");
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
      setError(reason instanceof Error ? reason.message : "Disruption presets were not saved.");
      setSaved(false);
    }
  }

  const reload = () => {
    resetKindLabels(state.settings.disruptionKindLabels);
    resetWhens(state.settings.disruptionWhenPresets);
    resetDurations(durationsServerValue);
    resetRetroFallback(state.settings.disruptionRetroFallbackMinutes);
    setConflict(false);
  };
  const keepMine = async () => {
    try {
      await save(settingsVersion);
    } catch (reason) {
      if (!isVersionConflictError(reason)) {
        setError(reason instanceof Error ? reason.message : "Disruption presets were not saved.");
      }
    }
  };

  return (
    <main className="content-page settings-page">
      <SettingsHead
        href="/settings/disruptions"
        answer="The kinds, times and lengths the disruption form offers; keep them short, it is filled in one-handed."
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
          Disruption presets saved.
        </p>
      )}
      <form className="settings-form" onSubmit={submit}>
        <Section id="disruption-kinds" featured title="Kinds" reason="The set is fixed; only the label is yours.">
          {(["work", "family", "life_admin", "other"] as const).map((key) => (
            <Field key={key} label={key === "life_admin" ? "Life admin" : key[0]!.toUpperCase() + key.slice(1)} wide>
              <input
                value={kindLabels[key]}
                onChange={(event) => setKindLabels({ ...kindLabels, [key]: event.target.value })}
              />
            </Field>
          ))}
        </Section>
        <Section
          id="disruption-whens"
          title="When it started"
          reason="Offered as buttons; “Earlier today” is always last and opens a time field."
        >
          {whens.map((item, index) => (
            <div className="disruption-preset-row" key={item.id}>
              <Field label="Label">
                <input
                  value={item.label}
                  onChange={(event) =>
                    setWhens(whens.map((row, i) => (i === index ? { ...row, label: event.target.value } : row)))
                  }
                />
              </Field>
              <Field label="Delay (minutes)">
                <MinuteInput
                  value={item.delayMinutes}
                  onChange={(value) =>
                    setWhens(whens.map((row, i) => (i === index ? { ...row, delayMinutes: value } : row)))
                  }
                />
              </Field>
              <div className="disruption-preset-row-actions">
                <button
                  type="button"
                  className="quiet small"
                  disabled={index === 0}
                  onClick={() => setWhens(move(whens, index, -1))}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="quiet small"
                  disabled={index === whens.length - 1}
                  onClick={() => setWhens(move(whens, index, 1))}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="quiet small"
                  disabled={whens.length <= 1}
                  onClick={() => setWhens(whens.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="quiet small"
            onClick={() => setWhens([...whens, { id: createClientId(), label: "", delayMinutes: 0 }])}
          >
            Add a "when" preset
          </button>
        </Section>
        <Section
          id="disruption-durations"
          title="How long"
          reason="A plain length, or one of two guesses: rest of day, or no idea."
        >
          {durations.map((item, index) => (
            <div className="disruption-preset-row" key={item.id}>
              <Field label="Label">
                <input
                  value={item.label}
                  onChange={(event) =>
                    setDurations(durations.map((row, i) => (i === index ? { ...row, label: event.target.value } : row)))
                  }
                />
              </Field>
              <Field label="Kind">
                <select
                  value={item.kind}
                  onChange={(event) =>
                    setDurations(
                      durations.map((row, i) =>
                        i === index ? { ...row, kind: event.target.value as DurationKind } : row
                      )
                    )
                  }
                >
                  {(["minutes", "rest_of_day", "unknown"] as const).map((kind) => (
                    <option key={kind} value={kind}>
                      {durationKindLabel[kind]}
                    </option>
                  ))}
                </select>
              </Field>
              {item.kind === "minutes" && (
                <Field label="Minutes">
                  <MinuteInput
                    value={item.minutes}
                    onChange={(value) =>
                      setDurations(durations.map((row, i) => (i === index ? { ...row, minutes: value } : row)))
                    }
                  />
                </Field>
              )}
              <div className="disruption-preset-row-actions">
                <button
                  type="button"
                  className="quiet small"
                  disabled={index === 0}
                  onClick={() => setDurations(move(durations, index, -1))}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="quiet small"
                  disabled={index === durations.length - 1}
                  onClick={() => setDurations(move(durations, index, 1))}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="quiet small"
                  disabled={durations.length <= 1}
                  onClick={() => setDurations(durations.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="quiet small"
            onClick={() =>
              setDurations([...durations, { id: createClientId(), label: "", kind: "minutes", minutes: 30 }])
            }
          >
            Add a duration preset
          </button>
          <Field label="Retro-log fallback (minutes)">
            <MinuteInput value={retroFallbackMinutes} onChange={setRetroFallbackMinutes} />
            <small>How long a "No idea" disruption is assumed to last when it is logged after the fact.</small>
          </Field>
        </Section>
        <div className="settings-save">
          <button disabled={saving} type="submit">
            {saving ? "Saving…" : "Save disruption presets"}
          </button>
        </div>
      </form>
    </main>
  );
}
