import { validateActivityEvent } from "@openrhen/contracts";
import {
  DRIFT_REASON_SOURCE,
  REASON_TAG_INFERRED_VIA,
  correctedReasonTagKey,
  inferredReasonTagKey,
  type ReasonRow
} from "@openrhen/contracts/drift/reasons";
import type { ReasonTagRow } from "@openrhen/contracts/drift/reason-tags";
import { deleteInferredReasonTagTx, deleteReasonRowsTx, insertServerEventTx } from "./activity-store";
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

interface ReasonRowRecord {
  event_key: string;
  attrs: Record<string, unknown>;
  ingested_at: Date;
  ingested_via: string | null;
}

/** A stored `reason` row in the resolver's shape; a row that is not a well-formed reason gives null and is ignored. */
function toReasonRow(row: ReasonRowRecord): ReasonRow | null {
  const { check_in_id: checkInId, text } = row.attrs;
  if (typeof checkInId !== "string" || typeof text !== "string") return null;
  return { id: row.event_key, checkInId, text, ingestedAt: row.ingested_at, ingestedVia: row.ingested_via };
}

/**
 * The owner's `reason` rows saved since a time, oldest or newest first, at most `limit`. Several saves of one check-in
 * come back as several rows; `resolveReasons` picks the one that stands. The words are returned to the caller and go no
 * further than the owner's own routes and the owner's local model.
 */
export async function readReasonRows(
  sql: Sql,
  userId: string,
  options: { since: Date; limit: number; order: "oldest" | "newest" }
): Promise<ReasonRow[]> {
  const rows = await sql<ReasonRowRecord[]>`
    SELECT event_key, attrs, ingested_at, ingested_via FROM activity_events
    WHERE user_id = ${userId} AND source = ${DRIFT_REASON_SOURCE} AND kind = 'reason'
      AND ingested_via IS NULL AND ingested_at >= ${options.since}
    ORDER BY ingested_at ${options.order === "oldest" ? sql`ASC` : sql`DESC`}, event_key ${options.order === "oldest" ? sql`ASC` : sql`DESC`}
    LIMIT ${options.limit}`;
  return rows.flatMap((row) => {
    const parsed = toReasonRow(row);
    return parsed ? [parsed] : [];
  });
}

/** Every `reason` row saved for one check-in, however old. */
export async function readReasonRowsOf(sql: Sql, userId: string, checkInId: string): Promise<ReasonRow[]> {
  const rows = await sql<ReasonRowRecord[]>`
    SELECT event_key, attrs, ingested_at, ingested_via FROM activity_events
    WHERE user_id = ${userId} AND source = ${DRIFT_REASON_SOURCE} AND kind = 'reason'
      AND attrs->>'check_in_id' = ${checkInId}`;
  return rows.flatMap((row) => {
    const parsed = toReasonRow(row);
    return parsed ? [parsed] : [];
  });
}

/**
 * Every `reason_tag` row of these check-ins, however old: the tags are looked up by check-in, not by recency, so a busy
 * history cannot push an owner's answer out and let the tags revert.
 */
export async function readReasonTagRows(
  sql: Sql,
  userId: string,
  checkInIds: readonly string[]
): Promise<ReasonTagRow[]> {
  if (checkInIds.length === 0) return [];
  const rows = await sql<ReasonRowRecord[]>`
    SELECT event_key, attrs, ingested_at, ingested_via FROM activity_events
    WHERE user_id = ${userId} AND source = ${DRIFT_REASON_SOURCE} AND kind = 'reason_tag'
      AND attrs->>'check_in_id' IN ${sql(checkInIds as string[])}`;
  return rows.flatMap((row): ReasonTagRow[] => {
    const { attrs } = row;
    const checkInId = attrs.check_in_id;
    if (typeof checkInId !== "string" || !Array.isArray(attrs.tags)) return [];
    if (attrs.origin !== "inferred" && attrs.origin !== "corrected") return [];
    const model = attrs.model as { id?: unknown } | undefined;
    return [
      {
        id: row.event_key,
        checkInId,
        tags: (attrs.tags as unknown[]).filter((tag): tag is string => typeof tag === "string"),
        origin: attrs.origin,
        reset: attrs.reset === true,
        promptVersion: typeof attrs.prompt_version === "number" ? attrs.prompt_version : null,
        modelId: typeof model?.id === "string" ? model.id : null,
        ingestedAt: row.ingested_at,
        ingestedVia: row.ingested_via
      }
    ];
  });
}

/**
 * Stores the model's tags for a check-in inside the caller's transaction. A row already held under the same key (same
 * prompt version and model) is replaced, because it can only be older than the words now standing; tags of other
 * versions or models stay until these land. Stamped as the model's own (`drift:reason-tag`).
 */
export async function insertInferredReasonTags(
  tx: TxSql,
  userId: string,
  input: { checkInId: string; tags: readonly string[]; modelId: string; promptVersion: number },
  now: Date
): Promise<ReasonWrite> {
  const id = inferredReasonTagKey(input.checkInId, input.promptVersion, input.modelId);
  const verdict = validateActivityEvent(
    {
      id,
      source: DRIFT_REASON_SOURCE,
      kind: "reason_tag",
      start: now.toISOString(),
      attrs: {
        check_in_id: input.checkInId,
        tags: [...input.tags],
        origin: "inferred",
        model: { id: input.modelId },
        prompt_version: input.promptVersion
      }
    },
    now
  );
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  await deleteInferredReasonTagTx(tx, userId, id, REASON_TAG_INFERRED_VIA);
  return { ok: true, added: await insertServerEventTx(tx, userId, verdict.event, REASON_TAG_INFERRED_VIA) };
}

/** Stores the owner's own tag answer (or a reset) for a check-in inside the caller's transaction: a new row, never an edit. */
export async function insertCorrectedReasonTags(
  tx: TxSql,
  userId: string,
  input: { checkInId: string; tags: readonly string[]; reset: boolean; requestId: string },
  now: Date
): Promise<ReasonWrite> {
  return insertReasonRow(
    tx,
    userId,
    {
      id: correctedReasonTagKey(input.checkInId, input.requestId),
      source: DRIFT_REASON_SOURCE,
      kind: "reason_tag",
      start: now.toISOString(),
      attrs: {
        check_in_id: input.checkInId,
        tags: [...input.tags],
        origin: "corrected",
        request_id: input.requestId,
        ...(input.reset ? { reset: true } : {})
      }
    },
    now
  );
}
