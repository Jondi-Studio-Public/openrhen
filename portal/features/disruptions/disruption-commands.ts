import type { PlanningEntityCommand } from "@openrhen/contracts";
import type { PortalState, StoredCommitment, DailyPlan } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { commitmentEditorFrom, commitmentEntityFrom } from "@/features/today/today-drafts";

/**
 * The open-ended lifecycle: an "Unknown" disruption books a pessimistic guess at how long it runs
 * (`disruption-draft.ts`'s `pessimisticEndAt`), and these two commands are how that guess gets
 * corrected once the truth is known — "Done, heading home" resolves it, "Still out — another hour"
 * pushes the guess further out. Both are ordinary commitment edits; the replan the store already
 * enqueues for a `save_entity` commitment does the rest.
 */
export interface DisruptionCommandDeps {
  state: PortalState;
  /** The clock the caller is reading, so "now" in the saved end time agrees with the page. */
  now: Date;
  saveEntityCommand: (command: PlanningEntityCommand) => Promise<void>;
}

/** A commitment must end after it starts (the same rule `entity-commands.ts` enforces). */
const MIN_DURATION_MS = 60_000;

/** Whether this commitment is a disruption still holding an open, guessed end. */
export const isOpenEndedDisruption = (commitment: StoredCommitment): boolean =>
  commitment.origin === "disruption" && commitment.disruptionOpenEnded === true;

/**
 * The edit payload for both actions below: the stored commitment round-tripped through the same
 * editor mappers the commitment page uses, so title/location/locationId/buffers/presence all survive
 * — the UPDATE in `entity-commands.ts` writes `location` and the buffers unconditionally from the
 * payload, so a partial payload would blank them.
 *
 * `commitmentEntityFrom` deliberately says nothing about `origin`/`disruptionSource`/`landedAt`;
 * COALESCE on the write side reads that silence as "leave it alone" and keeps the stored disruption
 * provenance. `disruptionOpenEnded` is the one field these two commands exist to change, so unlike
 * the other three it has to be sent explicitly or it would never move.
 */
function editedEntity(
  commitment: StoredCommitment,
  state: PortalState,
  endsAt: Date,
  openEnded: boolean
): Record<string, unknown> {
  const draft = commitmentEditorFrom(commitment, state.settings);
  return {
    ...commitmentEntityFrom(draft, commitment.id, state.settings.timezone),
    endsAt: endsAt.toISOString(),
    disruptionOpenEnded: openEnded
  };
}

async function saveEdit(
  commitment: StoredCommitment,
  entity: Record<string, unknown>,
  { saveEntityCommand }: DisruptionCommandDeps,
  fallback: string
): Promise<string> {
  try {
    await saveEntityCommand({
      commandId: createClientId(),
      // The version comes off `commitment` itself, the exact record `entity` was composed from —
      // deliberately not a fresh `state.commitments` lookup, which would be the bug. `versionIn`
      // is for resolving a version out of a collection; a record already in hand coalesces here.
      expectedVersion: commitment.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity
    });
    return "";
  } catch (cause) {
    return cause instanceof Error ? cause.message : fallback;
  }
}

/**
 * "Done, heading home." Ends the disruption now — or a minute after it started, if `now` has not
 * caught up with it yet, since the DB rejects `endsAt <= startsAt` — and clears the open end: the
 * guess is over, this is what actually happened.
 */
export async function endDisruptionNow(commitment: StoredCommitment, deps: DisruptionCommandDeps): Promise<string> {
  const floor = new Date(commitment.startsAt).getTime() + MIN_DURATION_MS;
  const endsAt = new Date(Math.max(deps.now.getTime(), floor));
  return saveEdit(
    commitment,
    editedEntity(commitment, deps.state, endsAt, false),
    deps,
    "The disruption was not ended."
  );
}

/**
 * "Still out — another hour" (also reused by "Shorten the disruption" with a negative `minutes`).
 * Nudges the end by `minutes` (negative shrinks it — "it's wrapping up" or "it's actually shorter
 * than I thought" — and is allowed to land before `now`), floored a minute after the disruption
 * started. Preserves the commitment's existing open-ended flag rather than forcing it — the
 * "still out" callers only ever reach this while the disruption is already open-ended, so the end
 * is still a guess, just a different one; "Shorten the disruption" can be called on a closed-end
 * disruption too, and shrinking its known end must not flip it into an open guess.
 */
export async function extendDisruption(
  commitment: StoredCommitment,
  minutes: number,
  deps: DisruptionCommandDeps
): Promise<string> {
  const floor = new Date(commitment.startsAt).getTime() + MIN_DURATION_MS;
  const endsAt = new Date(Math.max(new Date(commitment.endsAt).getTime() + minutes * 60_000, floor));
  return saveEdit(
    commitment,
    editedEntity(commitment, deps.state, endsAt, commitment.disruptionOpenEnded === true),
    deps,
    "The disruption was not extended."
  );
}

/**
 * Drop one action from today's desired wins by rewriting the whole `daily_plan` entity.
 * Carries `existingPlan?.deferredItems ?? []` through untouched and reads its version from
 * the same `existingPlan` — which the component computed at render, gated on
 * `state.dailyPlan?.localDate === todayKey`. This is fire-and-forget: the caller does
 * `void dispatch(command)` with no `.catch` and nobody awaits it.
 */
export function dropDesiredWinCommand(
  actionId: string,
  todayKey: string,
  existingPlan: DailyPlan | undefined
): PlanningEntityCommand {
  const desiredWinIds = new Set(existingPlan?.desiredActionIds ?? []);
  return {
    commandId: createClientId(),
    expectedVersion: existingPlan?.version ?? null,
    type: "save_entity",
    entityType: "daily_plan",
    entity: {
      localDate: todayKey,
      desiredActionIds: [...desiredWinIds].filter((id) => id !== actionId),
      deferredItems: existingPlan?.deferredItems ?? []
    }
  };
}
