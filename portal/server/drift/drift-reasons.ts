import {
  REASON_CHECK_IN_ID,
  REASON_REQUEST_ID,
  describeReasonTextProblem,
  normaliseReasonText,
  reasonKey
} from "@openrhen/contracts/drift/reasons";
import { lockActivityUser } from "@/server/persistence/postgres/activity-lock";
import {
  deleteReasonRows,
  insertReasonRow,
  readCheckInForReason,
  readReasonTextByKey
} from "@/server/persistence/postgres/drift-reason-store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";

/**
 * The owner's "What pulled you off?" answer: saved for a check-in already answered as deviated
 * (`POST /api/drift-reasons`), and deleted with its tags (`DELETE /api/drift-reasons/[checkInId]`). The words are
 * private: they are never logged, never put in an error, and the answers carry ids and counts only. A later save for
 * the same check-in is a new row and the latest wins (`resolveReasons`); the words are not edited in place.
 */

export type SaveReasonResult =
  { ok: true; id: string; created: boolean } | { ok: false; status: 400 | 404 | 409; error: string };

const BAD_CHECK_IN = "The check-in id is not a check-in id. Use the id of the check-in you just answered.";
const BAD_REQUEST = "requestId must be 8 to 64 letters, digits and hyphens, new for each save (a retry reuses it).";

export async function saveReason(
  sql: PoolSql,
  input: { checkInId: unknown; text: unknown; requestId: unknown },
  now: Date = new Date()
): Promise<SaveReasonResult> {
  const { checkInId, text, requestId } = input;
  if (typeof checkInId !== "string" || !REASON_CHECK_IN_ID.test(checkInId))
    return { ok: false, status: 400, error: BAD_CHECK_IN };
  if (typeof requestId !== "string" || !REASON_REQUEST_ID.test(requestId))
    return { ok: false, status: 400, error: BAD_REQUEST };
  if (typeof text !== "string") return { ok: false, status: 400, error: "The reason must be text." };
  const words = normaliseReasonText(text);
  const problem = describeReasonTextProblem(words);
  if (problem) return { ok: false, status: 400, error: problem };
  const userId = await ensureUser(sql);
  const id = reasonKey(checkInId, requestId);
  return sql.begin(async (tx): Promise<SaveReasonResult> => {
    await lockActivityUser(tx, userId);
    const checkIn = await readCheckInForReason(tx, userId, checkInId);
    if (checkIn === null)
      return { ok: false, status: 404, error: "That check-in is not here. It may have been removed; reload the page." };
    if (checkIn.status !== "deviated" || checkIn.answeredAt === null)
      return {
        ok: false,
        status: 409,
        error: "A reason goes with a check-in answered as something else. Answer it first."
      };
    if (checkIn.answeredBy !== null || checkIn.answerSource === "session_reconciliation")
      return { ok: false, status: 409, error: "Only your own answer to a check-in takes a reason." };
    const written = await insertReasonRow(
      tx,
      userId,
      {
        id,
        source: "drift-reason",
        kind: "reason",
        start: checkIn.answeredAt.toISOString(),
        attrs: { check_in_id: checkInId, text: words, request_id: requestId }
      },
      now
    );
    if (!written.ok) return { ok: false, status: 400, error: written.reason };
    if (!written.added && (await readReasonTextByKey(tx, userId, id)) !== words)
      return {
        ok: false,
        status: 409,
        error: "That save id was already used for other words. Try again to save the reason."
      };
    return { ok: true, id, created: written.added };
  });
}

export type DeleteReasonResult = { ok: true; removed: number } | { ok: false; status: 400; error: string };

/** Removes every reason saved for a check-in and every tag on it. Answers how many rows went (0 is fine). */
export async function deleteReason(sql: PoolSql, checkInId: unknown): Promise<DeleteReasonResult> {
  if (typeof checkInId !== "string" || !REASON_CHECK_IN_ID.test(checkInId))
    return { ok: false, status: 400, error: BAD_CHECK_IN };
  const userId = await ensureUser(sql);
  const removed = await sql.begin(async (tx) => {
    await lockActivityUser(tx, userId);
    return deleteReasonRows(tx, userId, checkInId);
  });
  return { ok: true, removed };
}
