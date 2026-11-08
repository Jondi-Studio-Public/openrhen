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
 *   - fact rows have no index by `fact_id`, so only the newest `window` rows of each `derived` source are looked at;
 *   - the T0 share is taken over the newest `window` raw messages (an ordered index scan), joined through lineage.
 * Each cut-short read says so in the entry's `problems`. The migration that introduces fact writers (2b) owes an
 * expression index on (user_id, (attrs ->> 'fact_id')) and one on (user_id, source, kind); with them the window goes.
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
  const states = await sql<{ extractor: string; version: string; active: boolean }[]>`
    SELECT extractor, version, active FROM extractor_state WHERE user_id = ${userId} ORDER BY extractor, version`;
  const groups = states.map((row) => ({
    source: row.active ? ("derived" as const) : ("derived-shadow" as const),
    extractor: row.extractor,
    version: row.version,
    active: row.active
  }));
  const sameGroup = (attrs: Record<string, unknown>, group: (typeof groups)[number]) =>
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
  const window = options.window ?? EVAL_WINDOW_DEFAULT;

  // Per distinct input source: the labelled messages still held (by event key) and every version's class rows about them.
  interface InputRead {
    held: Map<string, string>;
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
    if (messageKeys.length > 0) {
      const rows = await sql<{ id: string; event_key: string }[]>`
        SELECT id, event_key FROM activity_events
        WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
          AND event_key IN (SELECT jsonb_array_elements_text(${sql.json(messageKeys)}))`;
      for (const row of rows) held.set(row.event_key, row.id);
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
      classRows,
      windowMessages: Math.min(seen?.n ?? 0, window),
      windowCut: (seen?.n ?? 0) > window,
      t0
    };
    inputs.set(key, read);
    return read;
  };

  // Fact rows: only the newest `window` rows of each source are looked at (there is no index by fact id).
  // The predicates that must match migration 0150's partial indexes (`source IN ('derived', 'derived-shadow')`,
  // `kind = 'fact'`) are written as SQL literals, not bind parameters: a prepared statement can switch to a generic plan,
  // which cannot prove a parameter implies a partial index's predicate and so cannot use the index. `source = ${source}`
  // then only narrows within the literal.
  const factsBySource = new Map<string, { attrs: Record<string, unknown>; at: Date }[]>();
  const factCut = new Set<string>();
  if (factIds.length > 0)
    for (const source of new Set(groups.map((g) => g.source))) {
      const found = await sql<{ attrs: unknown; at: Date | null; scanned: number }[]>`
        WITH newest AS (
          SELECT kind, attrs, ingested_at FROM activity_events
          WHERE user_id = ${userId} AND source IN ('derived', 'derived-shadow') AND source = ${source}
          ORDER BY ingested_at DESC LIMIT ${window})
        SELECT attrs, ingested_at AS at, (SELECT count(*)::int FROM newest) AS scanned
        FROM newest
        WHERE kind = 'fact' AND attrs ->> 'fact_id' IN (SELECT jsonb_array_elements_text(${sql.json(factIds)}))
        UNION ALL
        SELECT NULL, NULL, (SELECT count(*)::int FROM newest)
        WHERE NOT EXISTS (SELECT 1 FROM newest WHERE kind = 'fact' AND attrs ->> 'fact_id' IN (SELECT jsonb_array_elements_text(${sql.json(factIds)})))`;
      if ((found[0]?.scanned ?? 0) >= window) factCut.add(source);
      factsBySource.set(
        source,
        found
          .filter((row) => row.attrs !== null && row.at !== null)
          .map((row) => ({ attrs: record(row.attrs), at: row.at! }))
      );
    }

  const versions: EvalVersionReport[] = [];
  for (const group of groups) {
    const problems: string[] = [];
    const known = EXTRACTORS.find((candidate) => candidate.name === group.extractor);
    const rows: { attrs: Record<string, unknown>; at: Date }[] = [];
    let scoredLabels = labels;
    let t0: { messages: number; resolvedByT0: number } | null = null;

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
      t0 = {
        messages: read.windowMessages,
        resolvedByT0: read.t0.get(`${group.source}\u0000${group.extractor}\u0000${group.version}`) ?? 0
      };
      if (read.windowCut)
        problems.push(
          `The T0 share is over the newest ${window} messages only; there are more. Pass a larger window to widen it.`
        );
    }

    if (factIds.length > 0) {
      rows.push(...(factsBySource.get(group.source) ?? []).filter((row) => sameGroup(row.attrs, group)));
      if (factCut.has(group.source))
        problems.push(
          `Only the newest ${window} rows of ${group.source} were looked at for facts, so labels about older facts may show no prediction. An index on the fact id (owed in the migration that adds fact writers) removes this limit.`
        );
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
    versions.push({ ...group, report, problems });
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
