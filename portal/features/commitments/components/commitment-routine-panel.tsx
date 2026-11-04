"use client";

import { useState, type FormEvent } from "react";
import type { RoutinePreset, StoredCommitment, StoredRoutineStep } from "@/state/portal-state";
import { formatZonedTime } from "@/shared/date-format";
import { Field } from "@/components/field";
import {
  routineProvenance,
  type RoutineProvenance,
  type RoutineSource
} from "@/features/commitments/commitment-routine";
import type { ConditionDefinition } from "@/features/settings/context-summary";

/** The fields a step edit may change. Everything else is carried through untouched. */
export interface RoutineStepEdit {
  title: string;
  durationMinutes: number;
  timingRule: StoredRoutineStep["timingRule"];
  maxLeadMinutes: number;
  phase: StoredRoutineStep["phase"];
  energy: StoredRoutineStep["energy"];
}

/** The three sources a person can choose. `custom` is arrived at by tweaking, never selected. */
const CHOICES: { value: Exclude<RoutineSource, "custom">; label: string }[] = [
  { value: "inherit", label: "Follow place default" },
  { value: "preset", label: "Use a different routine…" },
  { value: "none", label: "Remove routine" }
];

/**
 * Where this commitment's preparation comes from, and the steps it currently has.
 *
 * The chip states the provenance in the same terms the replan resolves it in, because "why did my
 * routine change" is the question this section exists to answer. Choosing a source writes it
 * through the commitment command; the steps themselves only follow on the next recalculation, so
 * the page recalculates straight after saving rather than leaving the reader looking at steps that
 * contradict the chip above them.
 *
 * Editing any step detaches the commitment to `custom` server-side. Nothing here sends that flag —
 * it is a consequence of the edit, and the chip re-reads it from the state that comes back.
 */
export function CommitmentRoutinePanel({
  commitment,
  steps,
  presets,
  conditionDefinitions,
  timezone,
  saving,
  onSaveSource,
  onSaveStep
}: {
  commitment: StoredCommitment;
  steps: StoredRoutineStep[];
  presets: RoutinePreset[];
  conditionDefinitions: ConditionDefinition[];
  timezone: string;
  saving: boolean;
  onSaveSource: (source: RoutineSource, presetId: string) => Promise<void>;
  onSaveStep: (step: StoredRoutineStep, edit: RoutineStepEdit) => Promise<void>;
}) {
  const provenance = routineProvenance(commitment, conditionDefinitions, presets);
  const owned = presets.filter((preset) => preset.status === "active" || preset.id === commitment.routinePresetId);
  const [choice, setChoice] = useState<Exclude<RoutineSource, "custom"> | "">(
    provenance.source === "custom" ? "" : provenance.source
  );
  const [presetId, setPresetId] = useState(commitment.routinePresetId ?? owned[0]?.id ?? "");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function applySource(event: FormEvent) {
    event.preventDefault();
    if (!choice) return setError("Choose where this routine should come from.");
    if (choice === "preset" && !presetId) return setError("Choose the routine to use.");
    setError("");
    try {
      await onSaveSource(choice, choice === "preset" ? presetId : "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The routine source was not saved.");
    }
  }

  return (
    <section className="commitment-section commitment-routine" aria-labelledby="commitment-routine-heading">
      <div className="section-heading">
        <h2 id="commitment-routine-heading">Routine</h2>
        <span>{steps.length}</span>
      </div>
      <ProvenanceChip provenance={provenance} />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <form className="editor-grid" onSubmit={applySource}>
        <Field label="Where this routine comes from" wide group>
          <div className="choice-list">
            {CHOICES.map((option) => (
              <label key={option.value}>
                <input
                  type="radio"
                  name="commitment-routine-source"
                  value={option.value}
                  checked={choice === option.value}
                  onChange={() => setChoice(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </Field>
        {choice === "preset" && (
          <Field label="Routine to use">
            <select value={presetId} onChange={(event) => setPresetId(event.target.value)}>
              <option value="">Choose a routine</option>
              {owned.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="form-actions">
          <button type="submit" disabled={saving}>
            Apply
          </button>
        </div>
        <p className="microcopy">
          The steps follow on the next recalculation, so applying recalculates the plan straight away.
          {provenance.source === "custom"
            ? " This commitment has been customized, so choosing a source here replaces the steps it was given by hand."
            : ""}
        </p>
      </form>
      {steps.length ? (
        steps.map((step) => (
          <RoutineStepRow
            key={step.id}
            step={step}
            timezone={timezone}
            saving={saving}
            editing={editingId === step.id}
            onEdit={() => setEditingId(step.id)}
            onCancel={() => setEditingId(null)}
            onSave={async (edit) => {
              await onSaveStep(step, edit);
              setEditingId(null);
            }}
          />
        ))
      ) : (
        <p className="empty">This commitment has no preparation steps.</p>
      )}
    </section>
  );
}

/** The one line that says where the steps came from, in the words the replan would use. */
export function ProvenanceChip({ provenance }: { provenance: RoutineProvenance }) {
  return (
    <p className="provenance-chip" data-routine-source={provenance.source} data-provenance={provenance.short}>
      {provenance.label}
    </p>
  );
}

function RoutineStepRow({
  step,
  timezone,
  saving,
  editing,
  onEdit,
  onCancel,
  onSave
}: {
  step: StoredRoutineStep;
  timezone: string;
  saving: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (edit: RoutineStepEdit) => Promise<void>;
}) {
  const [draft, setDraft] = useState<RoutineStepEdit>(() => ({
    title: step.title,
    durationMinutes: step.durationMinutes,
    timingRule: step.timingRule,
    maxLeadMinutes: step.maxLeadMinutes ?? 600,
    phase: step.phase,
    energy: step.energy
  }));
  const [error, setError] = useState("");
  const slot =
    step.scheduledStartAt && step.scheduledEndAt
      ? `${formatZonedTime(step.scheduledStartAt, timezone)}–${formatZonedTime(step.scheduledEndAt, timezone)}`
      : "not scheduled";
  if (!editing)
    return (
      <article className="row-card" data-step-id={step.id}>
        <div>
          <strong>{step.title}</strong>
          <p>
            {step.phase === "after" ? "After" : "Before"} · {step.durationMinutes} min · {step.timingRule}
            {step.timingRule === "flexible" && step.maxLeadMinutes
              ? ` within ${Math.round(step.maxLeadMinutes / 60)}h`
              : ""}{" "}
            · {slot}
          </p>
        </div>
        <div className="row-actions">
          <span>{step.status}</span>
          <button type="button" className="quiet small" onClick={onEdit}>
            Edit {step.title}
          </button>
        </div>
      </article>
    );
  return (
    <form
      className="editor-grid row-card"
      data-step-id={step.id}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!draft.title.trim()) return setError("Name the step.");
        setError("");
        try {
          await onSave({ ...draft, title: draft.title.trim() });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "The step was not saved.");
        }
      }}
    >
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Field label="Step name">
        <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
      </Field>
      <Field label="Duration minutes">
        <input
          type="number"
          min="1"
          value={draft.durationMinutes}
          onChange={(event) => setDraft({ ...draft, durationMinutes: Number(event.target.value) })}
        />
      </Field>
      <Field label="When">
        <select
          value={draft.phase}
          onChange={(event) => setDraft({ ...draft, phase: event.target.value as RoutineStepEdit["phase"] })}
        >
          <option value="before">Before the commitment</option>
          <option value="after">After the commitment</option>
        </select>
      </Field>
      <Field label="Timing">
        <select
          value={draft.timingRule}
          onChange={(event) => setDraft({ ...draft, timingRule: event.target.value as RoutineStepEdit["timingRule"] })}
        >
          <option value="contiguous">Must be directly before</option>
          <option value="flexible">Can happen within a lead window</option>
        </select>
      </Field>
      {draft.timingRule === "flexible" && (
        <Field label="Maximum lead minutes">
          <input
            type="number"
            min="1"
            value={draft.maxLeadMinutes}
            onChange={(event) => setDraft({ ...draft, maxLeadMinutes: Number(event.target.value) })}
          />
        </Field>
      )}
      <Field label="Energy">
        <select
          value={draft.energy}
          onChange={(event) => setDraft({ ...draft, energy: event.target.value as RoutineStepEdit["energy"] })}
        >
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="recovery">Recovery</option>
        </select>
      </Field>
      <div className="form-actions">
        <button type="submit" disabled={saving}>
          Save step
        </button>
        <button type="button" className="quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="microcopy">
        Changing a step here detaches this commitment from its routine and marks it customized.
      </p>
    </form>
  );
}
