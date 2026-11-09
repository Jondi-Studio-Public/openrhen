import { validateActivityEvent } from "@openrhen/contracts";
import { DRIFT_REASON_SOURCE } from "@openrhen/contracts/drift/reasons";
import { deleteReasonRowsTx, insertServerEventTx } from "./activity-store";
import type { Sql, TxSql } from "./sql-pool";

/**
 * Reads and writes for the owner's reasons (source `drift-reason`; docs/architecture/drift.md). Writes go through
 * `validateActivityEvent`, the same judge as the API, and are stamped `ingested_via` NULL: they are the owner's own
 * words. No token can write or read the source (`agent-routes.ts`, `readActivityEvents`). Callers take the per-person
 * activity lock. Nothing here logs or returns the words in an error.
 */

export interface AnsweredCheckIn {
  id: string;
  status: string;
  answeredAt: Date | null;
  answeredBy: string | null;
  answerSource: string | null;
}

/** The check-in, when it is the person's. */
export async function readCheckInForReason(
  sql: Sql,
  userId: string,
  checkInId: string
): Promise<AnsweredCheckIn | null> {
  const [row] = await sql<
    { id: string; status: string; answered_at: Date | null; answered_by: string | null; answer_source: string | null }[]
  >`SELECT id, status, answered_at, answered_by, answer_source FROM check_in WHERE id = ${checkInId} AND user_id = ${userId}`;
  return row === undefined
    ? null
    : {
        id: row.id,
        status: row.status,
        answeredAt: row.answered_at,
        answeredBy: row.answered_by,
        answerSource: row.answer_source
      };
}

/** The words already stored under this key, to tell a retry of the same save from a reused id with other words. */
export async function readReasonTextByKey(sql: Sql, userId: string, key: string): Promise<string | null> {
  const [row] = await sql<{ text: unknown }[]>`
    SELECT attrs->>'text' AS text FROM activity_events
    WHERE user_id = ${userId} AND source = ${DRIFT_REASON_SOURCE} AND event_key = ${key}`;
  return typeof row?.text === "string" ? row.text : null;
}

export type ReasonWrite = { ok: true; added: boolean } | { ok: false; reason: string };

/** Stores one `reason` or `reason_tag` row inside the caller's transaction, as the owner's own. */
export async function insertReasonRow(
  tx: TxSql,
  userId: string,
  event: Record<string, unknown>,
  now: Date
): Promise<ReasonWrite> {
  const verdict = validateActivityEvent(event, now);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  const row = verdict.event;
  if (row.source !== DRIFT_REASON_SOURCE)
    return { ok: false, reason: `This call writes source "${DRIFT_REASON_SOURCE}" only.` };
  return { ok: true, added: await insertServerEventTx(tx, userId, row, null) };
}

/** Removes a check-in's reason rows and tag rows inside the caller's transaction; answers how many went. */
export function deleteReasonRows(tx: TxSql, userId: string, checkInId: string): Promise<number> {
  return deleteReasonRowsTx(tx, userId, checkInId);
}
