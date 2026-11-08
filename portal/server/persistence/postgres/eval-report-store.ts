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
 * Cost. Predictions about a message are found through `derived_lineage` (indexed on `source_id`), and the message is
 * found by its event key (unique index). Predictions about a fact, and the person's own rows, are not: there is no
 * index on `attrs ->> 'fact_id'` or on `(user_id, source, kind)`, so the fact read looks at the newest
 * `FACT_SCAN_CAP` fact rows only (and says so when that cuts it short) and the whole read runs under a statement
 * timeout. The migration that introduces fact writers (2b) owes an expression index on (user_id, (attrs ->> 'fact_id'))
 * and one on (user_id, source, kind); with them the cap can go.
 */

export const FACT_SCAN_CAP = 20_000;
export const EVAL_STATEMENT_TIMEOUT = "15s";

export interface EvalReportOptions {
  /** When both are given, the report carries a backfill estimate for each raw input source. */
  backfill?: { tokensPerMessage: number; secondsPerMessage: number } | undefined;
  /** Fact rows looked at per version; a test lowers it. */
  factScanCap?: number | undefined;
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

interface DerivedRow {
  attrs: unknown;
  at: Date;
}

export async function readEvalReport(sql: PoolSql, options: EvalReportOptions = {}): Promise<EvalReportSet> {
  const userId = await ensureUser(sql);
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = '${EVAL_STATEMENT_TIMEOUT}'`);
    return readInTransaction(tx, userId, options);
  });
}

async function readInTransaction(sql: Sql, userId: string, options: EvalReportOptions): Promise<EvalReportSet> {
  // The person's own words: labels, overrides and statuses with no posting agent.
  const own = await sql<{ kind: string; attrs: unknown; at: Date }[]>`
    SELECT kind, attrs, ingested_at AS at FROM activity_events
    WHERE user_id = ${userId} AND source = 'derived' AND kind IN ('label', 'override', 'fact_status')
      AND ingested_via IS NULL`;
  const [{ ignored } = { ignored: 0 }] = await sql<{ ignored: number }[]>`
    SELECT count(*)::int AS ignored FROM activity_events
    WHERE user_id = ${userId} AND source = 'derived' AND kind = 'label' AND ingested_via IS NOT NULL`;

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

  const wanted = (kind: EvalSubject["kind"]) => [
    ...new Set(
      [...labels.map((l) => l.subject), ...corrections.map((c) => c.subject)]
        .filter((s) => s.kind === kind)
        .map((s) => s.id)
    )
  ];
  const messageKeys = wanted("message");
  const factIds = wanted("fact");
  const factCap = options.factScanCap ?? FACT_SCAN_CAP;

  // The raw messages still held, by event key, for each distinct input.
  const heldByInput = new Map<string, Map<string, string>>();
  const heldMessages = async (input: { source: string; kind: string }) => {
    const key = `${input.source}\u0000${input.kind}`;
    let held = heldByInput.get(key);
    if (held === undefined) {
      held = new Map();
      if (messageKeys.length > 0) {
        const rows = await sql<{ id: string; event_key: string }[]>`
          SELECT id, event_key FROM activity_events
          WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}
            AND event_key IN (SELECT jsonb_array_elements_text(${sql.json(messageKeys)}))`;
        for (const row of rows) held.set(row.event_key, row.id);
      }
      heldByInput.set(key, held);
    }
    return held;
  };
  const rawCounts = new Map<string, number>();
  const rawCount = async (input: { source: string; kind: string }) => {
    const key = `${input.source}\u0000${input.kind}`;
    if (!rawCounts.has(key)) {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM activity_events
        WHERE user_id = ${userId} AND source = ${input.source} AND kind = ${input.kind}`;
      rawCounts.set(key, row?.n ?? 0);
    }
    return rawCounts.get(key) ?? 0;
  };

  const versions: EvalVersionReport[] = [];
  for (const group of groups) {
    const problems: string[] = [];
    const input = EXTRACTORS.find((candidate) => candidate.name === group.extractor)?.input ?? null;
    const rows: DerivedRow[] = [];
    let scoredLabels = labels;

    if (input === null) {
      if (messageKeys.length > 0)
        problems.push(
          `The server does not know extractor "${group.extractor}", so its input source is unknown: predictions about messages and the T0 share are left out.`
        );
    } else {
      const held = await heldMessages(input);
      // Predictions about a message, through lineage (indexed on source_id): never a scan of the derived rows.
      if (held.size > 0) {
        const found = await sql<DerivedRow[]>`
          SELECT e.attrs, e.ingested_at AS at
          FROM derived_lineage dl
          JOIN activity_events e ON e.id = dl.derived_id
          WHERE dl.user_id = ${userId}
            AND dl.source_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${sql.json([...held.values()])}))
            AND e.source = ${group.source} AND e.kind = 'msg_class'
            AND e.attrs ->> 'extractor' = ${group.extractor} AND e.attrs ->> 'extractor_version' = ${group.version}`;
        rows.push(...found);
      }
      const gone = labels.filter((l) => l.subject.kind === "message" && !held.has(l.subject.id));
      if (gone.length > 0) {
        scoredLabels = labels.filter((l) => !(l.subject.kind === "message" && !held.has(l.subject.id)));
        problems.push(`${gone.length} label(s) are about mail that has since been deleted and are not scored.`);
      }
    }

    if (factIds.length > 0) {
      // Only the newest `factCap` fact rows of this source are looked at (no index to find them by fact_id).
      const recent = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM (
          SELECT 1 FROM activity_events
          WHERE user_id = ${userId} AND source = ${group.source} AND kind = 'fact'
          ORDER BY ingested_at DESC LIMIT ${factCap}) newest`;
      if ((recent[0]?.n ?? 0) >= factCap)
        problems.push(
          `Only the newest ${factCap} fact rows were looked at, so labels about older facts may show no prediction. An index on the fact id (owed in the migration that adds fact writers) removes this limit.`
        );
      const found = await sql<DerivedRow[]>`
        SELECT attrs, at FROM (
          SELECT attrs, ingested_at AS at FROM activity_events
          WHERE user_id = ${userId} AND source = ${group.source} AND kind = 'fact'
          ORDER BY ingested_at DESC LIMIT ${factCap}) newest
        WHERE attrs ->> 'extractor' = ${group.extractor} AND attrs ->> 'extractor_version' = ${group.version}
          AND attrs ->> 'fact_id' IN (SELECT jsonb_array_elements_text(${sql.json(factIds)}))`;
      rows.push(...found);
    }

    const predictions = new Map<string, { prediction: EvalPrediction; at: number }>();
    const writes: AutoWrite[] = [];
    for (const row of rows) {
      const attrs = record(row.attrs);
      const subject = subjectOf(attrs);
      if (subject === null) continue;
      for (const [field, value] of Object.entries(attrs)) {
        if (BOOKKEEPING.has(field)) continue;
        writes.push({ subject, field, value, at: row.at.toISOString() });
        // Several rows can speak for one subject and field; the latest is what the extractor says now.
        const key = `${subjectKey(subject)}\u0000${field}`;
        if (!predictions.has(key) || predictions.get(key)!.at <= row.at.getTime())
          predictions.set(key, { prediction: { subject, field, value }, at: row.at.getTime() });
      }
    }

    let t0: { messages: number; resolvedByT0: number } | null = null;
    if (input !== null) {
      // Tier-t0 classes counted through lineage, so a class whose message is gone is not counted.
      const [t0Row] = await sql<{ n: number }[]>`
        SELECT count(DISTINCT s.id)::int AS n
        FROM activity_events e
        JOIN derived_lineage dl ON dl.derived_id = e.id
        JOIN activity_events s ON s.id = dl.source_id AND s.source = ${input.source} AND s.kind = ${input.kind}
        WHERE e.user_id = ${userId} AND e.source = ${group.source} AND e.kind = 'msg_class'
          AND e.attrs ->> 'tier' = 't0'
          AND e.attrs ->> 'extractor' = ${group.extractor} AND e.attrs ->> 'extractor_version' = ${group.version}`;
      t0 = { messages: await rawCount(input), resolvedByT0: t0Row?.n ?? 0 };
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

  // Statuses an extractor wrote itself (`source_gone` is the retention pass's bookkeeping, not a judgement).
  const statusWrites = await sql<{ attrs: unknown; at: Date }[]>`
    SELECT attrs, ingested_at AS at FROM activity_events
    WHERE user_id = ${userId} AND source = 'derived' AND kind = 'fact_status' AND ingested_via LIKE 'extractor:%'`;
  const autoStatuses: AutoWrite[] = statusWrites.flatMap((row) => {
    const attrs = record(row.attrs);
    return typeof attrs.fact_id === "string" && typeof attrs.status === "string" && attrs.status !== "source_gone"
      ? [
          {
            subject: { kind: "fact" as const, id: attrs.fact_id },
            field: "status",
            value: attrs.status,
            at: row.at.toISOString()
          }
        ]
      : [];
  });

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
      const messages = await rawCount(input);
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
