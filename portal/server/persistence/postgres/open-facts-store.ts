import {
  foldFactStates,
  resolveEvidence,
  openFacts,
  statusActorOf,
  type FactFold,
  type FoldFactRow,
  type FoldLink,
  type FoldMessage,
  type FoldOverride,
  type FoldStatus,
  type FoldWhen
} from "@openrhen/communication-readers";
import { ensureUser } from "./ensure-user";
import type { PoolSql, Sql } from "./sql-pool";

/**
 * The open facts (communication understanding, slice 2b-5): `fact` rows of the active extractor versions, folded at
 * read with their statuses, overrides, links and the conversation's later messages by the pure `foldFactStates`. Read
 * only, one REPEATABLE READ READ ONLY transaction under a statement timeout. Nothing is stored: closure, age-out,
 * reopening and link resolution are all computed here, so deleting a message or a status changes the answer at once.
 *
 * Bounded, using only indexes that exist:
 *   - Fact rows come from `activity_events_user_source_time_idx` (user, source, ts_start) over
 *     `[now - horizonDays, now + 1 day]`, newest first, at most `maxRows`; `kind = 'fact'` and the active version are
 *     filters inside that range, so a three-year backlog is never walked. A fact whose message is older than the
 *     horizon is not read even if its event is still ahead (stated limit); the default is 120 days, a margin over the
 *     90 days the model extractor backfills.
 *   - Statuses and overrides come from `activity_events_user_source_ingested_idx` (user, source, ingested_at) from one day
 *     before the oldest fact read: a status cannot be recorded before the message it is about. `kind` and `fact_id` are
 *     filters (there is no index on either for these kinds; the partial fact_id index of the 2b-2 migration covers
 *     `kind = 'fact'` only), so this range is every `derived` row ingested since then, cheapest when the facts were
 *     not just backfilled. The statement timeout and the horizon bound it; a later index on
 *     (user_id, kind) for `fact_status` and `override` would make it direct.
 *   - Messages come from `activity_events_thread_idx` (user, source, thread_id, ts_start), only for the conversations
 *     of facts whose reply or last message decides them (asks and commitments), and only from one day before the oldest
 *     fact read. No message content is read.
 * Dates: a fact row is dated by the earlier of its message time and when it was recorded, a status takes effect no later
 * than it was recorded, and a reply counts from the earlier of its time and its arrival, so a sender's clock cannot pin
 * a status open or reopen a closure. An auto-reply (`auto_submitted` present and not `no`) is not an answer.
 * Correct without the fact_id index of the 2b-2 migration (it is never used here). Performance dependency: none beyond the
 * above; with the migration's `(user_id, source, kind) WHERE source IN ('derived', 'derived-shadow')` partial index the
 * candidate read would skip the class rows inside the range, which this read does not need for correctness.
 */

export const OPEN_FACTS_HORIZON_DAYS_DEFAULT = 120;
export const OPEN_FACTS_HORIZON_DAYS_MAX = 366;
export const OPEN_FACTS_LIMIT_DEFAULT = 50;
export const OPEN_FACTS_LIMIT_MAX = 200;
export const OPEN_FACTS_MAX_ROWS_DEFAULT = 5000;
export const OPEN_FACTS_MAX_ROWS_MAX = 20000;
export const OPEN_FACTS_STATEMENT_TIMEOUT = "15s";
const DAY_MS = 86_400_000;

export class OpenFactsTimeoutError extends Error {
  constructor() {
    super(
      `Reading the open facts ran past ${OPEN_FACTS_STATEMENT_TIMEOUT} and was cancelled. Nothing was changed. Narrow the read and retry: pass a smaller horizonDays (for example 30) or maxRows, or retry in a minute if a backfill is writing.`
    );
    this.name = "OpenFactsTimeoutError";
  }
}

export interface OpenFactsOptions {
  /** The clock; default the current time. */
  now?: Date | undefined;
  /** How far back a fact's source message may be, 1 to 366 days; default 120. */
  horizonDays?: number | undefined;
  /** Facts returned, 1 to 200; default 50. `total` counts them all. */
  limit?: number | undefined;
  /** Fact rows read, 1 to 20000; default 5000. More in the horizon sets `truncated`. */
  maxRows?: number | undefined;
}

export interface OpenFactsRead {
  /** Open and reopened facts, soonest timed item first then newest first, at most `limit`. */
  facts: FactFold[];
  /** How many facts are open in all, before `limit`. */
  total: number;
  horizon: { from: string; to: string; days: number };
  /** True when the horizon held more fact rows than `maxRows`, so the oldest were not read. */
  truncated: boolean;
  /** Rows each read looked at. */
  scanned: { facts: number; statuses: number; overrides: number; messages: number };
  /** Anything that makes the answer narrower than it looks, in words with the exact next call. */
  problems: string[];
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function inRange(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < min || chosen > max)
    throw new RangeError(`${name} must be a whole number from ${min} to ${max}; got ${String(value)}.`);
  return chosen;
}

const string = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function linksOf(value: unknown): FoldLink[] {
  if (!Array.isArray(value)) return [];
  const links: FoldLink[] = [];
  for (const item of value) {
    const entry = record(item);
    if (entry.relation === "cancel" || entry.relation === "reschedule" || entry.relation === "repeat")
      links.push({
        relation: entry.relation,
        targetFactId:
          typeof entry.target_fact_id === "string" && entry.target_fact_id !== "" ? entry.target_fact_id : null
      });
  }
  return links;
}

function whenOf(value: unknown): FoldWhen | null {
  const when = record(value);
  if (!Array.isArray(when.candidates)) return null;
  return {
    ambiguous: when.ambiguous === true,
    candidates: when.candidates.flatMap((item) => {
      const candidate = record(item);
      return typeof candidate.start === "string"
        ? [{ start: candidate.start, end: typeof candidate.end === "string" ? candidate.end : null }]
        : [];
    })
  };
}

/** A fact row as the fold reads it, or null when it lacks a fact id, a known type or a readable time. */
function factRowOf(row: { event_key: string; ts_start: Date; ingested_at: Date; attrs: unknown }): FoldFactRow | null {
  const attrs = record(row.attrs);
  const factId = string(attrs.fact_id);
  const factType = attrs.fact_type;
  if (factId === null || typeof factType !== "string" || Number.isNaN(row.ts_start.getTime())) return null;
  return {
    key: row.event_key,
    factId,
    factType,
    tsStart: row.ts_start.toISOString(),
    ingestedAt: Number.isNaN(row.ingested_at.getTime()) ? null : row.ingested_at.toISOString(),
    sourceEventId: string(attrs.source_event_id),
    conversationKey: string(attrs.conversation_key),
    icsUid: string(attrs.ics_uid),
    direction: attrs.direction === "in" || attrs.direction === "out" ? attrs.direction : null,
    when: whenOf(attrs.when),
    links: linksOf(attrs.links)
  };
}

export async function readOpenFacts(sql: PoolSql, options: OpenFactsOptions = {}): Promise<OpenFactsRead> {
  const days = inRange(
    "horizonDays",
    options.horizonDays,
    OPEN_FACTS_HORIZON_DAYS_DEFAULT,
    1,
    OPEN_FACTS_HORIZON_DAYS_MAX
  );
  const limit = inRange("limit", options.limit, OPEN_FACTS_LIMIT_DEFAULT, 1, OPEN_FACTS_LIMIT_MAX);
  const maxRows = inRange("maxRows", options.maxRows, OPEN_FACTS_MAX_ROWS_DEFAULT, 1, OPEN_FACTS_MAX_ROWS_MAX);
  const now = options.now ?? new Date();
  const userId = await ensureUser(sql);
  try {
    return await sql.begin("isolation level repeatable read read only", async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '${OPEN_FACTS_STATEMENT_TIMEOUT}'`);
      return readInTransaction(tx, userId, { now, days, limit, maxRows });
    });
  } catch (error) {
    // 57014 is Postgres cancelling a statement that ran past its statement timeout.
    if ((error as { code?: unknown } | null)?.code === "57014") throw new OpenFactsTimeoutError();
    throw error;
  }
}

async function readInTransaction(
  sql: Sql,
  userId: string,
  options: { now: Date; days: number; limit: number; maxRows: number }
): Promise<OpenFactsRead> {
  const { now, days, limit, maxRows } = options;
  const from = new Date(now.getTime() - days * DAY_MS);
  const to = new Date(now.getTime() + DAY_MS);
  const problems: string[] = [];

  // Fact rows of the active versions in the horizon, newest first. One more than `maxRows` says whether it was cut.
  const read = await sql<{ event_key: string; ts_start: Date; ingested_at: Date; attrs: unknown }[]>`
    SELECT e.event_key, e.ts_start, e.ingested_at, e.attrs FROM activity_events e
    WHERE e.user_id = ${userId} AND e.source = 'derived' AND e.kind = 'fact'
      AND e.ts_start >= ${from} AND e.ts_start <= ${to}
      AND EXISTS (
        SELECT 1 FROM extractor_state es
        WHERE es.user_id = e.user_id AND es.active
          AND es.extractor = e.attrs ->> 'extractor' AND es.version = e.attrs ->> 'extractor_version')
    ORDER BY e.ts_start DESC, e.id LIMIT ${maxRows + 1}`;
  const truncated = read.length > maxRows;
  const candidates = truncated ? read.slice(0, maxRows) : read;
  const facts: FoldFactRow[] = [];
  let unreadable = 0;
  for (const row of candidates) {
    const parsed = factRowOf(row);
    if (parsed === null) unreadable += 1;
    else facts.push(parsed);
  }
  if (unreadable > 0)
    problems.push(
      `${unreadable} fact row(s) in the horizon have no usable fact_id, fact_type or time and were skipped. Read them with GET /api/activity-events?source=derived&kind=fact to see which.`
    );
  if (truncated)
    problems.push(
      `The horizon holds more than ${maxRows} fact rows, so the oldest were not read. Pass a smaller horizonDays (now ${days}) to read the whole of a shorter window, or a larger maxRows (at most ${OPEN_FACTS_MAX_ROWS_MAX}).`
    );

  // Standing note: what the horizon leaves out. Counting the rows below it that still have a future time would walk
  // fact rows with no index to serve it, so it is not done; the note says so.
  problems.push(
    `Facts whose source message is older than ${days} days are not read, so an event or deadline mentioned that long ago is missing and total may be low (counting them would scan fact rows with no index to serve it, so it is not done). Pass horizonDays up to ${OPEN_FACTS_HORIZON_DAYS_MAX} to look further back.`
  );

  const scanned = { facts: candidates.length, statuses: 0, overrides: 0, messages: 0 };
  const horizon = { from: from.toISOString(), to: to.toISOString(), days };
  if (facts.length === 0) return { facts: [], total: 0, horizon, truncated, scanned, problems };

  // A status or correction cannot be recorded before the message it is about, so nothing older than the oldest fact read
  // (less a day for clock skew) is looked at.
  const oldest = new Date(Math.min(...facts.map((f) => Date.parse(f.tsStart))) - DAY_MS);
  const factIds = [...new Set(facts.map((f) => f.factId))];
  const statuses: FoldStatus[] = [];
  const overrides: FoldOverride[] = [];
  const bookkeeping = await sql<{ kind: string; event_key: string; attrs: unknown; at: Date; via: string | null }[]>`
    SELECT kind, event_key, attrs, ingested_at AS at, ingested_via AS via FROM activity_events
    WHERE user_id = ${userId} AND source = 'derived' AND kind IN ('fact_status', 'override')
      AND ingested_at >= ${oldest}
      AND attrs ->> 'fact_id' IN (SELECT jsonb_array_elements_text(${sql.json(factIds)}))`;
  for (const item of bookkeeping) {
    const attrs = record(item.attrs);
    const factId = string(attrs.fact_id);
    if (factId === null) continue;
    const actor = statusActorOf(item.via);
    if (item.kind === "fact_status") {
      const status = attrs.status;
      const validFrom = string(attrs.valid_from);
      if (typeof status !== "string" || validFrom === null) continue;
      statuses.push({
        factId,
        status: status as FoldStatus["status"],
        validFrom,
        actor,
        key: item.event_key,
        ingestedAt: item.at.toISOString(),
        // A status can carry the fact's own end (a reschedule, or a hold that keeps an ask open past 14 days). The
        // fold reads only a valid RFC 3339 time and ignores anything else.
        expiresAt: string(attrs.expires_at)
      });
      scanned.statuses += 1;
    } else if (typeof attrs.field === "string" && "new_value" in attrs) {
      overrides.push({
        factId,
        field: attrs.field,
        newValue: attrs.new_value,
        at: item.at.toISOString(),
        actor,
        key: item.event_key
      });
      scanned.overrides += 1;
    }
  }

  // Conversations whose later messages decide a fact: its reply closes an ask, its last message dates an ask or commitment.
  const retyped = new Set(overrides.filter((o) => o.field === "fact_type").map((o) => o.factId));
  const threads = new Set<string>();
  for (const fact of facts) {
    const key = fact.conversationKey;
    if (!key?.startsWith("gmail:")) continue;
    if (fact.factType === "ask" || fact.factType === "commitment" || retyped.has(fact.factId))
      threads.add(key.slice("gmail:".length));
  }
  const conversations: Record<string, FoldMessage[]> = {};
  if (threads.size > 0) {
    const messages = await sql<{ thread: string; last: Date; selfTimes: string[] }[]>`
      SELECT attrs ->> 'thread_id' AS thread, max(least(ts_start, ingested_at)) AS last,
             coalesce(jsonb_agg(least(ts_start, ingested_at) ORDER BY ts_start) FILTER (
               WHERE attrs ->> 'from_self' = 'true'
                 AND coalesce(lower(btrim(attrs ->> 'auto_submitted')), 'no') IN ('no', '')), '[]'::jsonb) AS "selfTimes"
      FROM activity_events
      WHERE user_id = ${userId} AND source = 'gmail' AND attrs ? 'thread_id'
        AND attrs ->> 'thread_id' IN (SELECT jsonb_array_elements_text(${sql.json([...threads])}))
        AND ts_start >= ${oldest} AND kind = 'message'
      GROUP BY 1`;
    for (const row of messages) {
      scanned.messages += 1;
      // His replies, and the thread's last message of any kind (the age-out clock).
      conversations[`gmail:${row.thread}`] = [
        ...row.selfTimes.map((at) => ({ at, fromSelf: true })),
        { at: row.last.toISOString(), fromSelf: false }
      ];
    }
  }

  const open = openFacts(foldFactStates({ facts, statuses, overrides, conversations, now }));
  return { facts: open.slice(0, limit), total: open.length, horizon, truncated, scanned, problems };
}

/** What `readFactEvidence` resolves for one fact row. */
export interface FactEvidence {
  /** The fact row's id and event key. */
  id: string;
  key: string;
  /** Null when the fact has no span (read from a structured invite): there is nothing to resolve. */
  state: "ok" | "source_removed" | "source_changed" | null;
  /** Third-party mail text; present only when `state` is `ok`. Untrusted. */
  text?: string;
  tier: string | null;
  reviewReason: string | null;
  /** The authenticated sender (direction in) or the recipients as typed (out). Outside text. */
  who: string[];
}

interface SpanAttrs {
  start: number;
  end: number;
  hash: string;
}

function spanOf(value: unknown): SpanAttrs | null {
  const span = record(value);
  return Number.isInteger(span.start) && Number.isInteger(span.end) && typeof span.hash === "string"
    ? { start: span.start as number, end: span.end as number, hash: span.hash }
    : null;
}

/**
 * Resolves the spans of fact rows to their mail text at read, through lineage to the message the fact was read from
 * (`attrs.source_event_id`): `source_removed` when the message or its text is gone, `source_changed` when the text no
 * longer hashes as it did. Rows are named by id (the activity read) or by event key (the attention feed, source
 * `derived` only). Reads message text, so callers keep the set small.
 */
export async function readFactEvidence(
  sql: Sql,
  userId: string,
  by: { ids: string[] } | { keys: string[] }
): Promise<FactEvidence[]> {
  const named = "ids" in by ? by.ids : by.keys;
  if (named.length === 0) return [];
  const rows = await sql<
    { id: string; key: string; attrs: unknown; source_key: string | null; content: string | null }[]
  >`
    SELECT f.id, f.event_key AS key, f.attrs, s.event_key AS source_key, s.content
    FROM activity_events f
    LEFT JOIN derived_lineage l ON l.derived_id = f.id
    LEFT JOIN activity_events s ON s.id = l.source_id
    WHERE f.user_id = ${userId} AND f.kind = 'fact' AND f.source IN ('derived', 'derived-shadow')
      AND ${
        "ids" in by
          ? sql`f.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${sql.json(named)}))`
          : sql`f.source = 'derived' AND f.event_key IN (SELECT jsonb_array_elements_text(${sql.json(named)}))`
      }`;
  const byFact = new Map<string, FactEvidence>();
  for (const row of rows) {
    const attrs = record(row.attrs);
    const span = spanOf(attrs.span);
    const wanted = string(attrs.source_event_id);
    const onSource = row.source_key !== null && row.source_key === wanted;
    const resolved = span === null ? null : resolveEvidence(onSource ? row.content : null, span);
    const next: FactEvidence = {
      id: row.id,
      key: row.key,
      state: resolved === null ? null : resolved.state,
      ...(resolved?.state === "ok" ? { text: resolved.text } : {}),
      tier: string(attrs.tier),
      reviewReason: string(attrs.review_reason),
      who: Array.isArray(attrs.who) ? attrs.who.filter((w): w is string => typeof w === "string") : []
    };
    // Several lineage rows (a fact read from several messages): the one on the named message wins.
    const held = byFact.get(row.id);
    if (held === undefined || (onSource && held.state !== "ok")) byFact.set(row.id, next);
  }
  return [...byFact.values()];
}
