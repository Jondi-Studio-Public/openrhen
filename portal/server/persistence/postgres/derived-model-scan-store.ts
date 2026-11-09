import { resolveFactStatus, type StatusRow } from "@openrhen/communication-readers";
import type { LinkPoolEntry } from "@/server/derived/model-extractor";
import { recipientAddresses } from "@/server/derived/hosted-recipients";
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

// ---- what the fact extractor asks of the database (communication understanding, slice 2b-6) ----------------------------

/** The owner's IANA zone, the one a message's dates are resolved in. UTC if the row somehow holds none. */
export async function readUserTimeZone(sql: Sql, userId: string): Promise<string> {
  const [row] = await sql<{ timezone: string | null }[]>`SELECT timezone FROM users WHERE id = ${userId}`;
  return row?.timezone && row.timezone !== "" ? row.timezone : "UTC";
}

const addressOf = (from: string): string => (/<([^<>]+)>/u.exec(from)?.[1] ?? from).trim().toLowerCase();

/**
 * Lower-case sender addresses of messages the person labelled `sensitive: true` himself (his own `label` rows, not
 * Mark's or a token's; the latest label of a message wins). The hosted-eligibility rule never sends mail from them.
 */
export async function readSensitiveSenders(sql: Sql, userId: string): Promise<Set<string>> {
  const labels = await sql<{ key: string; answer: unknown }[]>`
    SELECT DISTINCT ON (attrs->>'source_event_id') attrs->>'source_event_id' AS key, attrs->'answer' AS answer
    FROM activity_events
    WHERE user_id = ${userId} AND source = 'derived' AND kind = 'label' AND ingested_via IS NULL
      AND attrs->>'field' = 'sensitive' AND attrs ? 'source_event_id'
    ORDER BY attrs->>'source_event_id', ingested_at DESC, id DESC`;
  const keys = labels.filter((label) => label.answer === true).map((label) => label.key);
  if (keys.length === 0) return new Set();
  const senders = await sql<{ attrs: Record<string, unknown> }[]>`
    SELECT attrs FROM activity_events
    WHERE user_id = ${userId} AND source = 'gmail' AND kind = 'message'
      AND event_key IN (SELECT value FROM jsonb_array_elements_text(${sql.json(keys)}))`;
  // A label on mail he RECEIVED marks its sender; a label on mail he SENT marks the people it went to, never himself.
  return new Set(
    senders.flatMap(({ attrs }) => {
      if (attrs.from_self === true) return recipientAddresses(attrs);
      return typeof attrs.from === "string" && attrs.from.trim() !== "" ? [addressOf(attrs.from)] : [];
    })
  );
}

const POOL_ROWS = 60;
const CLOSED_STATUSES = new Set(["done", "cancelled", "superseded", "source_gone"]);

/**
 * Facts already stored (source `derived`, the active versions' rows) for one conversation, newest first and bounded, in
 * the shape `linkCandidates` takes: a cancel, move or repeat can point at one of them. `quote` is read back from the
 * source message through the stored span (the text is never stored on the fact), `closed` is the resolved status
 * (done, cancelled, superseded or source_gone), and `isLink` is true for a row that itself carries `links`. The lookup
 * is a filter on `conversation_key`, bounded by `POOL_ROWS`; it is only asked for a message that has an earlier one in its thread.
 */
export async function readLinkPool(sql: Sql, userId: string, conversationKey: string): Promise<LinkPoolEntry[]> {
  const rows = await sql<
    {
      attrs: Record<string, unknown>;
      ts_start: Date;
      quote: string | null;
      source_attrs: Record<string, unknown> | null;
      source_content: string | null;
    }[]
  >`
    SELECT f.attrs, f.ts_start, m.attrs AS source_attrs, m.content AS source_content,
      CASE WHEN m.content IS NULL OR NOT (f.attrs->'span' ? 'start') THEN NULL
        ELSE substring(m.content FROM ((f.attrs->'span'->>'start')::int + 1)
          FOR LEAST(((f.attrs->'span'->>'end')::int - (f.attrs->'span'->>'start')::int), 120)) END AS quote
    FROM activity_events f
    LEFT JOIN activity_events m ON m.user_id = f.user_id AND m.source = 'gmail' AND m.kind = 'message'
      AND m.event_key = f.attrs->>'source_event_id'
    WHERE f.user_id = ${userId} AND f.source = 'derived' AND f.kind = 'fact'
      AND f.attrs->>'conversation_key' = ${conversationKey}
    ORDER BY f.ts_start DESC, f.id DESC
    LIMIT ${POOL_ROWS}`;
  const ids = [...new Set(rows.flatMap((row) => (typeof row.attrs.fact_id === "string" ? [row.attrs.fact_id] : [])))];
  const statuses = ids.length
    ? await sql<{ fact_id: string; status: string; valid_from: string; via: string | null; key: string }[]>`
        SELECT attrs->>'fact_id' AS fact_id, attrs->>'status' AS status, attrs->>'valid_from' AS valid_from,
          ingested_via AS via, event_key AS key
        FROM activity_events
        WHERE user_id = ${userId} AND source = 'derived' AND kind = 'fact_status'
          AND attrs->>'fact_id' IN (SELECT value FROM jsonb_array_elements_text(${sql.json(ids)}))`
    : [];
  const byFact = new Map<string, StatusRow[]>();
  for (const row of statuses)
    byFact.set(row.fact_id, [
      ...(byFact.get(row.fact_id) ?? []),
      {
        status: row.status as StatusRow["status"],
        validFrom: row.valid_from,
        actor: row.via === null ? "person" : row.via.startsWith("extractor:") ? "extractor" : "mark",
        key: row.key
      }
    ]);
  const now = new Date();
  return rows.flatMap((row): LinkPoolEntry[] => {
    const attrs = row.attrs;
    if (typeof attrs.fact_id !== "string" || typeof attrs.fact_type !== "string") return [];
    const resolved = resolveFactStatus(byFact.get(attrs.fact_id) ?? [], { now });
    return [
      {
        factId: attrs.fact_id,
        conversationKey,
        factType: attrs.fact_type,
        tsStart: row.ts_start.getTime(),
        icsUid: typeof attrs.ics_uid === "string" ? attrs.ics_uid : null,
        quote: row.quote,
        closed: CLOSED_STATUSES.has(resolved.status),
        isLink: Array.isArray(attrs.links) && attrs.links.length > 0,
        source:
          row.source_attrs !== null && typeof row.source_attrs === "object"
            ? {
                attrs: row.source_attrs,
                subject: typeof row.source_attrs.subject === "string" ? row.source_attrs.subject : null,
                content: row.source_content
              }
            : null
      }
    ];
  });
}

/**
 * The newest source messages whose fact rows (this extractor and version, in `source`, tier `t2`) carry `reviewReason`
 * and which have no row of tier `t3` from the same version yet: what the hosted tier is offered again. Skips `excludeKeys`
 * (messages already offered). Found through the stored review reason, so it needs no index on `fact_id`.
 */
export async function readLowSignalMessages(
  sql: Sql,
  userId: string,
  input: ScanInput,
  query: {
    extractor: string;
    version: string;
    source: "derived" | "derived-shadow";
    reviewReason: string;
    excludeKeys: readonly string[];
    limit: number;
    /** Only messages dated no earlier than this (the backfill horizon), so the done list need only remember what is inside it. */
    notBefore: Date;
  }
): Promise<ModelSourceRow[]> {
  if (query.limit <= 0) return [];
  const rows = await sql<Row[]>`
    SELECT m.id, m.event_key, m.ts_start, m.attrs, m.content, to_char(m.ingested_at AT TIME ZONE 'UTC', ${MICROS}) AS ingested_text
    FROM activity_events m
    WHERE m.user_id = ${userId} AND m.source = ${input.source} AND m.kind = ${input.kind} AND m.content IS NOT NULL
      AND m.ts_start >= ${query.notBefore}
      AND m.event_key NOT IN (SELECT value FROM jsonb_array_elements_text(${sql.json(query.excludeKeys as string[])}))
      AND EXISTS (
        SELECT 1 FROM activity_events f
        WHERE f.user_id = ${userId} AND f.source = ${query.source} AND f.kind = 'fact'
          AND f.attrs->>'source_event_id' = m.event_key
          AND f.attrs->>'extractor' = ${query.extractor} AND f.attrs->>'extractor_version' = ${query.version}
          AND f.attrs->>'tier' = 't2' AND f.attrs->>'review_reason' = ${query.reviewReason})
      AND NOT EXISTS (
        SELECT 1 FROM activity_events t
        WHERE t.user_id = ${userId} AND t.source = ${query.source} AND t.kind = 'fact'
          AND t.attrs->>'source_event_id' = m.event_key
          AND t.attrs->>'extractor' = ${query.extractor} AND t.attrs->>'extractor_version' = ${query.version}
          AND t.attrs->>'tier' = 't3')
    ORDER BY m.ts_start DESC, m.id DESC
    LIMIT ${query.limit}`;
  return rows.map(toRow);
}
