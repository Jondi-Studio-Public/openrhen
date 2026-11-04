import type { Sql } from "../persistence/postgres/sql-pool";

/**
 * The one "Back on plan?" push: queued the instant the recorder moves the
 * pulse into `off/lapsed`, once per lapse, through the ordinary `push_outbox` and drain path (no new channel). None
 * for `unknown`. The recorder sets it from `result.enteredLapsed`, which is true only on the advance that entered the
 * lapse and under the per-user advisory lock, and the lapse's start is the dedupe key, so a repeat adds nothing.
 * Tapping opens Now, which shows the re-entry sheet while the pulse is lapsed. Re-entry cancels it if still unsent.
 *
 * No migration: the row uses the existing `test` kind, as the catch-up nudge and the new-device notice do.
 */

export const BACK_ON_PLAN_DEDUPE_PREFIX = "back-on-plan:";
/** Long enough for a phone that is off or out of signal to show it when it returns, short enough not to nag a day later. */
export const BACK_ON_PLAN_TTL_MS = 12 * 60 * 60_000;

export function backOnPlanPayload(dedupeKey: string) {
  return {
    title: "Back on plan?",
    body: "I lost track of what you're doing. Tap to tell me where you are and catch up.",
    tag: dedupeKey,
    url: "/"
  };
}

/** Queues the push for the lapse that began at `lapsedAt`. Returns whether a row was added. */
export async function queueBackOnPlanPush(sql: Sql, userId: string, lapsedAt: Date): Promise<boolean> {
  const dedupeKey = `${BACK_ON_PLAN_DEDUPE_PREFIX}${lapsedAt.toISOString()}`;
  const expiresAt = new Date(lapsedAt.getTime() + BACK_ON_PLAN_TTL_MS);
  const queued = await sql`
    INSERT INTO push_outbox (user_id, dedupe_key, kind, payload, status, expires_at)
    VALUES (${userId}, ${dedupeKey}, 'test', ${sql.json(backOnPlanPayload(dedupeKey) as never)}, 'pending', ${expiresAt})
    ON CONFLICT (user_id, dedupe_key, channel) DO NOTHING
    RETURNING id`;
  return queued.length > 0;
}

/** Withdraws a push still waiting once the pulse is back on (re-entry): the phone never asks after it is answered. */
export async function cancelBackOnPlanPush(sql: Sql, userId: string): Promise<void> {
  await sql`UPDATE push_outbox SET status='cancelled'
    WHERE user_id=${userId} AND status='pending' AND dedupe_key LIKE ${`${BACK_ON_PLAN_DEDUPE_PREFIX}%`}`;
}
