import { tryLockActivityUser } from "@/server/persistence/postgres/activity-lock";
import {
  purgeExpiredForUserTx,
  RETENTION_BATCHES_PER_TICK,
  type RetentionPassResult
} from "@/server/persistence/postgres/activity-retention-store";
import {
  NIL_ID,
  readDerivedFactRows,
  readSourceIdsByKeys,
  readSourceRowsByIds,
  readUserTimeZone,
  scanBackfill,
  scanForward,
  type Mark,
  type SourceRow
} from "@/server/persistence/postgres/derived-scan-store";
import { writeDerivedRowsTx, type DerivedRowInput } from "@/server/persistence/postgres/derived-write-store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { ensureExtractorStateTx, saveExtractorProgressTx } from "@/server/persistence/postgres/extractor-state-store";
import type { PoolSql, TxSql } from "@/server/persistence/postgres/sql-pool";
import type { ExtractorLookups, RowFromKeys } from "./extractor";
import { EXTRACTORS, type Extractor } from "./extractor-registry";

/**
 * The derived-rows runner (communication understanding, slice 2a-2c). One call is one tick: for each extractor it reads
 * a bounded batch of source rows it has not yet read, runs the extractor over each, and writes the derived rows and
 * their lineage in one transaction. It has no off setting and no schedule of its own; the worker posts to the tick
 * route and the route calls this.
 *
 * Why cursors and not "rows with no derived row yet": an extractor may decide a message has nothing to say (the
 * classifier answers `unknown` for mail with no parsed headers and no row is written), so an anti-join would offer the
 * same messages again forever. Instead the extractor's state cursor holds two watermarks over `(ingested_at, id)`:
 *   - forward: rows after the high watermark (live mail), oldest first;
 *   - backfill: rows before the low watermark (history), newest first.
 * Both start one settle margin before the first run, so the whole existing store is backfill and everything arriving later is
 * forward. Forward work always runs before backfill work in a tick, and both are bounded, so a large backlog cannot
 * hold up live mail. The row id breaks ties, so rows sharing an `ingested_at` across a batch boundary are neither
 * skipped nor repeated. The forward scan stops `SETTLE_MS` short of now: `ingested_at` is the start time of the
 * writing transaction, so a slow ingest can commit a row older than one already scanned, and without the margin the
 * forward watermark would pass it for good.
 *
 * Failures are per message: an extractor that throws, attrs it cannot read, or a row the validators refuse. A failed
 * message is retried on later ticks up to `MAX_ATTEMPTS` attempts in all (tracked in `cursor.retries`, at most
 * `RETRY_CAP` entries), then skipped and counted in `cursor.skipped` with the state row's `last_error` saying so. A
 * failure never stops other messages and never writes a `fact_status`: a message that produced no fact has no fact id.
 *
 * The whole tick runs in one transaction under the per-person activity lock (`tryLockActivityUser`), so overlapping
 * ticks cannot double-write (the second answers `busy`), `manual` honours it exactly as `scheduled` does, and a delete
 * of source rows (which waits for the same lock) cannot leave derived rows or lineage behind for rows it removed.
 */

export const FORWARD_BATCH = 500;
export const BACKFILL_BATCH = 500;
export const SETTLE_MS = 60_000;
export const MAX_ATTEMPTS = 3;
export const RETRY_CAP = 100;
const ERROR_MAX_CHARS = 500;

export interface DerivedTickOptions {
  now?: () => Date;
  forwardBatch?: number;
  backfillBatch?: number;
  settleMs?: number;
  extractors?: readonly Extractor[];
  /** Batches of 5000 expired rows the retention pass may delete this tick. */
  retentionBatches?: number;
}

export interface ExtractorTickResult {
  extractor: string;
  version: string;
  /** `inactive`: a version that is not the active one is not run. */
  status: "ok" | "inactive";
  forwardScanned: number;
  backfillScanned: number;
  retried: number;
  written: number;
  alreadyHeld: number;
  /** Messages the extractor had nothing to say about (no row written). */
  unknown: number;
  /** Messages that failed this tick and will be tried again. */
  failed: number;
  /** Messages given up on this tick. */
  skipped: number;
  /** True when a scan filled its batch, so there is probably more to do right away. */
  more: boolean;
}

/** The retention pass of a tick: a no-op (zero rows, no sources) unless a source has `retention_days` set. `error` when the pass failed and was rolled back alone. */
export type RetentionTickResult = RetentionPassResult & { error?: string };

export type DerivedTickResult =
  | { status: "busy" }
  | { status: "ok"; extractors: ExtractorTickResult[]; retention: RetentionTickResult; more: boolean };

interface Retry {
  n: number;
}

/** Why a message was given up on: the extractor threw (including attrs it could not read), or the store refused its row. */
export type SkipCode = "extractor_error" | "row_refused" | "retry_list_full";

export const SKIPPED_IDS_KEPT = 50;

interface Skipped {
  id: string;
  key: string;
  code: string;
  at: string;
}

interface Cursor {
  forward?: Mark;
  backfill?: Mark;
  retries?: Record<string, Retry>;
  skipped?: number;
  skippedIds?: Skipped[];
}

const isMark = (value: unknown): value is Mark =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as Mark).at === "string" &&
  typeof (value as Mark).id === "string";

function readCursor(
  raw: Record<string, unknown>
): Required<Pick<Cursor, "retries" | "skipped" | "skippedIds">> & Cursor {
  const retries: Record<string, Retry> = {};
  if (raw.retries !== null && typeof raw.retries === "object")
    for (const [id, value] of Object.entries(raw.retries as Record<string, unknown>)) {
      const n = (value as Retry | null)?.n;
      if (typeof n === "number" && Number.isFinite(n)) retries[id] = { n };
    }
  return {
    ...(isMark(raw.forward) ? { forward: raw.forward } : {}),
    ...(isMark(raw.backfill) ? { backfill: raw.backfill } : {}),
    retries,
    skipped: typeof raw.skipped === "number" ? raw.skipped : 0,
    skippedIds: Array.isArray(raw.skippedIds)
      ? (raw.skippedIds as unknown[]).filter(
          (item): item is Skipped =>
            item !== null && typeof item === "object" && typeof (item as Skipped).id === "string"
        )
      : []
  };
}

interface Failure {
  message: SourceRow;
  reason: string;
  code: SkipCode;
}

interface BatchOutcome {
  written: number;
  alreadyHeld: number;
  unknown: number;
  failures: Failure[];
}

const fromKeysOf = (item: unknown): RowFromKeys | null =>
  item !== null &&
  typeof item === "object" &&
  "event" in item &&
  "fromKeys" in item &&
  Array.isArray((item as RowFromKeys).fromKeys)
    ? (item as RowFromKeys)
    : null;

/** Extracts and writes one batch. Per-message problems are returned, not thrown; a database error does throw. */
async function processBatch(
  tx: TxSql,
  userId: string,
  extractor: Extractor,
  messages: readonly SourceRow[],
  now: Date
): Promise<BatchOutcome> {
  const failures: Failure[] = [];
  const rows: DerivedRowInput[] = [];
  const owner: SourceRow[] = [];
  let unknown = 0;
  // Each lookup is read on first use. `factRows` also shows the rows this batch has made but not written yet.
  let zone: Promise<string> | null = null;
  const lookups: ExtractorLookups = {
    timeZone: () => (zone ??= readUserTimeZone(tx, userId)),
    factRows: async (factId) => [
      ...rows
        .map((row) => (row.event as { kind?: unknown; start?: string; attrs?: Record<string, unknown> }) ?? {})
        .filter((event) => event.kind === "fact" && event.attrs?.fact_id === factId)
        .map((event) => ({ attrs: event.attrs as Record<string, unknown>, start: String(event.start) }))
        .reverse(),
      ...(await readDerivedFactRows(tx, userId, factId))
    ]
  };
  const ordered = extractor.oldestFirst
    ? [...messages].sort((a, b) => a.tsStart.getTime() - b.tsStart.getTime() || (a.id < b.id ? -1 : 1))
    : messages;
  for (const message of ordered) {
    try {
      const made = await extractor.extract(
        { id: message.id, key: message.key, tsStart: message.tsStart, attrs: message.attrs },
        now,
        lookups
      );
      if (made.length === 0) unknown += 1;
      for (const item of made) {
        const from = fromKeysOf(item);
        if (from === null) {
          rows.push({ event: item, sourceIds: [message.id] });
          owner.push(message);
          continue;
        }
        // A row for other messages: lineage follows them, and one whose message is gone is not written.
        const held = await readSourceIdsByKeys(tx, userId, extractor.input, from.fromKeys);
        const ids = from.fromKeys.map((key) => held.get(key));
        if (ids.some((id) => id === undefined)) continue;
        rows.push({ event: from.event, sourceIds: ids as string[] });
        owner.push(message);
      }
    } catch (error) {
      failures.push({
        message,
        reason: error instanceof Error ? error.message : "The extractor failed.",
        code: "extractor_error"
      });
    }
  }
  let written = 0;
  let alreadyHeld = 0;
  if (rows.length > 0) {
    const results = await writeDerivedRowsTx(tx, userId, rows, extractor.via, now);
    results.forEach((result, index) => {
      if (!result.ok) failures.push({ message: owner[index]!, reason: result.reason, code: "row_refused" });
      else if (result.added) written += 1;
      else alreadyHeld += 1;
    });
  }
  // One failure per message, however many of its rows were refused, so a message uses one attempt per tick.
  const seen = new Set<string>();
  const once = failures.filter((failure) =>
    seen.has(failure.message.id) ? false : (seen.add(failure.message.id), true)
  );
  return { written, alreadyHeld, unknown, failures: once };
}

async function runExtractor(
  tx: TxSql,
  userId: string,
  extractor: Extractor,
  now: Date,
  options: Required<Omit<DerivedTickOptions, "now" | "extractors" | "retentionBatches">>
): Promise<ExtractorTickResult> {
  const result: ExtractorTickResult = {
    extractor: extractor.name,
    version: extractor.version,
    status: "ok",
    forwardScanned: 0,
    backfillScanned: 0,
    retried: 0,
    written: 0,
    alreadyHeld: 0,
    unknown: 0,
    failed: 0,
    skipped: 0,
    more: false
  };
  const state = await ensureExtractorStateTx(tx, userId, extractor.name, extractor.version, now);
  if (!state.active) return { ...result, status: "inactive" };

  const cursor = readCursor(state.cursor);
  // Both marks start `settleMs` before now, not at now: a slow ingest that began just before the first run has an
  // `ingested_at` inside that window and may commit after the first scan. Forward covers it once it has settled.
  const start: Mark = { at: new Date(now.getTime() - options.settleMs).toISOString(), id: NIL_ID };
  const forward = cursor.forward ?? start;
  let backfill = cursor.backfill ?? start;
  let forwardMark = forward;
  const retries = { ...cursor.retries };
  let skipped = cursor.skipped;
  let skippedIds = [...cursor.skippedIds];
  const problems: string[] = [];

  const absorb = (outcome: BatchOutcome) => {
    result.written += outcome.written;
    result.alreadyHeld += outcome.alreadyHeld;
    result.unknown += outcome.unknown;
  };
  const fail = (failure: Failure) => {
    const attempts = (retries[failure.message.id]?.n ?? 0) + 1;
    problems.push(`${failure.message.key}: ${failure.reason}`);
    const room = failure.message.id in retries || Object.keys(retries).length < RETRY_CAP;
    if (attempts >= MAX_ATTEMPTS || !room) {
      delete retries[failure.message.id];
      skippedIds = [
        ...skippedIds,
        {
          id: failure.message.id,
          key: failure.message.key,
          code: room ? failure.code : "retry_list_full",
          at: now.toISOString()
        }
      ].slice(-SKIPPED_IDS_KEPT);
      skipped += 1;
      result.skipped += 1;
    } else {
      retries[failure.message.id] = { n: attempts };
      result.failed += 1;
    }
  };

  // 1. Messages that failed on an earlier tick get their next attempt. A message deleted since is forgotten.
  const waiting = Object.keys(retries);
  if (waiting.length > 0) {
    const held = await readSourceRowsByIds(tx, userId, extractor.input, waiting);
    const heldIds = new Set(held.map((row) => row.id));
    for (const id of waiting) if (!heldIds.has(id)) delete retries[id];
    result.retried = held.length;
    const outcome = await processBatch(tx, userId, extractor, held, now);
    absorb(outcome);
    const failedIds = new Set(outcome.failures.map((failure) => failure.message.id));
    for (const row of held) if (!failedIds.has(row.id)) delete retries[row.id];
    outcome.failures.forEach(fail);
  }

  // 2. Live mail first: rows after the high watermark, that have settled.
  const live = await scanForward(
    tx,
    userId,
    extractor.input,
    forward,
    new Date(now.getTime() - options.settleMs),
    options.forwardBatch
  );
  result.forwardScanned = live.length;
  if (live.length > 0) {
    const outcome = await processBatch(tx, userId, extractor, live, now);
    absorb(outcome);
    outcome.failures.forEach(fail);
    forwardMark = live[live.length - 1]!.mark;
  }
  if (live.length === options.forwardBatch) result.more = true;

  // 3. Then history, newest first. The scan is a cheap index probe when nothing is left, so it is not switched off
  // once it comes up empty: a row committed late by a long ingest can still sit below the watermark.
  const history = await scanBackfill(tx, userId, extractor.input, backfill, options.backfillBatch);
  result.backfillScanned = history.length;
  if (history.length > 0) {
    const outcome = await processBatch(tx, userId, extractor, history, now);
    absorb(outcome);
    outcome.failures.forEach(fail);
    backfill = history[history.length - 1]!.mark;
  }
  if (history.length === options.backfillBatch) result.more = true;

  const lastError =
    problems.length === 0
      ? null
      : `${problems.length} message(s) failed to classify this run, first: ${problems[0]}`.slice(0, ERROR_MAX_CHARS);
  await saveExtractorProgressTx(tx, userId, extractor.name, extractor.version, {
    cursor: { forward: forwardMark, backfill, retries, skipped, skippedIds },
    lastOkAt: now,
    lastError
  });
  return result;
}

/**
 * The retention pass, after the extractors and under the same lock. It runs in a savepoint so a failure undoes only the
 * pass (never the extractors' work) and is reported, not thrown. Strictly a no-op when no source has a retention set.
 */
async function runRetention(tx: TxSql, userId: string, now: Date, maxBatches: number): Promise<RetentionTickResult> {
  try {
    return await tx.savepoint((sp) => purgeExpiredForUserTx(sp, userId, now, maxBatches));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The retention pass failed.";
    return { removed: 0, sources: [], more: false, error: message.slice(0, ERROR_MAX_CHARS) };
  }
}

/**
 * Runs one tick for the person. Answers `busy`, doing nothing, when another tick (or a delete of source rows) holds the
 * activity lock. An unexpected database error rolls the whole tick back, so the cursor never moves past rows that were
 * not written, and is thrown for the route to report.
 */
export async function runDerivedTick(sql: PoolSql, options: DerivedTickOptions = {}): Promise<DerivedTickResult> {
  const now = (options.now ?? (() => new Date()))();
  const userId = await ensureUser(sql);
  const settings = {
    forwardBatch: options.forwardBatch ?? FORWARD_BATCH,
    backfillBatch: options.backfillBatch ?? BACKFILL_BATCH,
    settleMs: options.settleMs ?? SETTLE_MS
  };
  return sql.begin(async (tx): Promise<DerivedTickResult> => {
    if (!(await tryLockActivityUser(tx, userId))) return { status: "busy" };
    const extractors: ExtractorTickResult[] = [];
    for (const extractor of options.extractors ?? EXTRACTORS)
      extractors.push(await runExtractor(tx, userId, extractor, now, settings));
    const retention = await runRetention(tx, userId, now, options.retentionBatches ?? RETENTION_BATCHES_PER_TICK);
    return { status: "ok", extractors, retention, more: extractors.some((item) => item.more) || retention.more };
  });
}
