"use client";

import { isClosedStatus } from "@openrhen/contracts";
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { usePortal } from "@/state/portal-provider";
import { useNow } from "@/shared/clock";
import { clock } from "@/features/now/now-formatting";
import { Field } from "@/components/field";
import { Sheet } from "@/components/sheet";
import { disruptionSourceOptions } from "@/features/disruptions/disruption-draft";
import { DisruptionLine, useInForceDisruption } from "@/features/pulse/components/disruption-line";
import { DisruptionFields } from "@/features/pulse/components/disruption-fields";
import { DisruptionRefusedError, postDisruption, retryableCommandId } from "@/features/pulse/disruption-client";
import {
  EMPTY_DISRUPTION_DRAFT,
  buildDisruptionBody,
  missingDisruption,
  missingSentence,
  type DisruptionDraft
} from "@/features/pulse/disruption-model";
import { rememberDisruption } from "@/features/pulse/disruption-undo";
import { PulseUnknownLine } from "@/features/pulse/components/pulse-unknown-line";
import { pulseIsUnknown, stillDoingQuestion } from "@/features/pulse/pulse-view";
import { answerDeviated, answerOnTrack, answerUnsure } from "../check-in-command";
import { saveDriftReason } from "../drift-reason-client";

/** Below this age a "Still on X?" (or catch-up "What were you doing") prompt is fresh enough to answer
 * with confidence. At or past it, "Not sure" appears as a third, honest answer — A
 * 37-minute-old prompt offered only "On track" or "Something else", forcing a guess about a moment the
 * person could no longer actually recall. */
const STALE_AFTER_MINUTES = 5;

/**
 * "Still on X?" — the ground-truth sample the check-in scheduler asks about the engine's own current
 * belief. One tap for "On track"; "Something else" opens the fuller record: a category (the same
 * buckets Settings → Disruptions edits), an optional note, and an optional different planned task,
 * named for the record only — picking one here never starts or switches anything. Once the sampled
 * moment is more than `STALE_AFTER_MINUTES` in the past, a third tap — "Not sure" — records `unknown`
 * rather than forcing a guess; it is not counted for or against adherence (see `readCheckInSummary`).
 *
 * Rendered at the top of every page that shows a currently running activity or session — Now (both
 * its no-session and its four session branches) and the deliverable workbench — plus, on Now's own
 * no-session view, above the directive alongside `RenegotiationPanel`. One shared component, one
 * provider-level `pendingCheckIn`: answering it on any page dismisses it everywhere. Renders nothing
 * when `pendingCheckIn` is null.
 */
export function CheckInBanner() {
  return (
    <>
      <DisruptionLine />
      <CheckInPrompt />
    </>
  );
}

function CheckInPrompt() {
  const { state, pendingCheckIn: providerCheckIn, dismissPendingCheckIn, acceptServerState } = usePortal();
  const now = useNow("minute");
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<"work" | "family" | "life_admin" | "other" | "">("");
  const [note, setNote] = useState("");
  // The words for "What pulled you off?". They are saved by their own owner-only route and never touch the note or the answer command.
  const [reason, setReason] = useState("");
  const reasonSlot = useRef<{ key: string; id: string } | null>(null);
  // The check-in is answered but its reason is not saved yet: the sheet stays open with the words, a retry and Skip.
  const [answered, setAnswered] = useState(false);
  // The check-in whose reason is unsaved, held here (not in the provider) so a refresh that drops the pending check-in cannot take the sheet or the typed words with it. Cleared only when the reason is saved or skipped.
  const [unsaved, setUnsaved] = useState<typeof providerCheckIn>(null);
  const pendingCheckIn = unsaved ?? providerCheckIn;
  const [deviationTargetId, setDeviationTargetId] = useState("");
  const [disruption, setDisruption] = useState<DisruptionDraft>(EMPTY_DISRUPTION_DRAFT);
  const idSlot = useRef<{ key: string; id: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const { disruption: inForce } = useInForceDisruption();

  // A disruption in force explains the gap; the unknown wording would contradict the line above it.
  if (!unsaved && state.pulse && pulseIsUnknown(state.pulse) && inForce) return null;
  // Unknown with no slot to answer: the line says what counts as contact instead.
  if (!pendingCheckIn)
    return state.pulse && pulseIsUnknown(state.pulse) ? <PulseUnknownLine pulse={state.pulse} /> : null;
  const checkIn = pendingCheckIn;
  // A slot the tab missed while it was closed or backgrounded is asked about in the past tense; one
  // still inside its window is asked about the present. Both accept the same three answers.
  // The pulse has gone unknown (a check-in went unanswered): the same row asks "Still doing X? Yes / Something else",
  // and Yes is the on-track answer. "Not sure" is left out, since the plan already is.
  const pulseUnknown = pulseIsUnknown(state.pulse);
  const catchUp = checkIn.status === "unknown" && !pulseUnknown;
  const ageMinutes = (now.getTime() - new Date(checkIn.slotAt).getTime()) / 60_000;
  const stale = ageMinutes >= STALE_AFTER_MINUTES && !pulseUnknown;

  async function onTrack() {
    setSubmitting(true);
    setError("");
    try {
      await answerOnTrack(checkIn.id, checkIn.version, "in_app_banner");
      dismissPendingCheckIn();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The check-in was not saved.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onUnsure() {
    setSubmitting(true);
    setError("");
    try {
      await answerUnsure(checkIn.id, checkIn.version, "in_app_banner");
      dismissPendingCheckIn();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The check-in was not saved.");
    } finally {
      setSubmitting(false);
    }
  }

  function startDeviation() {
    setCategory("");
    setNote("");
    setReason("");
    reasonSlot.current = null;
    setAnswered(false);
    setDeviationTargetId("");
    setDisruption(EMPTY_DISRUPTION_DRAFT);
    setError("");
    setOpen(true);
  }

  /** Closes the sheet and the prompt: the reason is saved, skipped, or was never typed. */
  function finish() {
    setOpen(false);
    setAnswered(false);
    setUnsaved(null);
    reasonSlot.current = null;
    dismissPendingCheckIn();
  }

  /** Saves the typed words, if any. False when the save failed: the words stay in the open sheet with the reason. */
  async function saveReason(): Promise<boolean> {
    const words = reason.trim();
    if (!words) return true;
    try {
      await saveDriftReason(checkIn.id, words, retryableCommandId(reasonSlot, words));
      return true;
    } catch (failure) {
      setUnsaved(checkIn);
      setError(failure instanceof Error ? failure.message : "The reason was not saved.");
      return false;
    }
  }

  /** Closing the answered sheet is Skip when nothing was typed; otherwise the words are saved first, with the same failure handling. */
  async function closeAnswered() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      if (await saveReason()) finish();
    } finally {
      setSubmitting(false);
    }
  }

  async function submitDeviation(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      if (!answered) {
        // A deviation stays on plan only with what the plan needs: record that
        // first, then answer the slot. The server names the same fields if this check is bypassed.
        const draft = { ...disruption, targetId: deviationTargetId };
        const at = new Date();
        const missing = missingDisruption(draft, at, state.settings.timezone);
        if (missing.length > 0) return setError(missingSentence(missing));
        const target = state.actions.find((action) => action.id === deviationTargetId);
        const done = await postDisruption(
          buildDisruptionBody(
            draft,
            at,
            state.settings.timezone,
            retryableCommandId(idSlot, JSON.stringify(draft)),
            target?.title
          )
        );
        if (done.state) acceptServerState(done.state);
        idSlot.current = null;
        rememberDisruption({ commandId: done.revertible, doing: done.doing, until: done.until });
        await answerDeviated(
          checkIn.id,
          checkIn.version,
          { ...(category ? { category } : {}), note, ...(deviationTargetId ? { targetId: deviationTargetId } : {}) },
          "sheet"
        );
        setAnswered(true);
        setUnsaved(checkIn);
      }
      // The reason is saved before the sheet closes; a failure keeps the words here instead of losing them.
      if (await saveReason()) finish();
    } catch (problem) {
      setError(
        problem instanceof DisruptionRefusedError && problem.missing.length > 0
          ? missingSentence(problem.missing)
          : problem instanceof Error
            ? problem.message
            : "The check-in was not saved."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="check-in-banner" role="status">
      <p className="reason">
        {pulseUnknown
          ? stillDoingQuestion(state.pulse, checkIn.directiveTitle) +
            // Unknown carries no live "doing", so the title is the one saved when the slot was
            // scheduled and may no longer be what Now recommends: say when it was true.
            (!state.pulse?.doing?.title && checkIn.directiveTitle
              ? ` The plan had you on it at ${clock(new Date(checkIn.slotAt), state.settings.timezone)}.`
              : "")
          : catchUp
            ? `What were you doing around ${clock(new Date(checkIn.slotAt), state.settings.timezone)}?` +
              (checkIn.directiveTitle ? ` At the time, the plan had you on: ${checkIn.directiveTitle}.` : "")
            : `Still on ${checkIn.directiveTitle}?`}
      </p>
      <div className="actions">
        <button disabled={submitting} onClick={() => void onTrack()}>
          {pulseUnknown ? "Yes" : "On track"}
        </button>
        <button className="quiet" disabled={submitting} onClick={startDeviation}>
          Something else
        </button>
        {checkIn.photoRequested && (
          <Link className="button-link" href={`/photo-checkins?checkIn=${encodeURIComponent(checkIn.id)}`}>
            Add a photo
          </Link>
        )}
        {stale && (
          <button className="quiet" disabled={submitting} onClick={() => void onUnsure()}>
            Not sure
          </button>
        )}
      </div>
      {error && !open && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Sheet
        open={open}
        onClose={answered ? () => void closeAnswered() : () => setOpen(false)}
        title="What was it instead?"
      >
        <form className="editor-grid" onSubmit={submitDeviation}>
          {answered && <p>Your check-in was saved. Your reason was not.</p>}
          {!answered && (
            <>
              <Field label="Category" group>
                <div className="disruption-choices">
                  {disruptionSourceOptions(state.settings).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`quiet small${category === option.value ? " selected" : ""}`}
                      aria-pressed={category === option.value}
                      onClick={() => setCategory(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="A different planned task (optional)">
                <select value={deviationTargetId} onChange={(event) => setDeviationTargetId(event.target.value)}>
                  <option value="">None named</option>
                  {state.projects.map((project) => {
                    const items = state.actions.filter(
                      (item) => item.status !== "done" && !isClosedStatus(item.status) && item.projectId === project.id
                    );
                    return items.length ? (
                      <optgroup key={project.id} label={project.title}>
                        {items.map((action) => (
                          <option key={action.id} value={action.id}>
                            {action.title}
                          </option>
                        ))}
                      </optgroup>
                    ) : null;
                  })}
                </select>
              </Field>
            </>
          )}
          <Field label="What pulled you off? (optional)">
            <textarea value={reason} rows={3} onChange={(event) => setReason(event.target.value)} />
          </Field>
          {!answered && (
            <>
              <Field label="Note (optional)">
                <input value={note} onChange={(event) => setNote(event.target.value)} />
              </Field>
              <Field label="What are you doing? (needed unless you named a task)">
                <input
                  value={disruption.doing}
                  onChange={(event) => setDisruption({ ...disruption, doing: event.target.value })}
                />
              </Field>
              <DisruptionFields draft={disruption} onChange={setDisruption} definitions={state.conditionDefinitions} />
            </>
          )}
          <div className="form-actions">
            <button type="submit" disabled={submitting}>
              {answered ? "Try again" : "Save"}
            </button>
            {answered ? (
              <button type="button" className="quiet" disabled={submitting} onClick={finish}>
                Skip
              </button>
            ) : (
              <button type="button" className="quiet" disabled={submitting} onClick={() => setOpen(false)}>
                Cancel
              </button>
            )}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </form>
      </Sheet>
    </section>
  );
}
