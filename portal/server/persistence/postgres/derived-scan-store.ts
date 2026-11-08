import type { Sql } from "./sql-pool";

/**
 * Reads the source rows an extractor works from, by `ingested_at` with the row id as the tie-break, so a scan can stop
 * and resume anywhere (even in the middle of rows that share an `ingested_at`, as a bulk import's do) without skipping
 * or repeating one. Uses the `(user_id, source, ingested_at)` index. A position is a `Mark`: the `ingested_at` as text
 * with microseconds (a JS Date would round it to milliseconds and lose rows at the boundary) and the id.
 */

export interface Mark {
  /** `ingested_at` as an ISO 8601 UTC string with microseconds, as the database holds it. */
  at: string;
  id: string;
}

export const NIL_ID = "00000000-0000-0000-0000-000000000000";

export interface SourceRow {
  id: string;
  key: string;
  tsStart: Date;
  attrs: unknown;
  mark: Mark;
}

export interface ScanInput {
  source: string;
  kind: string;
}

interface Row {
  id: string;
  event_key: string;
  ts_start: Date;
  attrs: unknown;
  ingested_text: string;
}

const MICROS = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

const toRow = (row: Row): SourceRow => ({
  id: row.id,
  key: row.event_key,
  tsStart: row.ts_start,
  attrs: row.attrs,
  mark: { at: row.ingested_text, id: row.id }
});

/** Rows after `after` (exclusive) up to and including `upTo`, oldest first. */
export async function scanForward(
  sql: Sql,
  userId: string,
  input: ScanInput,
  after: Mark,
  upTo: Date,
  limit: number
): Promise<SourceRow[]> {
  const rows = await sql<Row[]>`
    SELECT id, event_key, ts_start, attrs, to_char(ingested_at AT TIME ZONE 'UTC', ${MICROS}) AS ingested_text
    FROM activity_events
    WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
      AND ingested_at >= ${after.at}::timestamptz
      AND (ingested_at, id) > (${after.at}::timestamptz, ${after.id}::uuid)
      AND ingested_at <= ${upTo}
    ORDER BY ingested_at, id
    LIMIT ${limit}`;
  return rows.map(toRow);
}

/** Rows before `before` (exclusive), newest first. */
export async function scanBackfill(
  sql: Sql,
  userId: string,
  input: ScanInput,
  before: Mark,
  limit: number
): Promise<SourceRow[]> {
  const rows = await sql<Row[]>`
    SELECT id, event_key, ts_start, attrs, to_char(ingested_at AT TIME ZONE 'UTC', ${MICROS}) AS ingested_text
    FROM activity_events
    WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
      AND ingested_at <= ${before.at}::timestamptz
      AND (ingested_at, id) < (${before.at}::timestamptz, ${before.id}::uuid)
    ORDER BY ingested_at DESC, id DESC
    LIMIT ${limit}`;
  return rows.map(toRow);
}

/** The rows with these ids that are still held (a deleted one is simply absent). */
export async function readSourceRowsByIds(
  sql: Sql,
  userId: string,
  input: ScanInput,
  ids: readonly string[]
): Promise<SourceRow[]> {
  if (ids.length === 0) return [];
  const rows = await sql<Row[]>`
    SELECT id, event_key, ts_start, attrs, to_char(ingested_at AT TIME ZONE 'UTC', ${MICROS}) AS ingested_text
    FROM activity_events
    WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
      AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(${sql.json(ids as string[])}))`;
  return rows.map(toRow);
}

/** Rows after `after` (all of them when null), for "behind by N". An exact count over the index range. */
export async function countRowsAfter(sql: Sql, userId: string, input: ScanInput, after: Mark | null): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM activity_events
    WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
      ${after === null ? sql`` : sql`AND ingested_at >= ${after.at}::timestamptz AND (ingested_at, id) > (${after.at}::timestamptz, ${after.id}::uuid)`}`;
  return row?.n ?? 0;
}

/** Rows before `before`, the backfill still to do. */
export async function countRowsBefore(sql: Sql, userId: string, input: ScanInput, before: Mark): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM activity_events
    WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
      AND ingested_at <= ${before.at}::timestamptz AND (ingested_at, id) < (${before.at}::timestamptz, ${before.id}::uuid)`;
  return row?.n ?? 0;
}
