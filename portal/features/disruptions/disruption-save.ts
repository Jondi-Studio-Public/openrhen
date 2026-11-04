import type { ActivityCommand, PlanningEntityCommand } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import {
  disruptionContextFrom,
  disruptionEntityFrom,
  disruptionIsLiveNow,
  disruptionRemainingMinutes,
  validateDisruptionDraft,
  type DisruptionDraft
} from "./disruption-draft";

/**
 * Saving a disruption. It is deliberately the commitment route and not the capture route: a capture
 * is a thought waiting to be classified and changes nothing, while a disruption has already taken the
 * time and the plan has to be recomputed around it. The write is therefore one ordinary `save_entity`
 * for a confirmed commitment, and the replan the store already enqueues for those does the rest.
 *
 * A disruption that is live right now — its window already open, per `disruptionIsLiveNow` — is also
 * offered a `start_activity` immediately after the save, so "I'm logging this as happening" and "I'm
 * not tracking time on it" stop meaning the same thing on the Now page. That second
 * command is best-effort: its failure never undoes or retries the save.
 */
export interface DisruptionSaveDeps {
  state: PortalState;
  /** The clock the caller is reading, so the block it books and `landedAt` agree with the page. */
  now: Date;
  saveEntityCommand: (command: PlanningEntityCommand) => Promise<void>;
  runActivityCommand: (command: ActivityCommand) => Promise<void>;
  /** The capture sheet's "Track time on it" checkbox. Ignored when the window is not live, or when
   * another session is already open — both of those are decided here too, not just in the checkbox's
   * own disabled state, so a caller that skips the UI still gets the right answer. */
  track: boolean;
}

export interface DisruptionSaveOutcome {
  /** "" when the disruption was saved; otherwise the reason it was refused, and nothing was sent. */
  error: string;
  /** Set only when the disruption saved but the follow-up `start_activity` failed. */
  trackingError: string;
}

const SAVED: DisruptionSaveOutcome = { error: "", trackingError: "" };

/**
 * Returns `{ error: "" }` when the disruption was saved (whether or not tracking was also started),
 * or the sentence to show the reader in `error` — a refused draft and a rejected command both leave
 * the form open, so the caller needs no exception handling to tell them apart. `trackingError` is the
 * separate, non-blocking channel for "saved, but tracking did not start."
 */
export async function saveDisruptionDraft(
  draft: DisruptionDraft,
  { state, now, saveEntityCommand, runActivityCommand, track }: DisruptionSaveDeps
): Promise<DisruptionSaveOutcome> {
  const context = disruptionContextFrom(state, now);
  const invalid = validateDisruptionDraft(draft, context);
  if (invalid) return { error: invalid, trackingError: "" };
  const id = createClientId();
  try {
    await saveEntityCommand({
      commandId: createClientId(),
      // Always a new record: a disruption is captured once, and its later life is an ordinary edit.
      expectedVersion: null,
      type: "save_entity",
      entityType: "commitment",
      entity: disruptionEntityFrom(draft, id, context)
    });
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : "The disruption was not saved.", trackingError: "" };
  }
  // A second concurrent session is refused server-side (activity-commands.ts's `runActivityCommand`:
  // "Another activity is already open."), so this is not merely an optimisation — sending the command
  // anyway would just trade a clear pre-flight skip for the same refusal after a round trip.
  if (!track || state.activeSession || !disruptionIsLiveNow(draft, context)) return SAVED;
  try {
    await runActivityCommand({
      commandId: createClientId(),
      // The commitment above was just inserted under a fresh, never-before-used id — entity-commands.ts's
      // INSERT for `commitments` never sets `version`, so the column's own DEFAULT 1 is exactly
      // the version this row was created with (platform/database/drizzle/0000_tense_rawhide_kid.sql).
      expectedVersion: 1,
      type: "start_activity",
      targetType: "fixed_commitment",
      targetId: id,
      phase: "active",
      plannedMinutes: disruptionRemainingMinutes(draft, context)
    });
  } catch (cause) {
    return {
      error: "",
      trackingError: `Saved, but time tracking did not start: ${cause instanceof Error ? cause.message : "The activity was not started."}`
    };
  }
  return SAVED;
}
