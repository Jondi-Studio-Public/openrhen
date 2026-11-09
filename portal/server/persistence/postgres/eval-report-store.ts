import {
  EVAL_CAVEAT,
  buildEvalReport,
  estimateBackfill,
  wrongAutoActions,
  type AutoWrite,
  type BackfillEstimate,
  type EvalLabel,
  type EvalPrediction,
  type EvalReport,
  type EvalSubject,
  type FactReference,
  type FactRow,
  type PersonCorrection,
  type WrongAutoAction
} from "@openrhen/communication-readers";
import { EXTRACTORS } from "@/server/derived/extractor-registry";
import { ensureUser } from "./ensure-user";
import type { PoolSql, Sql } from "./sql-pool";

/**
 * The eval report (communication understanding, slice 2a-3): how well each extractor version agrees with the person's
 * own labels, assembled from stored rows by the pure scoring in `integrations/communication-readers`. Read only; it is
 * the `report=eval` section of the owner's `GET /api/activity-events/summary`, and one read-only REPEATABLE READ
 * transaction, so the numbers describe one moment.
 *
 *   - A label counts only when `source = 'derived'`, `kind = 'label'` and `ingested_via IS NULL` (the person's own
 *     answer, posted from the owner session). A label from Mark or a token is not read; the number of such labels is
 *     shown as `ignored` so a missing count is never a mystery. (`derived-shadow` holds extractor output only, so no
 *     label can be stored there at all.)
 *   - What is scored: the active version of each extractor (source `derived`), and every inactive version with an
 *     `extractor_state` row (source `derived-shadow`; whoever writes shadow rows creates that row first, as the runner
 *     does), each as its own entry, so two versions can be compared before one is promoted.
 *   - Subjects: a `msg_class` row is about the message in `attrs.source_event_id`; a `fact` row is about `attrs.fact_id`.
 *     The other attrs of those rows are the fields a label answers (`class`, `reasons`, `tier`, `fact_type`, ...).
 *   - Facts (2b-1b): a message label `fact_types` is scored by `factMetrics` from the version's fact rows grouped by
 *     `attrs.source_event_id`. A labelled message counts only when the extractor reached it: for the active version,
 *     its (ingested_at, id) lies between the extractor's low (backfill) and high (forward) watermarks; for an inactive
 *     version, its event key (or id) is in `cursor.shadow.done`. A message outside that range with no fact row is
 *     "not reached" and neither a hit nor a correct negative; the entry says how many. A labelled fact the version wrote
 *     under another id is found by the same message and an overlapping span, so a promoted version is scored against
 *     labels made for the old one.
 *   - Corrections for the wrong-auto-action count are the person's labels, `override` rows and `fact_status` rows (the
 *     status is the field "status"), all with `ingested_via IS NULL`. Mark's overrides are not the person's word.
 *     `source_gone` is not an extractor's judgement (the retention pass writes it when mail is deleted), so it is never
 *     counted as a wrong action.
 *   - The random slice is whatever the labeller says it is (`attrs.slice`); no draw is recorded on the server. `stratum`
 *     is stored on the label and not yet reported.
 *   - T0 share: messages given a tier-t0 class (counted through `derived_lineage`, so only messages still held) over the
 *     raw messages still held. Deleted mail leaves both sides together. A label about mail that has since been deleted
 *     is not scored, and the entry says how many.
 *
 * Cost (measured against about 4M rows with the repo's real indexes; numbers in docs/architecture/activity-store.md).
 * Every read is a single pass or an indexed lookup, and nothing scans more than `window` rows beyond the one pass over
 * the person's `derived` rows that finds his labels:
 *   - his labels, overrides, statuses and the extractor-written statuses come from ONE pass over `derived` rows of the
 *     three kinds (there is no index on `kind`; the pass is complete because a label must never be missed);
 *   - predictions about a message come from `derived_lineage` (indexed on `source_id`) and the message from its event
 *     key (unique index);
 *   - fact rows are read by `fact_id` exactly (the partial index of migration 0151, no window) and by message key from
 *     the newest `window` fact rows of each `derived` source (no index on `source_event_id`). Every `kind = 'fact'` and
 *     `source IN ('derived', 'derived-shadow')` predicate there is a SQL literal, so a prepared statement keeps using the
 *     partial indexes;
 *   - the T0 share is taken over the newest `window` raw messages (an ordered index scan), joined through lineage.
 * Each cut-short read says so in the entry's `problems`.
 */

/** Rows looked at per bounded read unless the caller narrows or widens it. */
export const EVAL_WINDOW_DEFAULT = 100_000;
export const EVAL_WINDOW_MIN = 100;
export const EVAL_WINDOW_MAX = 1_000_000;
export const EVAL_STATEMENT_TIMEOUT = "15s";

export interface EvalReportOptions {
  /** When both are given, the report carries a backfill estimate for each raw input source. */
  backfill?: { tokensPerMessage: number; secondsPerMessage: number } | undefined;
  /** Rows the bounded reads look at (fact rows, raw messages for the T0 share); default `EVAL_WINDOW_DEFAULT`. */
  window?: number | undefined;
}

export interface EvalVersionReport {
  source: "derived" | "derived-shadow";
  extractor: string;
  version: string;
  /** True for the version reads show; false for a version held only in `derived-shadow`. */
  active: boolean;
  report: EvalReport;
  /** Anything that makes this entry narrower than it looks: cut-short scans, unscored labels, an impossible count. */
  problems: string[];
}

export interface BackfillSizing {
  source: string;
  kind: string;
  /** Raw rows of the input still held. */
  messages: number;
  estimate: BackfillEstimate;
  /** The same with the share of messages headers alone resolve taken out; null until a tier-t0 share exists. */
  afterT0: BackfillEstimate | null;
}

export interface EvalReportSet {
  /** `ignored`: label rows from Mark, a token, or any other writer than the person, which are not read. */
  labels: { total: number; unfielded: number; ignored: number };
  versions: EvalVersionReport[];
  /** Statuses an extractor wrote itself that the person later changed (never `source_gone`). */
  extractorStatuses: { wrongAutoActions: { count: number; items: WrongAutoAction[]; truncated: boolean } };
  /** Present only when tokens and seconds per message were asked for. */
  backfill?: BackfillSizing[];
  caveat: string;
}

const BOOKKEEPING = new Set(["source_event_id", "fact_id", "extractor", "extractor_version"]);

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function subjectOf(attrs: Record<string, unknown>): EvalSubject | null {
  if (typeof attrs.fact_id === "string") return { kind: "fact", id: attrs.fact_id };
  if (typeof attrs.source_event_id === "string") return { kind: "message", id: attrs.source_event_id };
  return null;
}

interface Mark {
  at: string;
  id: string;
}
const isMark = (value: unknown): value is Mark =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as Mark).at === "string" &&
  typeof (value as Mark).id === "string";
/**
 * Marks hold `ingested_at` as ISO text, microseconds from the database but possibly milliseconds elsewhere, so they are
 * compared by parsed time (to the microsecond), never as text; the id breaks ties. Unparseable text compares as NaN, so
 * the message is never counted as inside a range.
 */
function markTime(at: string): number {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(at);
  if (match === null) return Number.NaN;
  return Date.parse(`${match[1]}Z`) * 1000 + Number((match[2] ?? "").padEnd(6, "0").slice(0, 6));
}
const compareMarks = (a: Mark, b: Mark) => {
  const [x, y] = [markTime(a.at), markTime(b.at)];
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};
const MARK_MICROS = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;
export const SHADOW_DONE_MAX = 200_000;

/**
 * The labelled messages an extractor version has reached. The active version's processed range runs from its low
 * (backfill) watermark to its high (forward) one, both inclusive because each is the last row read; a cursor missing
 * either has reached nothing. An inactive version has no watermarks: it lists what it has read in `cursor.shadow.done`,
 * a flat array of message event keys (or row ids), oldest first; over `SHADOW_DONE_MAX` entries the NEWEST are kept.
 * A message the runner gave up on (`cursor.skippedIds`, entries with `id` and `key`) or is retrying (`cursor.retries`,
 * keyed by row id) was not read, so it is never counted as reached. The runner (2b-4) must keep those fields, and
 * whatever it uses to mark a message `no_content` or T3-deferred, in the cursor for as long as the message is
 * unprocessed, or the report will take it for a correct negative or a miss.
 */
export function reachedMessages(
  active: boolean,
  cursor: Record<string, unknown>,
  held: Map<string, { id: string; mark: Mark }>
) {
  const reached = new Set<string>();
  if (active) {
    if (!isMark(cursor.forward) || !isMark(cursor.backfill)) return reached;
    for (const [key, message] of held)
      if (compareMarks(message.mark, cursor.backfill) >= 0 && compareMarks(message.mark, cursor.forward) <= 0)
        reached.add(key);
  } else {
    const done = record(cursor.shadow).done;
    if (!Array.isArray(done)) return reached;
    const listed = new Set(done.slice(-SHADOW_DONE_MAX).filter((item): item is string => typeof item === "string"));
    for (const [key, message] of held) if (listed.has(key) || listed.has(message.id)) reached.add(key);
  }
  const unread = new Set<string>(Object.keys(record(cursor.retries)));
  if (Array.isArray(cursor.skippedIds))
    for (const item of cursor.skippedIds) {
      const entry = record(item);
      if (typeof entry.id === "string") unread.add(entry.id);
      if (typeof entry.key === "string") unread.add(entry.key);
    }
  for (const [key, message] of held) if (unread.has(key) || unread.has(message.id)) reached.delete(key);
  return reached;
}

function factRowOf(attrs: Record<string, unknown>): FactRow | null {
  if (
    typeof attrs.source_event_id !== "string" ||
    typeof attrs.fact_id !== "string" ||
    typeof attrs.fact_type !== "string"
  )
    return null;
  const span = record(attrs.span);
  return {
    messageId: attrs.source_event_id,
    factId: attrs.fact_id,
    factType: attrs.fact_type,
    span: typeof span.start === "number" && typeof span.end === "number" ? { start: span.start, end: span.end } : null,
    attrs
  };
}

const subjectKey = (subject: EvalSubject) => `${subject.kind}:${subject.id}`;

export async function readEvalReport(sql: PoolSql, options: EvalReportOptions = {}): Promise<EvalReportSet> {
  const userId = await ensureUser(sql);
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = '${EVAL_STATEMENT_TIMEOUT}'`);
    return readInTransaction(tx, userId, options);
  });
}

async function readInTransaction(sql: Sql, userId: string, options: EvalReportOptions): Promise<EvalReportSet> {
  // ONE pass over the person's `derived` rows of the three kinds that are not extractor output (no index on `kind`, so
  // this is the one complete scan; it must be complete because a label must never be missed). It yields his own words
  // (no posting agent), the labels others wrote (counted, not read), and the statuses extractors wrote.
  const bookkeeping = await sql<{ kind: string; attrs: unknown; at: Date; via: string | null }[]>`
    SELECT kind, attrs, ingested_at AS at, ingested_via AS via FROM activity_events
    WHERE user_id = ${userId} AND source = 'derived' AND kind IN ('label', 'override', 'fact_status')`;
  let ignored = 0;
  const autoStatuses: AutoWrite[] = [];
  const own: { kind: string; attrs: unknown; at: Date }[] = [];
  for (const item of bookkeeping) {
    if (item.via === null) own.push(item);
    else if (item.kind === "label") ignored += 1;
    else if (item.kind === "fact_status" && item.via.startsWith("extractor:")) {
      // `source_gone` is the retention pass's bookkeeping, not a judgement of the extractor.
      const attrs = record(item.attrs);
      if (typeof attrs.fact_id === "string" && typeof attrs.status === "string" && attrs.status !== "source_gone")
        autoStatuses.push({
          subject: { kind: "fact", id: attrs.fact_id },
          field: "status",
          value: attrs.status,
          at: item.at.toISOString()
        });
    }
  }

  const labels: EvalLabel[] = [];
  const corrections: PersonCorrection[] = [];
  for (const item of own) {
    const attrs = record(item.attrs);
    const subject = subjectOf(attrs);
    if (subject === null) continue;
    const at = item.at.toISOString();
    if (item.kind === "label") {
      const field = typeof attrs.field === "string" ? attrs.field : null;
      labels.push({
        subject,
        field,
        answer: attrs.answer ?? null,
        at,
        slice: attrs.slice === "random" || attrs.slice === "stratified" ? attrs.slice : null,
        stratum: typeof attrs.stratum === "string" ? attrs.stratum : null
      });
      if (field !== null) corrections.push({ subject, field, value: attrs.answer ?? null, at });
    } else if (item.kind === "override" && subject.kind === "fact" && typeof attrs.field === "string") {
      corrections.push({ subject, field: attrs.field, value: attrs.new_value ?? null, at });
    } else if (item.kind === "fact_status" && subject.kind === "fact") {
      corrections.push({ subject, field: "status", value: attrs.status ?? null, at });
    }
  }

  // Which versions to score: every active version, and every other version that has an extractor_state row.
  const states = await sql<{ extractor: string; version: string; active: boolean; cursor: unknown }[]>`
    SELECT extractor, version, active, cursor FROM extractor_state WHERE user_id = ${userId} ORDER BY extractor, version`;
  const groups = states.map((row) => ({
    source: row.active ? ("derived" as const) : ("derived-shadow" as const),
    extractor: row.extractor,
    version: row.version,
    active: row.active,
    cursor: record(row.cursor)
  }));
  const sameGroup = (attrs: Record<string, unknown>, group: { extractor: string; version: string }) =>
    attrs.extractor === group.extractor && attrs.extractor_version === group.version;

  const wanted = (kind: EvalSubject["kind"]) => [
    ...new Set(
      [...labels.map((l) => l.subject), ...corrections.map((c) => c.subject)]
        .filter((s) => s.kind === kind)
        .map((s) => s.id)
    )
  ];
  const messageKeys = wanted("message");
  const factIds = wanted("fact");
  // Messages whose `fact_types` label is scored from fact rows grouped by message.
  const factMessageKeys = [
    ...new Set(labels.filter((l) => l.subject.kind === "message" && l.field === "fact_types").map((l) => l.subject.id))
  ];
  const window = options.window ?? EVAL_WINDOW_DEFAULT;

  // Per distinct input source: the labelled messages still held (by event key) and every version's class rows about them.
  interface InputRead {
    held: Map<string, string>;
    /** The same messages with their position, for the extractor's processed range. */
    marks: Map<string, { id: string; mark: Mark }>;
    classRows: { source: string; attrs: Record<string, unknown>; at: Date }[];
    /** Raw messages looked at for the T0 share (the newest `window`), and whether there were more. */
    windowMessages: number;
    windowCut: boolean;
    /** Tier-t0 classes among them, by source/extractor/version. */
    t0: Map<string, number>;
  }
  const inputs = new Map<string, InputRead>();
  const readInput = async (input: { source: string; kind: string }): Promise<InputRead> => {
    const key = `${input.source}\u0000${input.kind}`;
    const done = inputs.get(key);
    if (done !== undefined) return done;
    const held = new Map<string, string>();
    const marks = new Map<string, { id: string; mark: Mark }>();
    if (messageKeys.length > 0) {
      const rows = await sql<{ id: string; event_key: string; at: string }[]>`
        SELECT id, event_key, to_char(ingested_at AT TIME ZONE 'UTC', ${MARK_MICROS}) AS at FROM activity_events
        WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
          AND event_key IN (SELECT jsonb_array_elements_text(${sql.json(messageKeys)}))`;
      for (const row of rows) {
        held.set(row.event_key, row.id);
        marks.set(row.event_key, { id: row.id, mark: { at: row.at, id: row.id } });
      }
    }
    const classRows: InputRead["classRows"] = [];
    if (held.size > 0) {
      // Through lineage (indexed on source_id): never a scan of the derived rows.
      const found = await sql<{ source: string; attrs: unknown; at: Date }[]>`
        SELECT e.source, e.attrs, e.ingested_at AS at
        FROM derived_lineage dl
        JOIN activity_events e ON e.id = dl.derived_id
        WHERE dl.user_id = ${userId}
          AND dl.source_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${sql.json([...held.values()])}))
          AND e.source IN ('derived', 'derived-shadow') AND e.kind = 'msg_class'`;
      for (const row of found) classRows.push({ source: row.source, attrs: record(row.attrs), at: row.at });
    }
    // The T0 share over the newest `window` raw messages: an ordered index scan, then lineage by an indexed lateral
    // lookup per message (the LIMIT keeps the planner from hashing the whole lineage table). One more row than the
    // window says whether the window cut anything off.
    const [seen] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM activity_events
        WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
        ORDER BY ingested_at DESC LIMIT ${window + 1}) newest`;
    const t0 = new Map<string, number>();
    const t0Rows = await sql<{ source: string; extractor: string; version: string; n: number }[]>`
      WITH newest AS MATERIALIZED (
        SELECT id FROM activity_events
        WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
        ORDER BY ingested_at DESC LIMIT ${window})
      SELECT e.source, e.attrs ->> 'extractor' AS extractor, e.attrs ->> 'extractor_version' AS version,
             count(DISTINCT newest.id)::int AS n
      FROM newest
      CROSS JOIN LATERAL (SELECT derived_id FROM derived_lineage WHERE source_id = newest.id LIMIT 50) dl
      JOIN activity_events e ON e.id = dl.derived_id
      WHERE e.source IN ('derived', 'derived-shadow') AND e.kind = 'msg_class' AND e.attrs ->> 'tier' = 't0'
      GROUP BY 1, 2, 3`;
    for (const row of t0Rows) t0.set(`${row.source}\u0000${row.extractor}\u0000${row.version}`, row.n);
    const read = {
      held,
      marks,
      classRows,
      windowMessages: Math.min(seen?.n ?? 0, window),
      windowCut: (seen?.n ?? 0) > window,
      t0
    };
    inputs.set(key, read);
    return read;
  };

  // Fact rows, two reads per source. Both keep `kind = 'fact'` and `source IN (...)` as SQL literals so the partial
  // indexes of migration 0151 serve them (a bound parameter there would make a prepared statement pick a generic plan
  // that cannot use a partial index); `source = ${source}` narrows to one of the two.
  //  - By fact id: exact, no window, served by (the `= ANY(ARRAY(...))` form, checked with EXPLAIN on 1.2M seeded rows and a
  //    generic plan; `IN (SELECT ...)` made Postgres hash-join over the whole derived partial index instead) `(user_id, (attrs ->> 'fact_id')) WHERE kind = 'fact'`.
  //  - By message key (`attrs.source_event_id`, which has no index): the newest `window` FACT rows of the source, counted
  //    in fact rows (`kind = 'fact'` inside the LIMIT; the planner walks the person's newest derived rows of the source
  //    and filters on kind, so this is fast while facts are dense among them), then filtered to the messages. This is the
  //    only read that can be cut short.
  const factsBySource = new Map<string, { attrs: Record<string, unknown>; at: Date }[]>();
  const factCut = new Map<string, Date | null>();
  const readFacts = async (source: string, ids: string[], messages: string[]) => {
    const found: { attrs: unknown; at: Date | null }[] = [];
    if (ids.length > 0)
      found.push(
        ...(await sql<{ attrs: unknown; at: Date }[]>`
          SELECT attrs, ingested_at AS at FROM activity_events
          WHERE user_id = ${userId} AND kind = 'fact' AND source IN ('derived', 'derived-shadow') AND source = ${source}
            AND attrs ->> 'fact_id' = ANY(ARRAY(SELECT jsonb_array_elements_text(${sql.json(ids)})))`)
      );
    if (messages.length > 0) {
      const byMessage = await sql<{ attrs: unknown; at: Date | null; scanned: number; floor: Date | null }[]>`
        WITH newest AS MATERIALIZED (
          SELECT attrs, ingested_at FROM activity_events
          WHERE user_id = ${userId} AND kind = 'fact' AND source IN ('derived', 'derived-shadow') AND source = ${source}
          ORDER BY ingested_at DESC LIMIT ${window}),
        hit AS (
          SELECT attrs, ingested_at FROM newest
          WHERE attrs ->> 'source_event_id' IN (SELECT jsonb_array_elements_text(${sql.json(messages)})))
        SELECT attrs, ingested_at AS at, (SELECT count(*)::int FROM newest) AS scanned,
               (SELECT min(ingested_at) FROM newest) AS floor FROM hit
        UNION ALL
        SELECT NULL, NULL, (SELECT count(*)::int FROM newest), (SELECT min(ingested_at) FROM newest)
        WHERE NOT EXISTS (SELECT 1 FROM hit)`;
      if ((byMessage[0]?.scanned ?? 0) >= window && !factCut.has(source))
        factCut.set(source, byMessage[0]?.floor ?? null);
      found.push(...byMessage);
    }
    // A source read twice is cut by the same window, so the first floor stands.
    const held = factsBySource.get(source) ?? [];
    const seen = new Set(held.map((item) => `${item.at.getTime()}\u0000${JSON.stringify(item.attrs)}`));
    for (const item of found) {
      if (item.attrs === null || item.at === null) continue;
      const entry = { attrs: record(item.attrs), at: item.at };
      const id = `${entry.at.getTime()}\u0000${JSON.stringify(entry.attrs)}`;
      if (!seen.has(id)) {
        seen.add(id);
        held.push(entry);
      }
    }
    factsBySource.set(source, held);
  };
  const factSources = [...new Set(groups.map((g) => g.source))];
  if (factIds.length > 0 || factMessageKeys.length > 0)
    for (const source of factSources) await readFacts(source, factIds, factMessageKeys);
  // Where each labelled fact sits (message and span), as whichever version wrote it last; the fallback join needs it.
  // A fact id can be written for several messages (the same sentence repeated), so a reference is one id on one message.
  const factIdSet = new Set(factIds);
  const references = new Map<string, FactReference & { at: number }>();
  for (const rows of factsBySource.values())
    for (const row of rows) {
      const fact = factRowOf(row.attrs);
      if (fact === null || !factIdSet.has(fact.factId)) continue;
      const key = `${fact.factId}\u0000${fact.messageId}`;
      const held = references.get(key);
      if (held === undefined || held.at <= row.at.getTime())
        references.set(key, { factId: fact.factId, messageId: fact.messageId, span: fact.span, at: row.at.getTime() });
    }
  // Candidates for the fallback join are the rows about those messages, whether or not the message itself is labelled.
  const referenceMessages = [...new Set([...references.values()].map((r) => r.messageId))].filter(
    (m) => !factMessageKeys.includes(m)
  );
  if (referenceMessages.length > 0) for (const source of factSources) await readFacts(source, [], referenceMessages);

  const versions: EvalVersionReport[] = [];
  for (const group of groups) {
    const problems: string[] = [];
    const known = EXTRACTORS.find((candidate) => candidate.name === group.extractor);
    const rows: { attrs: Record<string, unknown>; at: Date }[] = [];
    let scoredLabels = labels;
    let t0: { messages: number; resolvedByT0: number } | null = null;
    let reached = new Set<string>();

    if (known === undefined) {
      if (messageKeys.length > 0)
        problems.push(
          `The server does not know extractor "${group.extractor}", so its input source is unknown: predictions about messages and the T0 share are left out.`
        );
    } else {
      const read = await readInput(known.input);
      rows.push(...read.classRows.filter((row) => row.source === group.source && sameGroup(row.attrs, group)));
      const gone = labels.filter((l) => l.subject.kind === "message" && !read.held.has(l.subject.id));
      if (gone.length > 0) {
        scoredLabels = labels.filter((l) => !(l.subject.kind === "message" && !read.held.has(l.subject.id)));
        problems.push(`${gone.length} label(s) are about mail that has since been deleted and are not scored.`);
      }
      reached = reachedMessages(group.active, group.cursor, read.marks);
      // An extractor that writes no class (fact-ics) has no T0 share: counting its zero classes would read as "nothing resolved".
      if (known.classifies !== false) {
        t0 = {
          messages: read.windowMessages,
          resolvedByT0: read.t0.get(`${group.source}\u0000${group.extractor}\u0000${group.version}`) ?? 0
        };
        if (read.windowCut)
          problems.push(
            `The T0 share is over the newest ${window} messages only; there are more. Pass a larger window to widen it.`
          );
      }
    }

    // This version's fact rows, one per fact id (the latest write).
    const factRows = new Map<string, { row: FactRow; at: number }>();
    const rowKey = (fact: FactRow) => `${fact.factId}\u0000${fact.messageId}`;
    if (factIds.length > 0 || factMessageKeys.length > 0) {
      const own = (factsBySource.get(group.source) ?? []).filter((row) => sameGroup(row.attrs, group));
      rows.push(...own);
      for (const item of own) {
        const fact = factRowOf(item.attrs);
        const held = fact === null ? undefined : factRows.get(rowKey(fact));
        if (fact !== null && (held === undefined || held.at <= item.at.getTime()))
          factRows.set(rowKey(fact), { row: fact, at: item.at.getTime() });
      }
      if (factCut.has(group.source)) {
        // Rows older than the window were not read, so a labelled message whose rows may be among them is neither a
        // miss nor a correct negative: it is left out. Its rows are complete only when all lie inside the window.
        const floor = factCut.get(group.source)?.getTime() ?? Number.POSITIVE_INFINITY;
        for (const key of factMessageKeys) {
          const times = own.filter((item) => item.attrs.source_event_id === key).map((item) => item.at.getTime());
          if (times.length > 0 && Math.min(...times) > floor) continue;
          reached.delete(key);
          for (const [id, entry] of factRows) if (entry.row.messageId === key) factRows.delete(id);
        }
        problems.push(
          `Only the newest ${window} fact rows of ${group.source} were looked at to find the facts of labelled messages, so a label about an older message may show no prediction. Pass a larger window to widen it.`
        );
      }
    }

    const predictions = new Map<string, { prediction: EvalPrediction; at: number }>();
    const writes: AutoWrite[] = [];
    for (const row of rows) {
      const subject = subjectOf(row.attrs);
      if (subject === null) continue;
      for (const [field, value] of Object.entries(row.attrs)) {
        if (BOOKKEEPING.has(field)) continue;
        writes.push({ subject, field, value, at: row.at.toISOString() });
        // Several rows can speak for one subject and field; the latest is what the extractor says now.
        const key = `${subjectKey(subject)}\u0000${field}`;
        if (!predictions.has(key) || predictions.get(key)!.at <= row.at.getTime())
          predictions.set(key, { prediction: { subject, field, value }, at: row.at.getTime() });
      }
    }

    let report: EvalReport;
    const make = (t0Input: typeof t0) =>
      buildEvalReport({
        labels: scoredLabels,
        predictions: [...predictions.values()].map((entry) => entry.prediction),
        writes,
        corrections,
        facts: {
          rows: [...factRows.values()].map((entry) => entry.row),
          reached,
          references: [...references.values()].map(({ at: _at, ...reference }) => reference)
        },
        t0: t0Input
      });
    try {
      report = make(t0);
    } catch (error) {
      // An impossible count (more messages resolved than held) is reported, not clamped and not allowed to hide the rest.
      problems.push(
        `The T0 share was left out: ${error instanceof Error ? error.message : "its counts do not add up."}`
      );
      report = make(null);
    }
    if (report.facts.notReached > 0)
      problems.push(
        `${report.facts.notReached} labelled message(s) are outside what this version has processed and have no fact row; they are not scored (not a hit, a miss or a correct negative).`
      );
    if (report.facts.unreadable > 0)
      problems.push(`${report.facts.unreadable} fact_types label(s) are not a list of fact types and are not scored.`);
    versions.push({
      source: group.source,
      extractor: group.extractor,
      version: group.version,
      active: group.active,
      report,
      problems
    });
  }

  const set: EvalReportSet = {
    labels: { total: labels.length, unfielded: labels.filter((l) => l.field === null).length, ignored },
    versions,
    extractorStatuses: { wrongAutoActions: wrongAutoActions(autoStatuses, corrections) },
    caveat: EVAL_CAVEAT
  };

  if (options.backfill !== undefined) {
    const inputs = new Map<string, { source: string; kind: string }>();
    for (const extractor of EXTRACTORS)
      inputs.set(`${extractor.input.source}\u0000${extractor.input.kind}`, extractor.input);
    set.backfill = [];
    for (const input of inputs.values()) {
      // The one exact count of the raw rows (an index range count with a heap check for `kind`); only when a sizing was asked for.
      const [counted] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM activity_events
        WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}`;
      const messages = counted?.n ?? 0;
      const base = { messages, ...options.backfill };
      const share = versions
        .filter((v) => v.active && EXTRACTORS.find((e) => e.name === v.extractor)?.input.source === input.source)
        .map((v) => v.report.t0)
        .find((t) => t !== null && t.share !== null);
      set.backfill.push({
        source: input.source,
        kind: input.kind,
        messages,
        estimate: estimateBackfill(base),
        afterT0: share?.share == null ? null : estimateBackfill({ ...base, t0Share: share.share })
      });
    }
  }
  return set;
}
