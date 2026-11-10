import type postgres from "postgres";

/**
 * The "check-in waiting" push: one `push_outbox` row per check-in, queued by the check-in scheduler in the
 * same transaction that creates the slot, so it sits behind exactly the gates the scheduler already applies
 * (asleep, a silent commitment, nothing askable). Every channel reads the same row; web push sends it from
 * `portal/server/push/push-drain.ts`, and a channel a private build adds sends it the same way.
 *
 * A push that was only queued is not a prompt: `check_in.prompted_at`, which starts the timeout, is stamped
 * by whichever channel reports the push SENT (`stampCheckInPrompted`), never by the queueing.
 * The row dies with the question: answering, timing out or superseding the check-in cancels it, and the
 * drain also cancels any such row it finds whose check-in is no longer pending. Not backed up (regenerable).
 */

export const CHECK_IN_WAITING_DEDUPE_PREFIX = "check-in:";
export const CHECK_IN_WAITING_KIND = "check_in_waiting";

export function checkInWaitingDedupeKey(checkInId: string): string {
  return `${CHECK_IN_WAITING_DEDUPE_PREFIX}${checkInId}`;
}

/** Generic wire payload (`leaveByPushPayloadSchema` plus `checkInId`): nothing in it names a channel or vendor. */
export function checkInWaitingPayload(checkInId: string, title: string | null) {
  const subject = title?.trim();
  return {
    title: "Check-in",
    body: subject ? `Still on ${subject}? Tap to answer.` : "What are you doing right now? Tap to answer.",
    tag: checkInWaitingDedupeKey(checkInId),
    url: "/now",
    checkInId
  };
}

/** Queues the push for a freshly created check-in; `expiresAt` is the slot's own timeout. Returns whether a row was added (a repeat adds nothing). */
export async function queueCheckInWaitingPush(
  sql: postgres.Sql,
  input: { userId: string; checkInId: string; expiresAt: Date; title: string | null }
): Promise<boolean> {
  const dedupeKey = checkInWaitingDedupeKey(input.checkInId);
  const rows = await sql`
    INSERT INTO push_outbox (user_id, dedupe_key, kind, payload, status, expires_at)
    VALUES (${input.userId}, ${dedupeKey}, ${CHECK_IN_WAITING_KIND},
      ${sql.json(checkInWaitingPayload(input.checkInId, input.title) as never)}, 'pending', ${input.expiresAt})
    ON CONFLICT (user_id, dedupe_key, channel) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/** Withdraws the push(es) for one check-in that are still waiting (answered, timed out, superseded). */
export async function cancelCheckInWaitingPush(sql: postgres.Sql, userId: string, checkInId: string): Promise<void> {
  await sql`UPDATE push_outbox SET status='cancelled'
    WHERE user_id=${userId} AND status='pending' AND dedupe_key=${checkInWaitingDedupeKey(checkInId)}`;
}

/** Backstop for any path that closes a check-in without cancelling: withdraws every waiting push whose check-in is no longer pending. */
export async function cancelClosedCheckInWaitingPushes(sql: postgres.Sql, userId: string): Promise<number> {
  const rows = await sql`
    UPDATE push_outbox o SET status='cancelled'
    WHERE o.user_id=${userId} AND o.kind=${CHECK_IN_WAITING_KIND} AND o.status='pending'
      AND NOT EXISTS (
        SELECT 1 FROM check_in c
        WHERE c.user_id=o.user_id AND c.status='pending' AND o.dedupe_key=${CHECK_IN_WAITING_DEDUPE_PREFIX} || c.id::text
      )
    RETURNING o.id`;
  return rows.length;
}

/**
 * A channel reports the push SENT: the check-in is now prompted, so its timeout starts counting from here.
 * Only a still-pending, not-yet-prompted check-in is stamped (a repeat or a late send changes nothing).
 */
export async function stampCheckInPrompted(sql: postgres.Sql, userId: string, checkInId: string): Promise<boolean> {
  const rows = await sql`
    UPDATE check_in SET prompted_at=CURRENT_TIMESTAMP
    WHERE id=${checkInId} AND user_id=${userId} AND status='pending' AND prompted_at IS NULL
    RETURNING id`;
  return rows.length > 0;
}
