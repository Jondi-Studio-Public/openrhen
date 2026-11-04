"use client";

import { useState, type FormEvent } from "react";
import type { StoredSleepPlan } from "@/state/portal-state";
import { Field } from "@/components/field";
import { Sheet } from "@/components/sheet";
import { createNight, updateNight } from "@/features/sleep-log/sleep-log-command";
import { dateInput, iso } from "@/features/today/local-datetime";

const STEP_MS = 15 * 60_000;

/** A plausible night for "I forgot to log this": eight hours ending now. */
function defaultNight(): { start: Date; wake: Date } {
  const wake = new Date();
  return { start: new Date(wake.getTime() - 8 * 60 * 60_000), wake };
}

/**
 * One `datetime-local` input plus a −15 / +15 minute stepper pair that nudges the bound Date
 * directly and re-renders the input from it. Most real corrections are "shift this twenty minutes
 * later"; the native picker stays as the fallback for a bigger change.
 */
function SteppedTimeField({
  label,
  value,
  timezone,
  onChange
}: {
  label: string;
  value: Date;
  timezone: string;
  onChange: (next: Date) => void;
}) {
  return (
    <Field label={label}>
      <div className="input-suffix">
        <input
          type="datetime-local"
          value={dateInput(value.toISOString(), timezone)}
          onChange={(event) => {
            if (event.target.value) onChange(new Date(iso(event.target.value, timezone)));
          }}
        />
        <span className="stepper-buttons">
          <button
            type="button"
            className="quiet small"
            aria-label={`${label}, 15 minutes earlier`}
            onClick={() => onChange(new Date(value.getTime() - STEP_MS))}
          >
            −15
          </button>
          <button
            type="button"
            className="quiet small"
            aria-label={`${label}, 15 minutes later`}
            onClick={() => onChange(new Date(value.getTime() + STEP_MS))}
          >
            +15
          </button>
        </span>
      </div>
    </Field>
  );
}

/**
 * One sheet for both logging a night the app never saw and correcting one it did. A `plan` opens it
 * in edit mode, prefilled from that night's actual times where it has them; `null` opens it empty for
 * a new one. Kept off `TodayFormHost`'s inline-expansion pattern on purpose — a fixed seven-row
 * forward plan can afford a row growing in place, but a scrolling list of up to thirty nights would
 * reflow awkwardly every time one opened.
 */
export function SleepNightSheet({
  open,
  plan,
  timezone,
  onClose,
  onSaved
}: {
  open: boolean;
  /** The night being corrected, or null to log one the app never saw. */
  plan: StoredSleepPlan | null;
  /** The planning timezone: the pickers speak the same wall clock as the list's labels. */
  timezone: string;
  onClose: () => void;
  /** Called after a successful save, so the page can refetch `/api/sleep-log`. */
  onSaved: () => void | Promise<void>;
}) {
  const sleeping = plan?.status === "sleeping";
  const initial = () =>
    plan
      ? {
          start: new Date(plan.actualStartAt ?? plan.plannedStartAt),
          wake: new Date(plan.actualWakeAt ?? plan.plannedWakeAt)
        }
      : defaultNight();
  const [start, setStart] = useState<Date>(() => initial().start);
  const [wake, setWake] = useState<Date>(() => initial().wake);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Every opening starts from that night's own times (or fresh defaults for a new one) rather than
  // whatever the form happened to be left showing from the last night it edited. Done while rendering,
  // against the `open` and `plan` last seen, so the reset lands in the same render that opens the sheet.
  const [seen, setSeen] = useState({ open, plan });
  if (seen.open !== open || seen.plan !== plan) {
    setSeen({ open, plan });
    if (open) {
      const next = initial();
      setStart(next.start);
      setWake(next.wake);
      setError("");
      setSaving(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (plan)
        await updateNight(
          plan.id,
          plan.version ?? null,
          start.toISOString(),
          sleeping ? undefined : wake.toISOString()
        );
      else await createNight(start.toISOString(), wake.toISOString());
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The night was not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={plan ? "Edit this night" : "Add a night"}>
      <form className="editor-grid" onSubmit={submit}>
        <SteppedTimeField label="Sleep starts" value={start} timezone={timezone} onChange={setStart} />
        {sleeping ? (
          <p className="microcopy wide">
            Still asleep — waking up is recorded from the Now page. This only corrects when the night started.
          </p>
        ) : (
          <SteppedTimeField label="Wake time" value={wake} timezone={timezone} onChange={setWake} />
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save night"}
          </button>
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}
