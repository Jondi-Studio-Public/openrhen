import { DEFAULT_LOCATION_STALE_AFTER_MINUTES } from "@openrhen/contracts";
import type postgres from "postgres";

/**
 * Idempotent backstop for the portal's write-time skip (`routine-step-arrival.ts`'s
 * `skipMootRoutineSteps`), which only ever fires exactly once, at the instant a location assertion
 * *changes*. That single edge is structurally missable: arrival recorded before the commitment's
 * window opens, a location re-confirmed rather than changed (nothing there reads as a "change"), or
 * any other timing gap between the assertion and that one transaction. The
 * write-time skip once never fired for a real home-to-class assertion, and the step it should have retired dangled `pending` until the person skipped it by
 * hand.
 *
 * Run once per plan-forecast recompute (`persistDerivedState`) rather than on a timer: recomputes
 * happen on every entity command and validity-boundary tick, which is far more often than "per
 * second" needs to be for this to close the gap on the very next cycle after whatever missed it,
 * while staying a single cheap query the rest of the time (it returns immediately once nothing
 * matches). This is deliberately independent of `directive.ts`'s own fresh-every-selection mootness
 * check — that check is what actually protects the user from ever seeing a stale directive, and would
 * keep doing so even if this swept nothing; this exists so the *stored* step status does not dangle
 * `pending` forever behind it, which matters for anything that reads status directly (history,
 * completedToday, an export) rather than through the engine's live selection.
 *
 * This sweep only marks steps skipped; it never reschedules anything. The engine is the only placer
 * of a pending step's times now, and the recalculation
 * `persistDerivedState` already triggers after every write re-derives the whole chain — a skipped
 * step pulling its surviving siblings earlier is just what that next run's placement does, seconds
 * later, under one author instead of two.
 *
 * Reads the user's *currently stored* location assertion rather than accepting one as an argument —
 * called from a generic recompute path with no single "this just changed" locationId to hand it,
 * unlike the write-time skip it backstops. That read is staleness-aware for the same reason that
 * fix needed to be: an assertion from Monday is not evidence of where the person is on
 * Tuesday, and skipping Tuesday's "Pack Bag" against a location nobody is actually at is a second,
 * worse version of the bug this sweep exists to close (see `currentFreshLocationId`).
 *
 * The commitment match below applies the same time bound as `routineStepMootness`
 * (engine/core/src/recommendation/routine-step-mootness.ts), the shared predicate this sweep, the
 * write-time skip (`routine-step-arrival.ts`) and the read-time check (`directive.ts`,
 * `now-activity.ts`) all now agree on: "now" must fall at or after the earliest scheduled start among
 * the commitment's own before-phase steps (its preparation window opening — not the commitment's own
 * `starts_at`, since prep happens *before* it) and before the commitment ends. A commitment whose
 * before-phase steps have never been scheduled has no window of its own and falls back to its own
 * `starts_at`, so an unscheduled routine is still swept once the commitment is underway rather than
 * being excluded from the sweep entirely. This package cannot
 * import engine-core (`pnpm structure:check`) and this sweep operates in bulk across many commitments
 * at once, so the rule is reimplemented here as SQL rather than shared by import. Only `pending`
 * before-phase steps are touched — a step already `doing` has a live session on it, and skipping it out
 * from under that session is what let "did not start" resurrect an arrival-skipped step (finding 19;
 * see `activity-commands.ts`'s own guard against that, the other half of the same fix).
 */
export async function sweepMootRoutineSteps(sql: postgres.Sql, userId: string, now: Date): Promise<void> {
  const rows = await sql<{ current_situation: unknown }[]>`
    SELECT current_situation FROM user_preferences WHERE user_id=${userId}
  `;
  // `location_stale_after_minutes` was a per-user column nothing could ever write (no portal form, no
  // CLI field) and was always the same 480; dropped, so the constant is now the only value there is.
  const locationId = currentFreshLocationId(rows[0]?.current_situation, now, DEFAULT_LOCATION_STALE_AFTER_MINUTES);
  if (!locationId) return;
  const commitments = await sql<{ id: string }[]>`
    SELECT c.id FROM commitments c
    LEFT JOIN (
      SELECT commitment_id, MIN(scheduled_start_at) AS window_start
      FROM routine_steps
      WHERE user_id=${userId} AND phase='before' AND scheduled_start_at IS NOT NULL
      GROUP BY commitment_id
    ) window_start ON window_start.commitment_id=c.id
    WHERE c.user_id=${userId} AND c.location_id=${locationId} AND c.status='confirmed'
      AND COALESCE(window_start.window_start, c.starts_at)<=${now} AND c.ends_at>${now}
  `;
  if (!commitments.length) return;
  const commitmentIds = commitments.map((row) => row.id);
  await sql`
    UPDATE routine_steps
    SET status='skipped', version=version+1, updated_at=${now}
    WHERE user_id=${userId} AND phase='before' AND status='pending'
      AND commitment_id IN ${sql(commitmentIds)}
  `;
}

/** The asserted location out of a raw `user_preferences.current_situation` JSON value, or null. Does
 * not consider `locationSetAt` — callers that need the assertion to still be trustworthy right now
 * want `currentFreshLocationId` instead. */
export function currentLocationId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const locationId = (value as Record<string, unknown>).locationId;
  return typeof locationId === "string" && locationId.length > 0 ? locationId : null;
}

/**
 * `currentLocationId`, but expired to null once the assertion has aged past `staleAfterMinutes` — the
 * same rule `resolveSituation` (platform/contracts/src/planning/context-match.ts) applies to every
 * *read* path, now applied to the two *write* paths (this sweep, and `check-in-scheduler.ts`'s
 * routine-step hygiene check) that read the raw JSON directly instead of going through the contract's
 * full situation model. Unlike `resolveSituation`, a missing `locationSetAt` counts as stale here
 * rather than as fresh-forever: these two callers act on the assertion (skip a step, suppress a
 * check-in) rather than merely reporting it, so an assertion with no recorded time is treated as not
 * trustworthy enough to act on, not as one with an unlimited grace period.
 */
export function currentFreshLocationId(value: unknown, now: Date, staleAfterMinutes: number): string | null {
  const locationId = currentLocationId(value);
  if (!locationId) return null;
  const locationSetAt = (value as Record<string, unknown>).locationSetAt;
  if (typeof locationSetAt !== "string") return null;
  const setAt = new Date(locationSetAt);
  if (Number.isNaN(setAt.getTime())) return null;
  const ageMinutes = (now.getTime() - setAt.getTime()) / 60_000;
  return ageMinutes > staleAfterMinutes ? null : locationId;
}
