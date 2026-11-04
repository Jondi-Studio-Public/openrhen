import { phaseSessionTitle } from "./activity-commands";
import type { Sql } from "./sql-pool";
import type { WriteSnapshot } from "./write-snapshot";

/**
 * Arrival wins outright (`isRunningLate` in engine/core/src/model/types.ts): once a location assertion
 * agrees with a located commitment's own place, whatever preparation is still open for it is moot, not
 * overdue — a stray "Pack Bag" step should not keep dangling `pending` once the person is already at
 * class. Both places an assertion can land — the manual situation save
 * (`entity-commands.ts`) and the device-observation write (`location-observation-store.ts`) — call this
 * in the same transaction as the write itself, so the skip is never a beat behind the assertion it
 * follows from.
 *
 * Scoped tightly: only a *confirmed* commitment whose own `location_id` matches what was just asserted,
 * and only while "now" sits inside that commitment's own preparation window — at or after the earliest
 * scheduled start among its before-phase steps (`windowStart` below), and before the commitment itself
 * ends. Steps that have never been scheduled carry no window of their own, so such a commitment falls
 * back to its own `starts_at`: the bound is there to stop prep for a *later* commitment being skipped
 * on arrival, and a commitment already underway is past that line however its steps are scheduled.
 * Dropping those commitments instead would silently retire this whole feature for any routine the
 * scheduler has not placed yet. This is the same bound `routineStepMootness` (engine/core/src/recommendation/routine-step-
 * mootness.ts) states as the shared rule; it is reimplemented here in SQL rather than imported because
 * this package cannot import engine-core (`pnpm structure:check`) and this write operates in bulk
 * across many steps at once rather than one step at a time. Before this bound existed, a commitment
 * with no fixed window check beyond its own active span silently missed arrivals recorded ahead of the
 * commitment's own `starts_at` (having left early and arrived during prep) — this now catches those
 * too, exactly as the read-time predicate now would.
 *
 * Only `before`-phase steps still `pending` are skipped. A step already `doing` has a session open on
 * it — finding 19: skipping it out from under a live session raced "did not start" into resurrecting a
 * step the arrival had already retired (`activity-commands.ts`'s own guard against that is the second
 * half of the same fix). `completed`, `cancelled`, `blocked` and already-`skipped` steps are left
 * exactly as they are, and `after`-phase steps (the ones that follow the commitment, not lead into it)
 * are never this function's business.
 *
 * Edge-triggered on purpose — it runs once, at the instant an assertion changes — which is also its
 * one blind spot: a bug where someone had already arrived at class yet was still told to pack a bag was this exact write
 * missing its one chance, for reasons this single transaction cannot see (arrival recorded before the
 * commitment's window opened, a location re-confirmed rather than changed elsewhere in the same
 * request). Two things now cover for that rather than trying to make this write infallible: the engine
 * re-checks arrival fresh on every directive selection (`stepMootOnArrival`, directive.ts) so a missed
 * write can never reach the person, and `sweepMootRoutineSteps` (routine-step-mootness.ts,
 * platform/database) re-runs this same match unconditionally on every plan recompute so the stored
 * status does not dangle either. The logging below is this write's own account of what it saw, so a
 * miss under any of those causes is attributable from the logs rather than inferred after the fact.
 */
export async function skipMootRoutineSteps(
  tx: Sql,
  userId: string,
  locationId: string,
  now: Date,
  context: { previousLocationId: string | null } = { previousLocationId: null },
  snap: WriteSnapshot | null = null
): Promise<{ matchedCommitmentIds: string[]; skippedStepIds: string[] }> {
  // The earliest scheduled start among each commitment's own before-phase steps — the commitment's own
  // preparation window opens there, not at the commitment's own `starts_at` (prep happens *before* it).
  const commitments = await tx<{ id: string }[]>`
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
  const matchedCommitmentIds = commitments.map((row) => row.id);
  if (!matchedCommitmentIds.length) {
    logArrival({
      previousLocationId: context.previousLocationId,
      newLocationId: locationId,
      matchedCommitmentIds,
      skippedStepIds: []
    });
    return { matchedCommitmentIds, skippedStepIds: [] };
  }
  // The steps about to be skipped, kept as they are now so an agent's availability change can be undone.
  await snap?.watch(
    "routine_steps",
    `t.user_id = $1 AND t.phase = 'before' AND t.status = 'pending' AND t.commitment_id::text IN (${matchedCommitmentIds.map((_, index) => `$${index + 2}`).join(", ")})`,
    [userId, ...matchedCommitmentIds]
  );
  const skipped = await tx<{ id: string }[]>`
    UPDATE routine_steps
    SET status='skipped', version=version+1, updated_at=${now}
    WHERE user_id=${userId} AND phase='before' AND status='pending'
      AND commitment_id IN ${tx(matchedCommitmentIds)}
    RETURNING id
  `;
  const skippedStepIds = skipped.map((row) => row.id);
  logArrival({
    previousLocationId: context.previousLocationId,
    newLocationId: locationId,
    matchedCommitmentIds,
    skippedStepIds
  });
  // A skipped step no longer claims a place in its chain, so whatever follows it can move earlier —
  // the engine's placer picks that up on the recalculation the caller's own one-write-path enqueues
  // (this write is write-back, per the one write path design note invariant 3, and never enqueues
  // itself); nothing here reschedules synchronously any more.
  await retitleTrackedSessionsOnArrival(tx, userId, matchedCommitmentIds, now, snap);
  return { matchedCommitmentIds, skippedStepIds };
}

/**
 * Retitles a session already being tracked against one of the matched commitments, so a session
 * opened during setup or travel (`phaseSessionTitle`, activity-commands.ts) stops reading "Preparing
 * for X" once the person has actually arrived (a session still reading "Preparing for class"
 * after "I'm at class" was pressed). The session's title is written once at `start_activity` and never
 * revisited by anything else — `pause_activity`/`resume_activity` leave it alone — so arrival is the
 * one moment this function exists to catch it.
 *
 * Same threshold `recommend.ts` uses for entering a commitment's `active` phase: at or after its own
 * `starts_at`. Arriving earlier than that lands in `arrival` instead ("Arriving for X"), not `active`
 * — the commitment has not started yet even though the person is now at its place.
 */
async function retitleTrackedSessionsOnArrival(
  tx: Sql,
  userId: string,
  matchedCommitmentIds: string[],
  now: Date,
  snap: WriteSnapshot | null
): Promise<void> {
  const commitments = await tx<{ id: string; title: string; starts_at: Date }[]>`
    SELECT id, title, starts_at FROM commitments WHERE id IN ${tx(matchedCommitmentIds)}
  `;
  const sessions = await tx<{ id: string; target_id: string; target_title: string | null }[]>`
    SELECT id, target_id, target_title FROM sessions
    WHERE user_id=${userId} AND ended_at IS NULL AND status IN ('running','paused')
      AND target_type='fixed_commitment' AND target_id IN ${tx(matchedCommitmentIds)}
    FOR UPDATE
  `;
  for (const session of sessions) {
    const commitment = commitments.find((row) => row.id === session.target_id);
    if (!commitment) continue;
    const title = phaseSessionTitle(commitment.title, commitment.starts_at <= now ? "active" : "arrival");
    if (title !== session.target_title) {
      await snap?.before("sessions", [session.id]);
      await tx`UPDATE sessions SET target_title=${title}, version=version+1, updated_at=${now} WHERE id=${session.id}`;
    }
  }
}

/**
 * One JSON line per invocation, in the house shape (`portal/server/logging.ts`,
 * `provider-call-recorder.ts`): `{level, message, ...fields}`. Deliberately unconditional — including
 * the "matched nothing" case — because a silent no-op is exactly what that incident was,
 * and a log line that only appears when something happened cannot answer "did this even run?" for the
 * next one.
 */
function logArrival(fields: {
  previousLocationId: string | null;
  newLocationId: string;
  matchedCommitmentIds: string[];
  skippedStepIds: string[];
}): void {
  console.log(JSON.stringify({ level: "info", message: "Arrival-triggered routine-step skip", ...fields }));
}
