"use client";

import { selectableProjects } from "@/features/plan/area-grouping";
import { useState, type FormEvent } from "react";
import type { StoredCommitment, StoredProject } from "@/state/portal-state";
import { formatZonedTime } from "@/shared/date-format";
import { resolveCommitmentContact } from "@/features/commitments/commitment-contact";
import { monthAnchorOptions } from "@/features/commitments/commitment-routine";
import { ContactPicker } from "@/features/commitments/components/contact-picker";
import { clock } from "@/features/now/now-formatting";
import type { HandEntryMatch } from "@/features/today/commitment-save";
import { iso } from "@/features/today/local-datetime";
import { placeOptions, type ConditionDefinition } from "@/features/settings/context-summary";
import { weekdayOfDate, type CommitmentEditorDraft } from "@/features/today/today-drafts";
import { Field } from "@/components/field";
import { FormActions, useSubmitGuard } from "@/components/form-actions";
import { LocationPicker, type GeocodeMatch } from "@/features/today/components/location-picker";
import { CheckInAllowanceField } from "@/features/pulse/components/check-in-allowance-field";
import { openCaptureSheet } from "@/shared/use-capture-sheet";

/** Monday first, Sunday last; values are 0 = Sunday .. 6 = Saturday. */
const WEEKDAY_CHOICES = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" }
];

/**
 * The one commitment form. A Repeats toggle switches its middle between a single dated block
 * (starts/ends, with the overlap warning) and a repeating rule (first date, interval, wall-clock
 * times, optional last date). Editing an existing record locks the toggle to what the record is,
 * because a stored one-off and a stored series are different records with different commands.
 */
export function CommitmentEditor({
  draft,
  onChange,
  onSubmit,
  onCancel,
  onCreatePlaceFromSearch,
  onCreateContact,
  projects,
  definitions = [],
  overlapCommitment,
  handEntryMatch,
  onSaveAnyway,
  timezone,
  open = Boolean(draft.id),
  openPrep = [],
  onCancelPrep,
  storedStatus
}: {
  draft: CommitmentEditorDraft;
  onChange: (draft: CommitmentEditorDraft) => void;
  /** May resolve to `true` once the save succeeded; only then is the cancel-prep offer made. */
  onSubmit: (event: FormEvent) => void | boolean | Promise<void | boolean>;
  onCancel: () => void;
  /** Stores a picked place-search result as a quiet one-off place; resolves to what to select. */
  onCreatePlaceFromSearch: (match: GeocodeMatch) => Promise<{ id: string; name: string }>;
  /** Saves a typed name as a new (or existing) contact condition; resolves to what to select. */
  onCreateContact: (name: string) => Promise<{ id: string; name: string }>;
  projects: StoredProject[];
  /** Context definitions; the place picker offers the active locations among them. */
  definitions?: ConditionDefinition[];
  /** The confirmed commitment a one-off draft would collide with, if any. */
  overlapCommitment?: StoredCommitment | undefined;
  /**
   * An existing commitment the new one-off looks like.
   * Advisory: the notice offers **Open it** and **Save anyway** and never blocks the form.
   */
  handEntryMatch?: HandEntryMatch | null;
  /** **Save anyway**: saves the draft without asking again. */
  onSaveAnyway?: () => void | Promise<unknown>;
  timezone: string;
  /** Whether the card is unfolded; open while editing by default, and a sheet holds it open. */
  open?: boolean;
  /** The commitment's prep that is still open, for the offer made when a save cancels it. */
  openPrep?: { id: string; title: string }[];
  /** **Cancel prep**: cancels the commitment's open prep; rejects with the reason it could not. */
  onCancelPrep?: () => Promise<void>;
  /** The status the commitment had when the editor was opened; the offer is made only on a change to cancelled. */
  storedStatus?: string;
}) {
  const time = (value: string) => formatZonedTime(value, timezone);
  const editing = Boolean(draft.id);
  const summary = editing ? (draft.repeats ? "Edit recurring commitment" : "Edit commitment") : "Add commitment";
  // "The editor is the only place a cancel happens": a save that
  // turns a one-off or occurrence's status to Cancelled, with a contact that still resolves, keeps a
  // confirmation on screen offering to open the disruption sheet with that contact already chosen.
  // Nothing here reads whether the save actually succeeded — the caller's own error banner already
  // covers that — so a failed save simply also shows this, which is no worse than the caller's own
  // "closed either way" behaviour before this note.
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  // "Cancel its N open prep actions too?" (email-reasoning §7): counted when the cancelling save is
  // sent, then answered once; the count is what the person was shown, not a live figure.
  const [prepOffer, setPrepOffer] = useState<{ count: number; state: "asking" | "busy" | "done" | "kept" } | null>(
    null
  );
  const [prepError, setPrepError] = useState("");
  const places = placeOptions(definitions, draft.preferredLocationId);
  const cancelledContact = resolveCommitmentContact({ contactId: draft.contactId }, definitions);
  async function handleSubmit(event: FormEvent) {
    const willConfirm = !draft.repeats && draft.status === "cancelled" && Boolean(cancelledContact);
    // Read before the save: the offer is about this save turning the commitment cancelled.
    const cancelling =
      !draft.repeats &&
      draft.status === "cancelled" &&
      storedStatus !== "cancelled" &&
      openPrep.length > 0 &&
      Boolean(onCancelPrep);
    const count = openPrep.length;
    const saved = onSubmit(event);
    setConfirmingCancel(willConfirm);
    setPrepOffer(null);
    setPrepError("");
    // Cancelling prep writes, so unlike the contact offer it waits for a save that actually succeeded.
    if ((await saved) === true && cancelling) setPrepOffer({ count, state: "asking" });
  }
  const guard = useSubmitGuard(handleSubmit);
  return (
    <details className="editor-card" open={open}>
      <summary>{summary}</summary>
      <form className="editor-grid" onSubmit={guard.onSubmit}>
        <Field label="Title">
          <input value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} />
        </Field>
        <Field label="Project">
          <select value={draft.projectId} onChange={(event) => onChange({ ...draft, projectId: event.target.value })}>
            <option value="">None</option>
            {selectableProjects(projects, draft.projectId).map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </Field>
        <LocationPicker
          definitions={definitions}
          locationId={draft.locationId}
          onSelect={(locationId, label) => onChange({ ...draft, locationId, location: label })}
          onCreateFromSearch={onCreatePlaceFromSearch}
        />
        <ContactPicker
          definitions={definitions}
          contactId={draft.contactId}
          onSelect={(contactId) => onChange({ ...draft, contactId })}
          onCreate={onCreateContact}
        />
        {/* Attendance belongs to one commitment or occurrence: a series rule has nowhere to keep it. */}
        {!draft.repeats && (
          <Field label="Attendance">
            <select
              value={draft.attendance}
              onChange={(event) =>
                onChange({ ...draft, attendance: event.target.value as CommitmentEditorDraft["attendance"] })
              }
            >
              <option value="in_person">In person</option>
              <option value="remote">Remote</option>
            </select>
          </Field>
        )}
        {!draft.repeats && draft.attendance === "remote" && (
          <Field label="Preferred location">
            <select
              value={draft.preferredLocationId}
              onChange={(event) => onChange({ ...draft, preferredLocationId: event.target.value })}
            >
              <option value="">No preference</option>
              {places.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!editing && (
          <Field label="Repeats">
            <input
              type="checkbox"
              checked={draft.repeats}
              onChange={(event) => onChange({ ...draft, repeats: event.target.checked })}
            />
          </Field>
        )}
        {draft.repeats ? (
          <>
            <Field label="First occurrence date">
              <input
                type="date"
                value={draft.startDate}
                onChange={(event) => onChange({ ...draft, startDate: event.target.value })}
              />
            </Field>
            <Field label="Repeat unit">
              <select
                value={draft.repeatUnit}
                onChange={(event) => {
                  const repeatUnit = event.target.value as CommitmentEditorDraft["repeatUnit"];
                  // A days rule that is a whole number of weeks keeps its count: every 14 days becomes every 2 weeks.
                  const intervalWeeks =
                    repeatUnit === "weeks" && draft.repeatUnit === "days" && draft.intervalDays % 7 === 0
                      ? Math.max(1, draft.intervalDays / 7)
                      : draft.intervalWeeks;
                  onChange({ ...draft, repeatUnit, intervalWeeks });
                }}
              >
                <option value="days">Every N days</option>
                <option value="weeks">Every N weeks</option>
                <option value="months">Every N months</option>
              </select>
            </Field>
            {draft.repeatUnit === "months" ? (
              <>
                <Field label="Every how many months">
                  <input
                    type="number"
                    min="1"
                    value={draft.intervalMonths}
                    onChange={(event) => onChange({ ...draft, intervalMonths: Number(event.target.value) })}
                  />
                </Field>
                <Field label="On">
                  <select
                    value={draft.monthAnchor}
                    onChange={(event) =>
                      onChange({ ...draft, monthAnchor: event.target.value as CommitmentEditorDraft["monthAnchor"] })
                    }
                  >
                    {monthAnchorOptions(draft.startDate).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            ) : draft.repeatUnit === "weeks" ? (
              <>
                <Field label="Every how many weeks">
                  <input
                    type="number"
                    min="1"
                    value={draft.intervalWeeks}
                    onChange={(event) => onChange({ ...draft, intervalWeeks: Number(event.target.value) })}
                  />
                </Field>
                <Field label="On these days" wide group>
                  <div className="weekday-row">
                    {WEEKDAY_CHOICES.map((choice) => {
                      const isStartDay = weekdayOfDate(draft.startDate) === choice.value;
                      return (
                        <label key={choice.value} title={isStartDay ? "the start date's day" : undefined}>
                          <input
                            type="checkbox"
                            checked={isStartDay || draft.weekdays.includes(choice.value)}
                            disabled={isStartDay}
                            onChange={(event) =>
                              onChange({
                                ...draft,
                                weekdays: event.target.checked
                                  ? [...new Set([...draft.weekdays, choice.value])].sort((a, b) => a - b)
                                  : draft.weekdays.filter((day) => day !== choice.value)
                              })
                            }
                          />
                          {choice.label}
                        </label>
                      );
                    })}
                  </div>
                  <small>The first date&apos;s day is always included.</small>
                </Field>
              </>
            ) : (
              <Field label="Repeats every (days)">
                <input
                  type="number"
                  min="1"
                  value={draft.intervalDays}
                  onChange={(event) => onChange({ ...draft, intervalDays: Number(event.target.value) })}
                />
              </Field>
            )}
            <Field label="Local start time">
              <input
                type="time"
                value={draft.localStartTime}
                onChange={(event) => onChange({ ...draft, localStartTime: event.target.value })}
              />
            </Field>
            <Field label="Local end time">
              <input
                type="time"
                value={draft.localEndTime}
                onChange={(event) => onChange({ ...draft, localEndTime: event.target.value })}
              />
            </Field>
            <Field label="Last date (optional)">
              <input
                type="date"
                value={draft.endDate}
                onChange={(event) => onChange({ ...draft, endDate: event.target.value })}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="Starts">
              <input
                type="datetime-local"
                value={draft.startsAt}
                onChange={(event) => onChange({ ...draft, startsAt: event.target.value })}
              />
            </Field>
            <Field label="Ends">
              <input
                type="datetime-local"
                value={draft.endsAt}
                onChange={(event) => onChange({ ...draft, endsAt: event.target.value })}
              />
            </Field>
          </>
        )}
        <Field label="Setup before (minutes)">
          <input
            type="number"
            min="0"
            value={draft.setupBeforeMinutes}
            onChange={(event) => onChange({ ...draft, setupBeforeMinutes: Number(event.target.value) })}
          />
        </Field>
        <Field label="Transition after (minutes)">
          <input
            type="number"
            min="0"
            value={draft.transitionAfterMinutes}
            onChange={(event) => onChange({ ...draft, transitionAfterMinutes: Number(event.target.value) })}
          />
        </Field>
        {/*
          The whole feature, asked as a question about the time rather than about the schedule: the
          plan reserves the block either way, so the only thing being answered here is whether the
          hours inside it are yours.
        */}
        <Field label="While there">
          <select
            value={draft.presence}
            onChange={(event) =>
              onChange({ ...draft, presence: event.target.value as CommitmentEditorDraft["presence"] })
            }
          >
            <option value="blocking">Fully occupied</option>
            <option value="anchor">Free to do other things between obligations</option>
          </select>
        </Field>
        <Field label="Share with family calendar">
          <input
            type="checkbox"
            checked={draft.shareToCalendar}
            onChange={(event) => onChange({ ...draft, shareToCalendar: event.target.checked })}
          />
        </Field>
        {/*
          Pulse privacy: effective privacy is
          this OR the project's (and its area's) — this editor has no `areas`/`outcomes` of its own,
          so it shows only its own flag rather than an inherited-through-project state; a private
          project still hides this commitment either way, the inheritance is just not previewed here.
        */}
        <Field label="Private">
          <input
            type="checkbox"
            checked={draft.private}
            onChange={(event) => onChange({ ...draft, private: event.target.checked })}
          />
        </Field>
        <p className="microcopy">Hides this {draft.repeats ? "series" : "commitment"} from the published pulse.</p>
        {/*
          Both travel fields: whether a late arrival
          matters decides which percentile the leg is planned at, and the mode picks how it is
          measured. Neither has anywhere else to live — a one-off commitment has no rule row, and a
          series occurrence's own field overlays the rule's the same way title or place would.
        */}
        <Field label="Lateness matters">
          <input
            type="checkbox"
            checked={draft.latenessMatters}
            onChange={(event) => onChange({ ...draft, latenessMatters: event.target.checked })}
          />
        </Field>
        <Field label="Travel by">
          <select
            value={draft.transportMode}
            onChange={(event) =>
              onChange({ ...draft, transportMode: event.target.value as CommitmentEditorDraft["transportMode"] })
            }
          >
            <option value="">Usual</option>
            <option value="car">Car</option>
            <option value="bike">Bike</option>
            <option value="walk">Walk</option>
          </select>
        </Field>
        {/*
          Prompt policy lives on the commitment row itself, not the recurring rule, so a repeating
          series has nowhere of its own to hold it — each materialized occurrence keeps whatever it
          was individually set to. Shown only while editing one of those occurrences.
        */}
        {!draft.repeats && (
          <Field label="Check-in prompts">
            <select
              value={draft.promptPolicy}
              onChange={(event) =>
                onChange({ ...draft, promptPolicy: event.target.value as CommitmentEditorDraft["promptPolicy"] })
              }
            >
              <option value="normal">Normal</option>
              <option value="reduced">Reduced (about hourly)</option>
              <option value="silent">Silent</option>
            </select>
          </Field>
        )}
        <CheckInAllowanceField
          value={draft.checkInExtraMinutes}
          onChange={(checkInExtraMinutes) => onChange({ ...draft, checkInExtraMinutes })}
        />
        {draft.repeats ? (
          <Field label="Status">
            <select
              value={draft.ruleStatus}
              onChange={(event) =>
                onChange({ ...draft, ruleStatus: event.target.value as CommitmentEditorDraft["ruleStatus"] })
              }
            >
              <option value="active">Active</option>
              <option value="ended">Ended</option>
            </select>
          </Field>
        ) : (
          <Field label="Status">
            <select
              value={draft.status}
              onChange={(event) => onChange({ ...draft, status: event.target.value as StoredCommitment["status"] })}
            >
              <option value="confirmed">Confirmed</option>
              <option value="tentative">Tentative</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </Field>
        )}
        {!draft.repeats && overlapCommitment && (
          <p className="form-warning">
            This conflicts with “{overlapCommitment.title}” from {time(overlapCommitment.startsAt)} to{" "}
            {time(overlapCommitment.endsAt)}.
          </p>
        )}
        {!editing && !draft.repeats && handEntryMatch && (
          <p className="form-warning" role="status">
            Already on your plan: {handEntryMatch.title}, {clock(new Date(handEntryMatch.startsAt), timezone)}.{" "}
            <a href={`/commitments/${encodeURIComponent(handEntryMatch.id)}`}>Open it</a>{" "}
            <button
              type="button"
              className="quiet"
              disabled={guard.pending}
              onClick={() => void guard.run(() => onSaveAnyway?.())}
            >
              Save anyway
            </button>
          </p>
        )}
        <FormActions editing={editing} cancel={onCancel} pending={guard.pending} />
        {prepOffer && prepOffer.state !== "kept" && (
          <p className="reason" role="status">
            {prepOffer.state === "done" ? (
              "Prep cancelled."
            ) : (
              <>
                Cancel its {prepOffer.count} open prep {prepOffer.count === 1 ? "action" : "actions"} too?{" "}
                <button
                  type="button"
                  className="quiet"
                  disabled={prepOffer.state === "busy"}
                  onClick={async () => {
                    setPrepOffer({ ...prepOffer, state: "busy" });
                    try {
                      await onCancelPrep?.();
                      setPrepOffer({ ...prepOffer, state: "done" });
                    } catch (cause) {
                      setPrepError(cause instanceof Error ? cause.message : "The prep was not cancelled.");
                      setPrepOffer({ ...prepOffer, state: "asking" });
                    }
                  }}
                >
                  Cancel prep
                </button>{" "}
                <button
                  type="button"
                  className="quiet"
                  disabled={prepOffer.state === "busy"}
                  onClick={() => setPrepOffer({ ...prepOffer, state: "kept" })}
                >
                  Keep it
                </button>
              </>
            )}
            {prepError && (
              <span className="form-error" role="alert">
                {" "}
                {prepError}
              </span>
            )}
          </p>
        )}
        {confirmingCancel && cancelledContact && (
          <p className="reason" role="status">
            Cancelled.{" "}
            <button
              type="button"
              className="quiet"
              onClick={() =>
                openCaptureSheet("disruption", {
                  contactId: cancelledContact.id,
                  reason: "cancelled",
                  about: `${draft.title} at ${clock(new Date(iso(draft.startsAt, timezone)), timezone)}`
                })
              }
            >
              Let {cancelledContact.name} know?
            </button>
          </p>
        )}
      </form>
    </details>
  );
}
