import { activityContentDefault } from "./activity-store";
import type { Mark, ScanInput } from "./derived-scan-store";
import type { Sql } from "./sql-pool";

/**
 * The reads the model tick (communication understanding, slice 2b-4) adds to the T0 scan: the same `(ingested_at, id)`
 * watermarks, but each row also carries its `content` and a hash of it, and a message can be given its thread context.
 * They are separate from `derived-scan-store.ts` on purpose: the T0 extractor never reads content, and selecting up to
 * 64 KB of text per row for 500 rows a scan would be a regression for it.
 */

export interface ModelSourceRow {
  id: string;
  key: string;
  tsStart: Date;
  attrs: unknown;
  /** Null when the row holds no text (the source's content gate was off when it arrived). */
  content: string | null;
  mark: Mark;
}

interface Row {
  id: string;
  event_key: string;
  ts_start: Date;
  attrs: unknown;
  content: string | null;
  ingested_text: string;
}

const MICROS = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

const toRow = (row: Row): ModelSourceRow => ({
  id: row.id,
  key: row.event_key,
  tsStart: row.ts_start,
  attrs: row.attrs,
  content: row.content,
  mark: { at: row.ingested_text, id: row.id }
});

/** Rows after `after` (exclusive) up to and including `upTo`, oldest first, with their content. */
export async function scanModelForward(
  sql: Sql,
  userId: string,
  input: ScanInput,
  after: Mark,
  upTo: Date,
  limit: number,
  excludeKeys: readonly string[] = []
): Promise<ModelSourceRow[]> {
  if (limit <= 0) return [];
  const rows = await sql<Row[]>`
    SELECT id, event_key, ts_start, attrs, content, to_char(ingested_at AT TIME ZONE 'UTC', ${MICROS}) AS ingested_text
    FROM activity_events
    WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
      AND ingested_at >= ${after.at}::timestamptz
      AND (ingested_at, id) > (${after.at}::timestamptz, ${after.id}::uuid)
      AND ingested_at <= ${upTo}
      AND event_key NOT IN (SELECT value FROM jsonb_array_elements_text(${sql.json(excludeKeys as string[])}))
    ORDER BY ingested_at, id
    LIMIT ${limit}`;
  return rows.map(toRow);
}

/**
 * Rows before `before` (exclusive), newest ingested first, whose message date (`ts_start`) is no older than
 * `notBefore`: the backfill horizon. A row outside the horizon is never returned, so the watermark moves past it only
 * by being below a returned row; an empty answer means the horizon is covered.
 */
export async function scanModelBackfill(
  sql: Sql,
  userId: string,
  input: ScanInput,
  before: Mark,
  notBefore: Date,
  limit: number
): Promise<ModelSourceRow[]> {
  if (limit <= 0) return [];
  const rows = await sql<Row[]>`
    SELECT id, event_key, ts_start, attrs, content, to_char(ingested_at AT TIME ZONE 'UTC', ${MICROS}) AS ingested_text
    FROM activity_events
    WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
      AND ingested_at <= ${before.at}::timestamptz
      AND (ingested_at, id) < (${before.at}::timestamptz, ${before.id}::uuid)
      AND ts_start >= ${notBefore}
    ORDER BY ingested_at DESC, id DESC
    LIMIT ${limit}`;
  return rows.map(toRow);
}

/** The rows with these ids that are still held, with their content (a deleted one is absent). */
export async function readModelRowsByIds(
  sql: Sql,
  userId: string,
  input: ScanInput,
  ids: readonly string[]
): Promise<ModelSourceRow[]> {
  if (ids.length === 0) return [];
  const rows = await sql<Row[]>`
    SELECT id, event_key, ts_start, attrs, content, to_char(ingested_at AT TIME ZONE 'UTC', ${MICROS}) AS ingested_text
    FROM activity_events
    WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
      AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(${sql.json(ids as string[])}))`;
  return rows.map(toRow);
}

/** The rows with these event keys that are still held (the labelled messages of the eval set). */
export async function readModelRowsByKeys(
  sql: Sql,
  userId: string,
  input: ScanInput,
  keys: readonly string[],
  limit: number
): Promise<ModelSourceRow[]> {
  if (keys.length === 0 || limit <= 0) return [];
  const rows = await sql<Row[]>`
    SELECT id, event_key, ts_start, attrs, content, to_char(ingested_at AT TIME ZONE 'UTC', ${MICROS}) AS ingested_text
    FROM activity_events
    WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
      AND content IS NOT NULL
      AND event_key IN (SELECT value FROM jsonb_array_elements_text(${sql.json(keys as string[])}))
    ORDER BY ts_start DESC, id DESC
    LIMIT ${limit}`;
  return rows.map(toRow);
}

/** How many of these event keys are still held (for "behind by N" on the labelled messages). */
export async function countModelRowsByKeys(
  sql: Sql,
  userId: string,
  input: ScanInput,
  keys: readonly string[]
): Promise<number> {
  if (keys.length === 0) return 0;
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM activity_events
    WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
      AND content IS NOT NULL
      AND event_key IN (SELECT value FROM jsonb_array_elements_text(${sql.json(keys as string[])}))`;
  return row?.n ?? 0;
}

export interface ModelContextRow {
  id: string;
  key: string;
  tsStart: Date;
  attrs: unknown;
  content: string | null;
}

/** At most this many earlier messages of the thread go to the prompt as context. */
export const CONTEXT_MESSAGES = 3;

/**
 * The messages before this one in its thread, oldest first, at most `CONTEXT_MESSAGES`. The predicate repeats the
 * partial index's own (`attrs ? 'thread_id'`), which is what lets `activity_events_thread_idx` serve the lookup.
 */
export async function readThreadContext(
  sql: Sql,
  userId: string,
  input: ScanInput,
  message: { id: string; tsStart: Date; attrs: unknown }
): Promise<ModelContextRow[]> {
  const thread = (message.attrs as { thread_id?: unknown } | null)?.thread_id;
  if (typeof thread !== "string" || thread === "") return [];
  const rows = await sql<Row[]>`
    SELECT id, event_key, ts_start, attrs, content, '' AS ingested_text
    FROM activity_events
    WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
      AND attrs ? 'thread_id' AND attrs->>'thread_id' = ${thread}
      AND (ts_start, id) < (${message.tsStart}, ${message.id}::uuid)
    ORDER BY ts_start DESC, id DESC
    LIMIT ${CONTEXT_MESSAGES}`;
  return rows
    .reverse()
    .map((row) => ({ id: row.id, key: row.event_key, tsStart: row.ts_start, attrs: row.attrs, content: row.content }));
}

/** A hash of each still-held row's content, to see at write time that the text read earlier is the text still there. */
export async function readContentHashes(
  sql: Sql,
  userId: string,
  input: ScanInput,
  ids: readonly string[]
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ id: string; hash: string }[]>`
    SELECT id, md5(COALESCE(content, '')) AS hash FROM activity_events
    WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
      AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(${sql.json(ids as string[])}))`;
  return new Map(rows.map((row) => [row.id, row.hash]));
}

/** Event keys of the messages the person labelled himself (his own labels only), newest label first, at most `limit`. */
export async function readLabelledMessageKeys(sql: Sql, userId: string, limit: number): Promise<string[]> {
  const rows = await sql<{ key: string }[]>`
    SELECT key FROM (
      SELECT attrs->>'source_event_id' AS key, max(ingested_at) AS at
      FROM activity_events
      WHERE user_id = ${userId} AND source = 'derived' AND kind = 'label' AND ingested_via IS NULL
        AND attrs ? 'source_event_id'
      GROUP BY 1
    ) labelled
    ORDER BY at DESC, key
    LIMIT ${limit}`;
  return rows.map((row) => row.key);
}

/** Rows before `before` within the horizon: the backfill still to do. */
export async function countModelBackfillBefore(
  sql: Sql,
  userId: string,
  input: ScanInput,
  before: Mark,
  notBefore: Date
): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM activity_events
    WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
      AND ingested_at <= ${before.at}::timestamptz AND (ingested_at, id) < (${before.at}::timestamptz, ${before.id}::uuid)
      AND ts_start >= ${notBefore}`;
  return row?.n ?? 0;
}

/** Whether the source stores message text now (its saved gate, else the server default). */
export async function readContentGate(sql: Sql, userId: string, source: string): Promise<boolean> {
  const [row] = await sql<{ content_enabled: boolean }[]>`
    SELECT content_enabled FROM activity_source_state WHERE user_id = ${userId} AND source = ${source}`;
  return row?.content_enabled ?? activityContentDefault();
}

/** Rows after `after` that are not in `excludeKeys` (messages a shadow run already read ahead of its mark). */
export async function countModelForward(
  sql: Sql,
  userId: string,
  input: ScanInput,
  after: Mark,
  excludeKeys: readonly string[]
): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM activity_events
    WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
      AND ingested_at >= ${after.at}::timestamptz AND (ingested_at, id) > (${after.at}::timestamptz, ${after.id}::uuid)
      AND event_key NOT IN (SELECT value FROM jsonb_array_elements_text(${sql.json(excludeKeys as string[])}))`;
  return row?.n ?? 0;
}
