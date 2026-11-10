import type postgres from "postgres";
import {
  CHECK_IN_WAITING_KIND,
  cancelPendingByDedupeKey,
  cancelWaitingRowsForClosedCheckIns,
  insertCheckInWaitingRow
} from "../stores/push-outbox.js";

export { CHECK_IN_WAITING_KIND };
export { stampCheckInPrompted } from "../stores/check-in.js";

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
 * The SQL lives in the owner stores (`stores/push-outbox.ts`, `stores/check-in.ts`).
 */

export const CHECK_IN_WAITING_DEDUPE_PREFIX = "check-in:";

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

/** Queues the push for a freshly created check-in; `expiresAt` is the slot's own timeout. Returns whether a row was added. */
export async function queueCheckInWaitingPush(
  sql: postgres.Sql,
  input: { userId: string; checkInId: string; expiresAt: Date; title: string | null }
): Promise<boolean> {
  return insertCheckInWaitingRow(sql, {
    userId: input.userId,
    dedupeKey: checkInWaitingDedupeKey(input.checkInId),
    payload: checkInWaitingPayload(input.checkInId, input.title),
    expiresAt: input.expiresAt
  });
}

/** Withdraws the push(es) for one check-in that are still waiting (answered, timed out, superseded). */
export async function cancelCheckInWaitingPush(sql: postgres.Sql, userId: string, checkInId: string): Promise<void> {
  await cancelPendingByDedupeKey(sql, userId, checkInWaitingDedupeKey(checkInId));
}

/** Backstop for any path that closes a check-in without cancelling: withdraws every waiting push whose check-in is no longer pending. */
export async function cancelClosedCheckInWaitingPushes(sql: postgres.Sql, userId: string): Promise<number> {
  return cancelWaitingRowsForClosedCheckIns(sql, userId, CHECK_IN_WAITING_DEDUPE_PREFIX);
}
