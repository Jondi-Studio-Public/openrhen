import { tryLockActivityUser } from "@/server/persistence/postgres/activity-lock";
import {
  NIL_ID,
  readSourceRowsByIds,
  scanBackfill,
  scanForward,
  type Mark,
  type SourceRow
} from "@/server/persistence/postgres/derived-scan-store";
import { writeDerivedRowsTx, type DerivedRowInput } from "@/server/persistence/postgres/derived-write-store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { ensureExtractorStateTx, saveExtractorProgressTx } from "@/server/persistence/postgres/extractor-state-store";
import type { PoolSql, TxSql } from "@/server/persistence/postgres/sql-pool";
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
 * Both start at the time of the first run, so the whole existing store is backfill and everything arriving later is
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

export type DerivedTickResult = { status: "busy" } | { status: "ok"; extractors: ExtractorTickResult[]; more: boolean };

interface Retry {
  n: number;
}

interface Cursor {
  forward?: Mark;
  backfill?: Mark;
  retries?: Record<string, Retry>;
  skipped?: number;
}

const isMark = (value: unknown): value is Mark =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as Mark).at === "string" &&
  typeof (value as Mark).id === "string";

function readCursor(raw: Record<string, unknown>): Required<Pick<Cursor, "retries" | "skipped">> & Cursor {
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
    skipped: typeof raw.skipped === "number" ? raw.skipped : 0
  };
}

interface Failure {
  message: SourceRow;
  reason: string;
}

interface BatchOutcome {
  written: number;
  alreadyHeld: number;
  unknown: number;
  failures: Failure[];
}

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
  for (const message of messages) {
    try {
      const made = await extractor.extract(
        { id: message.id, key: message.key, tsStart: message.tsStart, attrs: message.attrs },
        now
      );
      if (made.length === 0) unknown += 1;
      for (const event of made) {
        rows.push({ event, sourceIds: [message.id] });
        owner.push(message);
      }
    } catch (error) {
      failures.push({ message, reason: error instanceof Error ? error.message : "The extractor failed." });
    }
  }
  let written = 0;
  let alreadyHeld = 0;
  if (rows.length > 0) {
    const results = await writeDerivedRowsTx(tx, userId, rows, extractor.via, now);
    results.forEach((result, index) => {
      if (!result.ok) failures.push({ message: owner[index]!, reason: result.reason });
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
  options: Required<Omit<DerivedTickOptions, "now" | "extractors">>
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
  const start: Mark = { at: now.toISOString(), id: NIL_ID };
  const forward = cursor.forward ?? start;
  let backfill = cursor.backfill ?? start;
  let forwardMark = forward;
  const retries = { ...cursor.retries };
  let skipped = cursor.skipped;
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
    cursor: { forward: forwardMark, backfill, retries, skipped },
    lastOkAt: now,
    lastError
  });
  return result;
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
    return { status: "ok", extractors, more: extractors.some((item) => item.more) };
  });
}
