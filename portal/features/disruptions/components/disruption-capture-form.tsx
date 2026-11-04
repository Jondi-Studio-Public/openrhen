"use client";

import { useState, type FormEvent } from "react";
import type { ActivityCommand, PlanningEntityCommand } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { useNow } from "@/shared/clock";
import { formatZonedTime } from "@/shared/date-format";
import { Field } from "@/components/field";
import { resolveCommitmentContact } from "@/features/commitments/commitment-contact";
import { ContactPicker } from "@/features/commitments/components/contact-picker";
import { ContactMessageComposer } from "@/features/commitments/components/contact-message-composer";
import type { DisruptionPreset } from "@/shared/capture-sheet";
import { createContact, createOneOffPlace } from "@/features/today/commitment-save";
import { LocationPicker } from "@/features/today/components/location-picker";
import { overlaps } from "@/features/today/today-view";
import {
  disruptionContextFrom,
  disruptionDurationOptions,
  disruptionIsLiveNow,
  disruptionSourceOptions,
  disruptionWhenOptions,
  disruptionWindow,
  emptyDisruptionDraft,
  EARLIER_WHEN,
  type DisruptionDraft
} from "../disruption-draft";
import { saveDisruptionDraft } from "../disruption-save";

/**
 * The form for something that has just happened to the day. Everything but the name is a bucket with
 * a defensible default, so the path through it is: type what it is, save. The buckets are buttons
 * rather than selects because this is filled in one-handed, often standing up, and a select costs a
 * second tap and a scroll.
 *
 * The overlap line is a hint and never a refusal: the portal cannot see the plan the engine will
 * produce, and a disruption is true whether or not it collides with something.
 */
export function DisruptionCaptureForm({
  state,
  saveEntityCommand,
  runActivityCommand,
  onSaved,
  preset
}: {
  state: PortalState;
  saveEntityCommand: (command: PlanningEntityCommand) => Promise<void>;
  runActivityCommand: (command: ActivityCommand) => Promise<void>;
  onSaved?: () => void;
  /**
   * Set when this half was opened from a **Let someone know?** offer
   * seeds the draft's contact and shows the "About …" line.
   * Its `reason` and `lateMinutes` word the prefilled message.
   * The contact stays editable either way.
   */
  preset?: DisruptionPreset | undefined;
}) {
  const now = useNow("minute");
  const context = disruptionContextFrom(state, now);
  const [draft, setDraft] = useState<DisruptionDraft>(() => emptyDisruptionDraft(context, preset));
  const contact = resolveCommitmentContact(draft, state.conditionDefinitions);
  const [placing, setPlacing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // The checkbox's own choice. It only ever matters while the window is live and nothing else is
  // already running — both of those are read straight from state below rather than folded into this,
  // so a draft edited back out of "live" always shows the checkbox in the state that fact implies.
  const [track, setTrack] = useState(true);
  const sources = disruptionSourceOptions(state.settings);
  const whens = disruptionWhenOptions(state.settings);
  const durations = disruptionDurationOptions(state.settings);
  const retro = draft.when === EARLIER_WHEN;
  const block = disruptionWindow(draft, context);
  const live = disruptionIsLiveNow(draft, context);
  const runningElsewhere = state.activeSession;
  const trackDisabled = Boolean(runningElsewhere);
  const clash = state.commitments.find(
    (item) =>
      item.status === "confirmed" &&
      overlaps(block.startsAt.toISOString(), block.endsAt.toISOString(), item.startsAt, item.endsAt)
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    const outcome = await saveDisruptionDraft(draft, {
      state,
      now,
      saveEntityCommand,
      runActivityCommand,
      track: track && !trackDisabled
    });
    setSaving(false);
    if (outcome.error) {
      setError(outcome.error);
      return;
    }
    setError(outcome.trackingError);
    setDraft(emptyDisruptionDraft(context));
    setPlacing(false);
    setTrack(true);
    onSaved?.();
  }

  return (
    <form className="disruption-form" onSubmit={submit}>
      <Field label="What came up">
        <input
          autoFocus
          value={draft.title}
          placeholder="Driving Mum to the shops"
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
      </Field>
      <Field label="Kind" group>
        <div className="disruption-choices">
          {sources.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`quiet small${draft.source === option.value ? " selected" : ""}`}
              aria-pressed={draft.source === option.value}
              onClick={() => setDraft({ ...draft, source: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Field>
      <Field label="When" group>
        <div className="disruption-choices">
          {whens.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`quiet small${draft.when === option.value ? " selected" : ""}`}
              aria-pressed={draft.when === option.value}
              onClick={() => setDraft({ ...draft, when: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
        {retro && (
          <input
            type="time"
            aria-label="What time it started"
            value={draft.earlierTime}
            onChange={(event) => setDraft({ ...draft, earlierTime: event.target.value })}
          />
        )}
      </Field>
      <Field label="For how long" group>
        <div className="disruption-choices">
          {durations.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`quiet small${draft.duration === option.value ? " selected" : ""}`}
              aria-pressed={draft.duration === option.value}
              onClick={() => setDraft({ ...draft, duration: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
        <small>
          {formatZonedTime(block.startsAt, context.timezone)} to {formatZonedTime(block.endsAt, context.timezone)}
          {context.settings.disruptionDurationPresets.find((preset) => preset.id === draft.duration)?.kind ===
            "unknown" && !retro
            ? ", until you say otherwise"
            : ""}
        </small>
      </Field>
      {live && (
        <>
          <Field label="Track time on it">
            <input
              type="checkbox"
              checked={!trackDisabled && track}
              disabled={trackDisabled}
              onChange={(event) => setTrack(event.target.checked)}
            />
          </Field>
          {trackDisabled && (
            <p className="microcopy">
              Finish {runningElsewhere?.targetTitle ?? "what's already running"} first to track this.
            </p>
          )}
        </>
      )}
      {placing ? (
        <LocationPicker
          definitions={state.conditionDefinitions}
          locationId={draft.locationId}
          onSelect={(locationId, label) => setDraft({ ...draft, locationId, location: label })}
          onCreateFromSearch={(match) => createOneOffPlace(match, saveEntityCommand)}
        />
      ) : (
        <button type="button" className="quiet small" onClick={() => setPlacing(true)}>
          Add a place…
        </button>
      )}
      {preset?.about && <p className="microcopy">About {preset.about}</p>}
      <ContactPicker
        definitions={state.conditionDefinitions}
        contactId={draft.contactId}
        onSelect={(contactId) => setDraft({ ...draft, contactId })}
        onCreate={(name) => createContact(name, state.conditionDefinitions, saveEntityCommand)}
        label="Who's affected?"
      />
      {contact && (
        <ContactMessageComposer
          key={contact.id}
          contact={contact}
          context={{ reason: preset?.reason, about: preset?.about, lateMinutes: preset?.lateMinutes }}
        />
      )}
      {clash && (
        <p className="form-warning">
          This runs over “{clash.title}” from {formatZonedTime(clash.startsAt, context.timezone)}. Saving is fine — the
          replan decides what gives.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button disabled={saving}>{retro ? "Log it" : "It's happening"}</button>
      </div>
    </form>
  );
}
