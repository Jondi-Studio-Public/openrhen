import {
  ACTIVITY_PURGE_BATCH,
  ACTIVITY_READ_DEFAULT_LIMIT,
  ACTIVITY_READ_MAX_LIMIT,
  ACTIVITY_SCHEMA_VERSION,
  ACTIVITY_SOURCES,
  ACTIVITY_SOURCE_NAMES,
  DERIVED_EXTRACTOR_KINDS,
  isKnownActivitySource,
  validateActivityEvent,
  type ActivityEventRow,
  type ActivityEventsPage,
  type ActivityExtractorSummary,
  type ActivityIngestResult,
  type ActivityRejection,
  type ActivitySourceSettings,
  type ActivitySummary,
  type ValidActivityEvent
} from "@openrhen/contracts";
import { EXTRACTORS } from "@/server/derived/extractor-registry";
import { runtimeEnv } from "@/server/runtime-env";
import { lockActivityUser } from "./activity-lock";
import { purgeExpiredForUserTx } from "./activity-retention-store";
import { deleteDerivedForSources } from "./derived-lineage-store";
import { countRowsAfter, countRowsBefore, type Mark } from "./derived-scan-store";
import { ensureUser } from "./ensure-user";
import { readExtractorStates } from "./extractor-state-store";
import type { PoolSql, Sql, TxSql } from "./sql-pool";

/**
 * The activity store: one append-only table of events from every non-plan source (activity-store design). Rows are
 * never updated (a trigger refuses it); this module is the only code that deletes them, for undo-import, purge by
 * source and the retention purge. Deliberately outside the planning inputs, so the engine never sees it and a write
 * queues no recalculation.
 */

/** The caller named something that is not there or not theirs; the route answers with the message. */
export class ActivityInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400
  ) {
    super(message);
  }
}

const INSERT_CHUNK = 500;

/** The gate for a source with no `activity_source_state` row: `OPENRHEN_ACTIVITY_CONTENT_DEFAULT` = `on`, otherwise off. */
export function activityContentDefault(): boolean {
  return runtimeEnv().OPENRHEN_ACTIVITY_CONTENT_DEFAULT?.trim().toLowerCase() === "on";
}

export interface ActivityBatch {
  device?: string | undefined;
  import?: { sha256: string; filename: string; source?: string | undefined } | undefined;
  importId?: string | undefined;
  events: readonly unknown[];
}

interface SourceStateRow {
  source: string;
  content_enabled: boolean;
  retention_days: number | null;
  cursor?: unknown;
}

/** The last retention purge that deleted something, kept in the source state's cursor by the retention pass. */
function readLastPurge(cursor: unknown): { removed: number; at: string; skipped?: string } | null {
  const held = (cursor as { lastPurge?: { removed?: unknown; at?: unknown; skipped?: unknown } } | null)?.lastPurge;
  if (typeof held?.removed !== "number" || typeof held.at !== "string") return null;
  return typeof held.skipped === "string"
    ? { removed: held.removed, at: held.at, skipped: held.skipped }
    : { removed: held.removed, at: held.at };
}

/**
 * Takes one batch. Each event is judged alone: a bad one is reported with the exact fix and the rest are stored.
 * A key already held (in the store, or earlier in this batch) is `alreadyHeld`, never an error and never a change.
 * Content is dropped, and counted, for a source whose gate is off, except in a file import, which always keeps it. Runs in one transaction.
 */
export async function ingestActivityEvents(
  sql: PoolSql,
  batch: ActivityBatch,
  via: string | null,
  now: Date = new Date()
): Promise<ActivityIngestResult> {
  const rejected: ActivityRejection[] = [];
  const judged: { index: number; event: ValidActivityEvent }[] = [];
  batch.events.forEach((raw, index) => {
    const verdict = validateActivityEvent(raw, now);
    if (verdict.ok) judged.push({ index, event: verdict.event });
    else rejected.push({ index, reason: verdict.reason });
  });

  const userId = await ensureUser(sql);
  return sql.begin(async (tx) => {
    let importId: string | null = null;
    let importSource: string | null = null;
    if (batch.importId !== undefined) {
      const [owned] = await tx<{ id: string; source: string }[]>`
        SELECT id, source FROM activity_imports WHERE id = ${batch.importId} AND user_id = ${userId}`;
      if (!owned)
        throw new ActivityInputError(
          `importId ${batch.importId} is not an import you hold. Send the first batch of the file with "import": {"sha256", "filename"} and use the importId it returns.`,
          404
        );
      importId = owned.id;
      importSource = owned.source;
    } else if (batch.import) {
      const source = batch.import.source ?? judged[0]?.event.source;
      if (source === undefined)
        throw new ActivityInputError(
          'import.source is needed because every event in this batch was rejected, so there is no event to take it from. Send "import": {"sha256", "filename", "source": "<source>"} and fix the events listed in `rejected`.'
        );
      if (!isKnownActivitySource(source))
        throw new ActivityInputError(
          `import.source "${source}" is not known. Use one of: ${ACTIVITY_SOURCE_NAMES.join(", ")}.`
        );
      const [created] = await tx<{ id: string }[]>`
        INSERT INTO activity_imports (user_id, source, filename, sha256)
        VALUES (${userId}, ${source}, ${batch.import.filename}, ${batch.import.sha256})
        ON CONFLICT (user_id, sha256) DO NOTHING
        RETURNING id`;
      if (created) {
        importId = created.id;
        importSource = source;
      } else {
        // A concurrent or earlier first batch of the same file: join it, under the source it was started with.
        const [existing] = await tx<{ id: string; source: string }[]>`
          SELECT id, source FROM activity_imports WHERE user_id = ${userId} AND sha256 = ${batch.import.sha256}`;
        importId = existing!.id;
        importSource = existing!.source;
      }
    }

    // An import is one source: undoing it or purging that source must never reach another source's events.
    const valid: ValidActivityEvent[] = [];
    const seen = new Set<string>();
    let duplicatesInBatch = 0;
    for (const { index, event } of judged) {
      if (importSource !== null && event.source !== importSource) {
        rejected.push({
          index,
          reason: `source "${event.source}" does not match this import's source "${importSource}". Send one import per source.`
        });
        continue;
      }
      const id = `${event.source}\u0000${event.key}`;
      if (seen.has(id)) {
        duplicatesInBatch += 1;
        continue;
      }
      seen.add(id);
      valid.push(event);
    }
    rejected.sort((x, y) => x.index - y.index);

    const sources = [...new Set(valid.map((event) => event.source))];
    const states =
      sources.length === 0
        ? []
        : await tx<SourceStateRow[]>`
            SELECT source, content_enabled, retention_days FROM activity_source_state
            WHERE user_id = ${userId} AND source IN ${tx(sources)}`;
    const gate = new Map(states.map((row) => [row.source, row.content_enabled]));
    const defaultOn = activityContentDefault();

    // An explicit file import (a batch that names an import) is the owner deliberately loading their own file, so
    // its text is kept whatever the gate says. The gate governs continuous collectors. A source with no state row
    // takes the server default; a saved row wins in both directions.
    const fromImport = importId !== null;
    let contentDropped = 0;
    const rows = valid.map((event) => {
      let content = event.content;
      const open = fromImport || (gate.get(event.source) ?? defaultOn);
      if (content !== null && !open) {
        content = null;
        contentDropped += 1;
      }
      return {
        user_id: userId,
        source: event.source,
        kind: event.kind,
        event_key: event.key,
        device: batch.device ?? null,
        ts_start: event.tsStart,
        ts_end: event.tsEnd,
        tz_offset_min: event.tzOffsetMin,
        approximate: event.approximate,
        attrs: tx.json(event.attrs as never),
        content,
        import_id: importId,
        ingested_via: via
      };
    });

    let added = 0;
    for (let at = 0; at < rows.length; at += INSERT_CHUNK) {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO activity_events ${tx(rows.slice(at, at + INSERT_CHUNK))}
        ON CONFLICT (user_id, source, event_key) DO NOTHING
        RETURNING id`;
      added += inserted.length;
    }
    if (importId !== null && added > 0)
      await tx`UPDATE activity_imports SET event_count = event_count + ${added} WHERE id = ${importId}`;
    return {
      schema: ACTIVITY_SCHEMA_VERSION,
      added,
      alreadyHeld: valid.length - added + duplicatesInBatch,
      contentDropped,
      rejected,
      importId,
      ingestedVia: via
    };
  });
}

/** Whether a file with this sha256 is already held, and the import that holds it. */
export async function findActivityImport(sql: Sql, sha256: string) {
  const userId = await ensureUser(sql);
  const [row] = await sql<
    { id: string; source: string; filename: string; event_count: number; imported_at: Date }[]
  >`SELECT id, source, filename, event_count, imported_at FROM activity_imports WHERE user_id = ${userId} AND sha256 = ${sha256}`;
  if (!row) return { held: false as const };
  return {
    held: true as const,
    importId: row.id,
    source: row.source,
    filename: row.filename,
    eventCount: row.event_count,
    importedAt: row.imported_at.toISOString()
  };
}

async function importsList(sql: Sql, userId: string, limit: number) {
  const rows = await sql<
    { id: string; source: string; filename: string; event_count: number; imported_at: Date }[]
  >`SELECT id, source, filename, event_count, imported_at FROM activity_imports
    WHERE user_id = ${userId} ORDER BY imported_at DESC, id LIMIT ${limit}`;
  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    filename: row.filename,
    eventCount: row.event_count,
    importedAt: row.imported_at.toISOString()
  }));
}

export async function listActivityImports(sql: Sql, limit = 50) {
  return importsList(sql, await ensureUser(sql), limit);
}

/** Counts and the last event per source, with each source's settings, and the most recent imports. */
export async function readActivitySummary(sql: Sql): Promise<ActivitySummary> {
  const userId = await ensureUser(sql);
  const counts = await sql<{ source: string; n: number; last_start: Date | null; last_ingested: Date | null }[]>`
    SELECT source, count(*)::int AS n, max(COALESCE(ts_end, ts_start)) AS last_start, max(ingested_at) AS last_ingested
    FROM activity_events WHERE user_id = ${userId} GROUP BY source`;
  const states = await sql<SourceStateRow[]>`
    SELECT source, content_enabled, retention_days, cursor FROM activity_source_state WHERE user_id = ${userId}`;
  const names = new Set<string>([
    ...ACTIVITY_SOURCE_NAMES,
    ...counts.map((row) => row.source),
    ...states.map((row) => row.source)
  ]);
  const sources = [...names].sort().map((source) => {
    const count = counts.find((row) => row.source === source);
    const state = states.find((row) => row.source === source);
    return {
      source,
      schemaVersion: ACTIVITY_SOURCES[source]?.schemaVersion ?? 0,
      events: count?.n ?? 0,
      lastEventAt: count?.last_start?.toISOString() ?? null,
      lastIngestedAt: count?.last_ingested?.toISOString() ?? null,
      contentEnabled: state?.content_enabled ?? activityContentDefault(),
      retentionDays: state?.retention_days ?? null,
      retentionPurge: state?.retention_days == null ? ("not_set" as const) : ("scheduled" as const),
      // A source with no retention is permanent: a purge record left from an earlier setting would read as a deletion that is no longer scheduled.
      lastPurge: state?.retention_days == null ? null : readLastPurge(state?.cursor)
    };
  });
  const { extractors, derivedBehind } = await extractorSummaries(sql, userId);
  return {
    derivedBehind,
    extractors,
    sources,
    imports: await importsList(sql, userId, 20)
  };
}

const isMark = (value: unknown): value is Mark =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as Mark).at === "string" &&
  typeof (value as Mark).id === "string";

/**
 * Every extractor version the person holds, plus each registered extractor that has not run yet (entirely behind), with
 * how far behind it is. "Behind" is an exact count over the `(user, source, ingested_at)` index: source rows after the
 * forward watermark (live mail, including mail still inside the settle margin) plus rows before the backfill watermark.
 */
async function extractorSummaries(
  sql: Sql,
  userId: string
): Promise<{ extractors: ActivityExtractorSummary[]; derivedBehind: number }> {
  const held = await readExtractorStates(sql, userId);
  const known = new Map(EXTRACTORS.map((extractor) => [`${extractor.name}\u0000${extractor.version}`, extractor]));
  const rows = held.map((state) => ({
    state,
    extractor: known.get(`${state.extractor}\u0000${state.version}`) ?? null
  }));
  for (const extractor of EXTRACTORS)
    if (!held.some((state) => state.extractor === extractor.name && state.version === extractor.version))
      rows.push({
        state: {
          extractor: extractor.name,
          version: extractor.version,
          active: false,
          cursor: {},
          lastOkAt: null,
          lastError: null
        },
        extractor
      });
  const out: ActivityExtractorSummary[] = [];
  let derivedBehind = 0;
  for (const { state, extractor } of rows) {
    let behind: number | null = null;
    if (extractor) {
      const forward = isMark(state.cursor.forward) ? state.cursor.forward : null;
      const backfill = isMark(state.cursor.backfill) ? state.cursor.backfill : null;
      behind =
        (await countRowsAfter(sql, userId, extractor.input, forward)) +
        (backfill === null ? 0 : await countRowsBefore(sql, userId, extractor.input, backfill));
    }
    // Counts toward the layer's lag when it is the active version, or when nothing of that extractor has run at all.
    if (state.active || !held.some((other) => other.extractor === state.extractor)) derivedBehind += behind ?? 0;
    out.push({
      extractor: state.extractor,
      version: state.version,
      active: state.active,
      behind,
      skipped: typeof state.cursor.skipped === "number" ? state.cursor.skipped : 0,
      lastOkAt: state.lastOkAt?.toISOString() ?? null,
      lastError: state.lastError
    });
  }
  return { extractors: out, derivedBehind };
}

/** Said when a retention is set, so it is clear what the setting does and what it leaves. */
export const RETENTION_RUNNING_NOTE =
  "Retention is saved. Expired events of this source are deleted automatically (checked on the worker's regular tick); what Mark derived from them (message classes, facts) is kept.";

function retentionStatus(retentionDays: number | null) {
  return { retentionRuns: retentionDays !== null, note: retentionDays === null ? null : RETENTION_RUNNING_NOTE };
}

/** Sets a source's content gate and/or retention. A field left out keeps its value; `retentionDays: null` means permanent. */
export async function setActivitySourceSettings(sql: PoolSql, source: string, settings: ActivitySourceSettings) {
  if (!isKnownActivitySource(source))
    throw new ActivityInputError(
      `Source "${source}" is not known. Use one of: ${ACTIVITY_SOURCE_NAMES.join(", ")}.`,
      404
    );
  if (typeof settings.retentionDays === "number" && (source === "derived" || source === "derived-shadow"))
    throw new ActivityInputError(
      `Retention is not applied to derived rows, they are kept as history (message classes and facts are what Mark learned from your mail). Set retention on the raw source instead, such as "gmail", and send {"retentionDays": null} to "${source}" to clear any value.`,
      400
    );
  const userId = await ensureUser(sql);
  return sql.begin(async (tx) => {
    const [current] = await tx<SourceStateRow[]>`
      SELECT source, content_enabled, retention_days FROM activity_source_state
      WHERE user_id = ${userId} AND source = ${source} FOR UPDATE`;
    const contentEnabled = settings.contentEnabled ?? current?.content_enabled ?? activityContentDefault();
    const retentionDays =
      settings.retentionDays === undefined ? (current?.retention_days ?? null) : settings.retentionDays;
    await tx`
      INSERT INTO activity_source_state (user_id, source, content_enabled, retention_days)
      VALUES (${userId}, ${source}, ${contentEnabled}, ${retentionDays})
      ON CONFLICT (user_id, source) DO UPDATE
      SET content_enabled = EXCLUDED.content_enabled, retention_days = EXCLUDED.retention_days`;
    return { source, contentEnabled, retentionDays, ...retentionStatus(retentionDays) };
  });
}

interface EventRow {
  id: string;
  source: string;
  kind: string;
  event_key: string;
  device: string | null;
  ts_start: Date;
  ts_end: Date | null;
  tz_offset_min: number | null;
  approximate: boolean;
  attrs: Record<string, unknown>;
  content: string | null;
  import_id: string | null;
  ingested_via: string | null;
  ingested_at: Date;
}

export interface ActivityReadQuery {
  source?: string | undefined;
  kind?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  after?: string | undefined;
  limit?: number | undefined;
  /**
   * Point-in-time read: only rows ingested at or before this instant, and, for rows an extractor wrote, only the
   * version that was active then. An old `asOf` therefore returns the same rows however many runs or promotions follow.
   */
  asOf?: Date | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = (row: { ts_start: Date; id: string }) =>
  Buffer.from(`${row.ts_start.toISOString()}|${row.id}`).toString("base64url");

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const at = new Date(iso ?? "");
  if (!id || !UUID.test(id) || Number.isNaN(at.getTime()))
    throw new ActivityInputError(
      "after is not a cursor this API returned. Use the `next` value of the previous page unchanged."
    );
  return { at, id };
}

/**
 * The extractor versions whose rows reads show: the active ones now, or, for `asOf`, the version each extractor had been
 * promoted to by then (the latest promotion at or before it; the record lives in `extractor_state.cursor.promotions`).
 */
function liveExtractorVersions(sql: Sql, userId: string, asOf: Date | undefined) {
  if (asOf === undefined)
    return sql`SELECT extractor, version FROM extractor_state WHERE user_id = ${userId} AND active`;
  return sql`
    SELECT DISTINCT ON (extractor) extractor, version FROM (
      SELECT es.extractor, es.version, CASE WHEN jsonb_typeof(p.value -> 'at') = 'string' AND (p.value ->> 'at') ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$'
               THEN (p.value ->> 'at')::timestamptz END AS at
      FROM extractor_state es
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(es.cursor -> 'promotions') = 'array' THEN es.cursor -> 'promotions' ELSE '[]'::jsonb END
      ) AS p(value)
      WHERE es.user_id = ${userId}
    ) promotions
    WHERE at <= ${asOf}
    ORDER BY extractor, at DESC, version DESC`;
}

/**
 * A page of events in time order (start, then id), filtered by source, kind and a half-open time range.
 *
 * Rows of source `derived` that an extractor wrote (`msg_class`, `fact`) are shown only for the active version of that
 * extractor (attrs.extractor and attrs.extractor_version), so an extractor with no active version yet, and a row that
 * names no version, return nothing rather than a guess. A person's rows (`fact_status`, `override`, `label`) belong to
 * no extractor version and are always shown. Rows of source `derived-shadow` (a version not yet promoted, kept for the
 * eval comparison) are never shown as output: they come back only when `source` asks for `derived-shadow` by name.
 */
export async function readActivityEvents(sql: Sql, query: ActivityReadQuery): Promise<ActivityEventsPage> {
  const userId = await ensureUser(sql);
  const limit = Math.min(Math.max(query.limit ?? ACTIVITY_READ_DEFAULT_LIMIT, 1), ACTIVITY_READ_MAX_LIMIT);
  const cursor = query.after === undefined ? null : decodeCursor(query.after);
  const rows = await sql<EventRow[]>`
    SELECT id, source, kind, event_key, device, ts_start, ts_end, tz_offset_min, approximate, attrs, content,
           import_id, ingested_via, ingested_at
    FROM activity_events
    WHERE user_id = ${userId}
      ${query.source === undefined ? sql`` : sql`AND source = ${query.source}`}
      ${query.kind === undefined ? sql`` : sql`AND kind = ${query.kind}`}
      ${query.from === undefined ? sql`` : sql`AND ts_start >= ${query.from}`}
      ${query.to === undefined ? sql`` : sql`AND ts_start < ${query.to}`}
      ${query.asOf === undefined ? sql`` : sql`AND ingested_at <= ${query.asOf}`}
      ${query.source === "derived-shadow" ? sql`` : sql`AND source <> 'derived-shadow'`}
      AND (
        source <> 'derived' OR kind NOT IN ${sql(DERIVED_EXTRACTOR_KINDS as unknown as string[])} OR EXISTS (
          SELECT 1 FROM (${liveExtractorVersions(sql, userId, query.asOf)}) live
          WHERE live.extractor = attrs ->> 'extractor' AND live.version = attrs ->> 'extractor_version'
        )
      )
      ${cursor === null ? sql`` : sql`AND (ts_start, id) > (${cursor.at}, ${cursor.id}::uuid)`}
    ORDER BY ts_start, id
    LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const events: ActivityEventRow[] = page.map((row) => ({
    id: row.id,
    source: row.source,
    kind: row.kind,
    key: row.event_key,
    device: row.device,
    start: row.ts_start.toISOString(),
    end: row.ts_end?.toISOString() ?? null,
    tzOffsetMin: row.tz_offset_min,
    approximate: row.approximate,
    attrs: row.attrs,
    content: row.content,
    importId: row.import_id,
    ingestedVia: row.ingested_via,
    ingestedAt: row.ingested_at.toISOString()
  }));
  const last = page.at(-1);
  return { events, next: rows.length > limit && last ? encodeCursor(last) : null };
}

/** Deletes in batches so no single statement holds millions of rows. Returns how many went. */
async function deleteInBatches(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await run();
    total += n;
    if (n < ACTIVITY_PURGE_BATCH) return total;
  }
}

/**
 * Deletes one batch of source rows inside the caller's transaction, after the derived rows read from them (a fact
 * read from several messages goes with the last one). Returns the batch size, not the rows left to delete, so a
 * derived row the helper already removed cannot make the batch loop stop early.
 */
async function removeBatch(tx: TxSql, userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  await deleteDerivedForSources(tx, userId, ids);
  await tx`DELETE FROM activity_events WHERE user_id = ${userId} AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(${tx.json(ids)}))`;
  return ids.length;
}

/** Undoes one import: its events and its record. `deleted` is false when the id is not the person's. */
export async function deleteActivityImport(
  sql: PoolSql,
  importId: string
): Promise<{ deleted: boolean; removed: number }> {
  const userId = await ensureUser(sql);
  const [owned] = await sql<
    { id: string }[]
  >`SELECT id FROM activity_imports WHERE id = ${importId} AND user_id = ${userId}`;
  if (!owned) return { deleted: false, removed: 0 };
  const removed = await deleteInBatches(async () => {
    // One transaction per batch, under the per-person activity lock the derived-rows runner also takes: the derived rows
    // read from these sources go first, while their lineage still exists, and the runner cannot add a link meanwhile.
    return sql.begin(async (tx) => {
      await lockActivityUser(tx, userId);
      const batch = await tx<{ id: string }[]>`
        SELECT id FROM activity_events WHERE import_id = ${importId} AND user_id = ${userId} LIMIT ${ACTIVITY_PURGE_BATCH}`;
      return removeBatch(
        tx,
        userId,
        batch.map((row) => row.id)
      );
    });
  });
  await sql`DELETE FROM activity_imports WHERE id = ${importId} AND user_id = ${userId}`;
  return { deleted: true, removed };
}

/** Deletes every event of one source, and the import records for it (so a file is not still "held" with nothing in it). */
export async function purgeActivitySource(sql: PoolSql, source: string): Promise<{ removed: number }> {
  if (!isKnownActivitySource(source))
    throw new ActivityInputError(
      `Source "${source}" is not known. Use one of: ${ACTIVITY_SOURCE_NAMES.join(", ")}.`,
      404
    );
  const userId = await ensureUser(sql);
  const removed = await deleteInBatches(async () => {
    return sql.begin(async (tx) => {
      await lockActivityUser(tx, userId);
      const batch = await tx<{ id: string }[]>`
        SELECT id FROM activity_events WHERE user_id = ${userId} AND source = ${source} LIMIT ${ACTIVITY_PURGE_BATCH}`;
      return removeBatch(
        tx,
        userId,
        batch.map((row) => row.id)
      );
    });
  });
  await sql`DELETE FROM activity_imports WHERE user_id = ${userId} AND source = ${source}`;
  return { removed };
}

/**
 * The retention purge for every person, outside the derived tick: for every source with `retention_days` set, deletes
 * events whose end (or start, for an instant) is older than that many days, one transaction of at most
 * `ACTIVITY_PURGE_BATCH` rows at a time, under the per-person activity lock. Sources with no setting are kept permanently. Derived
 * rows are never deleted by it (see `activity-retention-store.ts`). Import records are left (the file stays "held";
 * re-importing it would only be purged again). The worker reaches the same code through the derived tick.
 */
export async function purgeExpiredActivity(
  sql: PoolSql,
  now: Date = new Date()
): Promise<{ source: string; removed: number }[]> {
  const people = await sql<{ user_id: string }[]>`
    SELECT DISTINCT user_id FROM activity_source_state
    WHERE retention_days IS NOT NULL AND source NOT IN ('derived', 'derived-shadow')`;
  const totals = new Map<string, number>();
  for (const person of people) {
    for (;;) {
      const pass = await sql.begin(async (tx) => {
        await lockActivityUser(tx, person.user_id);
        return purgeExpiredForUserTx(tx, person.user_id, now, 1);
      });
      for (const item of pass.sources) totals.set(item.source, (totals.get(item.source) ?? 0) + item.removed);
      if (!pass.more) break;
    }
  }
  return [...totals].map(([source, removed]) => ({ source, removed }));
}
