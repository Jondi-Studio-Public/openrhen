/**
 * Whether a recurring commitment's occurrence is "in progress" (the commitment timeline design note,
 * "In progress"): getting ready for it or already on the way counts, not only the commitment's own
 * scheduled window. A series save reaching an occurrence in this state needs the person's say-so
 * before it can change that occurrence too — see `OCCURRENCE_IN_PROGRESS_MESSAGE` below and
 * `saveCommitmentRecurrenceRuleCommandSchema`'s `applyToOccurrenceInProgress` flag.
 *
 * Pure, over plain inputs, so it has no dependency on engine code (the engine-boundary rule in
 * The commitment timeline design note holds even though this predicate lives beside the wire
 * contracts, not inside the engine).
 */

/** Every instant may be given as a `Date` or an ISO 8601 string; both are normalised to milliseconds. */
export type OccurrenceInProgressInput = {
  /** The instant the predicate is evaluated at. */
  now: Date | string;
  /** The occurrence's scheduled start, used only as the fallback when `setupStartsAt` is absent. */
  startsAt: Date | string;
  /** The occurrence's scheduled end, used only as the fallback when `effectiveEndsAt` is absent. */
  endsAt: Date | string;
  /**
   * The occurrence's stored timeline `setupStartsAt` (the latest forecast output's
   * `commitmentTimelines`), when one is stored. Falls back to `startsAt` when absent — no stored
   * timeline is the same as "setup has not been computed", not "setup never counts".
   */
  setupStartsAt?: Date | string;
  /**
   * The occurrence's stored timeline `effectiveEndsAt`, when one is stored. Falls back to `endsAt`
   * when absent.
   */
  effectiveEndsAt?: Date | string;
  /** Whether any of the occurrence's preparation steps has started or finished. */
  preparationStarted: boolean;
  /** Whether a session against the occurrence is open. */
  sessionOpen: boolean;
};

function toMillis(instant: Date | string): number {
  return instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
}

/**
 * True when now is at or past the occurrence's setup start (or preparation has started) and now has
 * not yet reached its effective end, or whenever a session against it is open. An open session is
 * live overtime: its effective end is the present instant, which has not passed, so a stored
 * `effectiveEndsAt` computed at the last run can never end it early.
 */
export function occurrenceInProgress(input: OccurrenceInProgressInput): boolean {
  if (input.sessionOpen) return true;
  const now = toMillis(input.now);
  const setupStartsAt = toMillis(input.setupStartsAt ?? input.startsAt);
  const effectiveEndsAt = toMillis(input.effectiveEndsAt ?? input.endsAt);
  const started = now >= setupStartsAt || input.preparationStarted;
  return started && now < effectiveEndsAt;
}

/**
 * The refusal a series save returns (as an `InvalidCommandError`, HTTP 400) when it reaches an
 * occurrence in progress with `applyToOccurrenceInProgress` absent. A readable sentence, because
 * Today shows it raw (it is outside this plan's Touches, so it has no typed transport of its own).
 */
export const OCCURRENCE_IN_PROGRESS_MESSAGE =
  "Part of this series is happening now. Choose whether this change applies to it too.";

/** Whether a command-error message is this specific refusal, for a caller that only sees the message. */
export function isOccurrenceInProgressRefusal(message: string): boolean {
  return message === OCCURRENCE_IN_PROGRESS_MESSAGE;
}
