import { createHash, randomUUID } from "node:crypto";
import { MODEL_PROVIDERS } from "@openrhen/contracts";
import { createModelTransport } from "@/integrations/models/model-proxy-client";
import { lockActivityUser, tryLockActivityUser } from "@/server/persistence/postgres/activity-lock";
import {
  countModelBackfillBefore,
  countModelForward,
  countModelRowsByKeys,
  readContentGate,
  readContentHashes,
  readLabelledMessageKeys,
  readModelRowsByIds,
  readModelRowsByKeys,
  readThreadContext,
  scanModelBackfill,
  scanModelForward,
  type ModelSourceRow
} from "@/server/persistence/postgres/derived-model-scan-store";
import { hostedUsageLast24Hours, recordModelCall } from "@/server/persistence/postgres/derived-model-calls-store";
import { writeDerivedRowsTx, writeShadowRowsTx } from "@/server/persistence/postgres/derived-write-store";
import { readDerivedSettings } from "@/server/persistence/postgres/derived-settings-store";
import { NIL_ID, type Mark } from "@/server/persistence/postgres/derived-scan-store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import {
  ensureExtractorStateTx,
  readExtractorStateTx,
  renewExtractorLease,
  saveExtractorProgressTx
} from "@/server/persistence/postgres/extractor-state-store";
import type { PoolSql, TxSql } from "@/server/persistence/postgres/sql-pool";
import {
  callModel,
  processPolicyState,
  type HostedEligibilityChecker,
  type ModelTransport,
  type PolicyDeps,
  type PolicyState
} from "./call-policy";
import type { DerivedSettings } from "./derived-settings";
import { RETRY_CAP, SETTLE_MS, SKIPPED_IDS_KEPT } from "./derived-runner";
import type {
  ModelContextMessage,
  ModelExtractContext,
  ModelExtractor,
  ModelExtractResult,
  ModelFailureOutcome,
  PinnedModels
} from "./model-extractor";
import { MODEL_EXTRACTORS } from "./model-extractor-registry";

/**
 * The model tick (communication understanding, slice 2b-4): the runner for extractors that call a language model. It
 * is a separate route and worker loop from the T0 tick (`derived-runner.ts`, which is untouched) because a model call
 * takes seconds to minutes and the T0 tick is one transaction that the worker aborts at 120 s. One call to
 * `runModelTick` is one run of every registered model extractor, in three phases:
 *
 * (a) Under the per-person activity lock, in one short transaction: take a LEASE (a random token written into the
 *     extractor's cursor, valid 10 minutes), and read a batch of at most 20 messages with their text and up to 3 earlier
 *     messages of the thread as context. The lock is released at commit.
 * (b) With no transaction and no lock, call the model through the one call policy (`call-policy.ts`), one message at a
 *     time, under a 5 minute wall-clock budget (half the lease). Nothing is written here.
 * (c) Under the lock again, in one transaction: check the lease token is still the one this run wrote (if it changed,
 *     another run owns the batch and EVERYTHING this run made is discarded), re-read which source messages still exist
 *     with the text that was read (a message deleted, or deleted and ingested again, during (b) has its output
 *     discarded), write each row inside its own savepoint, advance the cursor over what was done, and release the lease.
 *
 * Why a token and not just the lock: the lock is not held across (b), so a slow run's lease can expire and a second
 * run can take the same batch. Event keys are built from the sentence, so two runs' rows could still differ in their
 * quote; the token makes the loser write nothing.
 *
 * What a failure costs (plan finding 6):
 *   - Host-level failures (refused, DNS, unreachable, a hosted key or rate limit) are an OUTAGE: the run stops at that
 *     message, the message keeps its place, no attempt is counted, and a circuit opens with a growing back-off
 *     (1, 2, 5, 15 minutes, 15 thereafter) during which no call is made at all.
 *   - A timeout (after the local model was warmed in this run), bad output the repair retry could not fix, or a
 *     throw uses the message's budget of `MODEL_MESSAGE_BUDGET` (6) within 24 hours. Past it the message is skipped
 *     with a code (`model_timeout`, `bad_output`, `extractor_error`, `row_refused`) and kept in `cursor.skippedIds`.
 *
 * Pinned models (amendment 7): the first run of a version writes the local and hosted model ids from the settings into
 * `cursor.models`, and the version runs with those whatever the settings say later. The local model's digest is read with a
 * tiny call at the start of every run that has work, recorded in each model-tier fact's `attrs.model` and compared with
 * the pinned digest; a different digest is `model_changed` and the run reads nothing.
 *
 * Shadow runs (amendment 8): a version that is not active reads the person's labelled messages (his own `label` rows,
 * not yet in its done list) and live mail going forward, writes `derived-shadow` rows, and lists each message it
 * reached in `cursor.shadow.done` (event keys, flat, the shape the eval report reads). It does not backfill.
 *
 * The cursor merge in `saveExtractorProgressTx` is shallow, so releasing the lease writes `lease: null`, a JSON null
 * that `readLease` accepts.
 */

export const MODEL_BATCH = 20;
export const MODEL_BUDGET_MS = 5 * 60_000;
/**
 * The lease outlives the longest single message (the opening call's backoffs plus three 200 s local attempts and a
 * repair retry is about 11 minutes), and a run renews it before every message, so it never expires under a live run.
 */
export const LEASE_MS = 15 * 60_000;
/** How long a failed message waits before its next try, by how many tries it has used. */
export const RETRY_COOLDOWN_MS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000] as const;
/** This many timeouts in a row in one run are read as the model being unavailable, not as bad messages. */
export const CONSECUTIVE_TIMEOUT_OUTAGE = 3;
/** Permanent no-text skips kept in `cursor.skippedIds` beyond the 50 ordinary ones, so the eval report never counts them as read. */
export const NO_CONTENT_KEPT = 1_000;
const BEHIND_TIMEOUT = "5s";
export const MODEL_MESSAGE_BUDGET = 6;
export const MODEL_BUDGET_WINDOW_MS = 24 * 3_600_000;
export const CIRCUIT_BACKOFF_MS = [60_000, 120_000, 300_000, 900_000] as const;
/** Labelled messages kept in `cursor.shadow.done` (they are never trimmed: trimming would make the run read them again). */
export const SHADOW_EVAL_KEPT = 5_000;
/** Live messages kept in `cursor.shadow.done`: the newest. */
export const SHADOW_LIVE_KEPT = 2_000;
const ERROR_MAX_CHARS = 500;
const PROBE = [{ role: "user" as const, content: "Reply with the single word OK." }];

export const DENY_HOSTED: HostedEligibilityChecker = async () => ({
  eligible: false,
  reason:
    "no hosted-eligibility rule is installed in this build (the rule from the mail-understanding plan is wired in with the fact extractor, slice 2b-6), so nothing is sent to the hosted model"
});

export interface ModelTickOptions {
  now?: () => Date;
  /** Milliseconds, for the phase (b) budget. Injectable so a test can spend it without waiting. */
  clock?: () => number;
  budgetMs?: number;
  batch?: number;
  extractors?: readonly ModelExtractor[];
  transport?: ModelTransport;
  /** The hosted-eligibility rule. Absent means nothing is ever sent to the hosted tier. */
  isHostedEligible?: HostedEligibilityChecker;
  sleep?: (ms: number) => Promise<void>;
  policyState?: PolicyState;
  newToken?: () => string;
}

export type ModelExtractorStatus =
  | "ok"
  | "not_configured"
  | "no_content"
  | "circuit_open"
  | "leased"
  | "model_changed"
  | "outage"
  | "lease_lost"
  | "busy";

export interface ModelExtractorResult {
  extractor: string;
  version: string;
  mode: "active" | "shadow" | null;
  status: ModelExtractorStatus;
  /** One plain-English paragraph that names the exact next call, whatever happened. */
  message: string;
  read: number;
  written: number;
  alreadyHeld: number;
  /** Messages whose output was dropped because the source was deleted or changed, or the lease was lost. */
  discarded: number;
  retried: number;
  failed: number;
  skipped: number;
  noContent: number;
  /** Messages still to read (live mail after the forward mark, history inside the horizon, or labelled messages for a shadow run). */
  behind: number | null;
  more: boolean;
}

export type ModelTickResult =
  | { status: "busy" }
  | { status: "no_extractors"; more: false; extractors: []; summary: string }
  | { status: "ok"; more: boolean; extractors: ModelExtractorResult[]; summary: string };

interface Lease {
  token: string;
  startedAt: string;
  expiresAt: string;
}
interface Retry {
  n: number;
  since: string;
  code: string;
  /** Not tried again before this time. */
  notBefore?: string;
}
interface Skipped {
  id: string;
  key: string;
  code: string;
  at: string;
}
interface Circuit {
  fails: number;
  openUntil: string;
  message: string;
}

interface ModelCursor {
  forward?: Mark;
  backfill?: Mark;
  retries: Record<string, Retry>;
  skipped: number;
  skippedIds: Skipped[];
  lease: Lease | null;
  circuit: Circuit | null;
  models: PinnedModels | null;
  shadow: { done: string[]; evalCount: number };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isMark = (value: unknown): value is Mark =>
  isRecord(value) && typeof value.at === "string" && typeof value.id === "string";

/** A lease the cursor holds, or null: absent, JSON null, malformed and expired-looking-but-unparseable all read as no lease. */
function readLease(raw: unknown): Lease | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.token !== "string" || typeof raw.expiresAt !== "string" || typeof raw.startedAt !== "string")
    return null;
  return { token: raw.token, startedAt: raw.startedAt, expiresAt: raw.expiresAt };
}

function readPinned(raw: unknown): PinnedModels | null {
  if (!isRecord(raw)) return null;
  const t2 = isRecord(raw.t2) && typeof raw.t2.id === "string" ? raw.t2 : null;
  const t3 = isRecord(raw.t3) && typeof raw.t3.id === "string" ? raw.t3 : null;
  return {
    t2: t2 ? { id: t2.id as string, digest: typeof t2.digest === "string" ? t2.digest : null } : null,
    t3: t3 ? { id: t3.id as string } : null
  };
}

export function readModelCursor(raw: Record<string, unknown>): ModelCursor {
  const retries: Record<string, Retry> = {};
  if (isRecord(raw.retries))
    for (const [id, value] of Object.entries(raw.retries)) {
      if (!isRecord(value) || typeof value.n !== "number" || !Number.isFinite(value.n)) continue;
      retries[id] = {
        n: value.n,
        since: typeof value.since === "string" ? value.since : new Date(0).toISOString(),
        code: typeof value.code === "string" ? value.code : "extractor_error",
        ...(typeof value.notBefore === "string" ? { notBefore: value.notBefore } : {})
      };
    }
  const circuit =
    isRecord(raw.circuit) && typeof raw.circuit.openUntil === "string" && typeof raw.circuit.fails === "number"
      ? {
          fails: raw.circuit.fails,
          openUntil: raw.circuit.openUntil,
          message: typeof raw.circuit.message === "string" ? raw.circuit.message : ""
        }
      : null;
  const shadow = isRecord(raw.shadow) ? raw.shadow : {};
  const done = Array.isArray(shadow.done) ? shadow.done.filter((item): item is string => typeof item === "string") : [];
  return {
    ...(isMark(raw.forward) ? { forward: raw.forward } : {}),
    ...(isMark(raw.backfill) ? { backfill: raw.backfill } : {}),
    retries,
    skipped: typeof raw.skipped === "number" ? raw.skipped : 0,
    skippedIds: Array.isArray(raw.skippedIds)
      ? raw.skippedIds.filter((item): item is Skipped => isRecord(item) && typeof item.id === "string")
      : [],
    lease: readLease(raw.lease),
    circuit,
    models: readPinned(raw.models),
    shadow: {
      done,
      evalCount:
        typeof shadow.evalCount === "number" && shadow.evalCount >= 0 ? Math.min(shadow.evalCount, done.length) : 0
    }
  };
}

/**
 * The flat list `cursor.shadow.done` holds (the shape the eval report reads): the labelled messages first and never
 * trimmed beyond `SHADOW_EVAL_KEPT` (the newest kept), then the live ones, of which only the newest `SHADOW_LIVE_KEPT`
 * stay. So the list is at most `SHADOW_EVAL_KEPT + SHADOW_LIVE_KEPT` event keys.
 */
export function shadowDone(parts: { eval: readonly string[]; live: readonly string[] }): string[] {
  return [...parts.eval.slice(-SHADOW_EVAL_KEPT), ...parts.live.slice(-SHADOW_LIVE_KEPT)];
}

/**
 * `cursor.skippedIds` keeps the newest 50 ordinary skips. Permanent no-text skips are kept apart (up to
 * `NO_CONTENT_KEPT`) in the same array, so a long run of text-less mail cannot push them out and let the eval report
 * (which reads this array) count those messages as read. The array shape is unchanged.
 */
export function trimSkipped<T extends { code: string }>(list: readonly T[]): T[] {
  return [
    ...list.filter((e) => e.code !== "no_content").slice(-SKIPPED_IDS_KEPT),
    ...list.filter((e) => e.code === "no_content").slice(-NO_CONTENT_KEPT)
  ];
}

const REDACT_WINDOW = 8;
/**
 * Rule: nothing the model tick stores (`last_error`, retry codes, the cursor) or returns (result messages) carries mail
 * text. Any run of 8 or more characters of a message that also occurs in the message being read, or in its thread
 * context, is replaced by a marker. A validator's verdict or a provider's sentence that quotes the mail is therefore cut
 * down to its own words. It over-redacts (an ordinary 8-character phrase shared with the mail goes too) on purpose.
 */
export function redactMailText(text: string, sources: readonly string[]): string {
  const hay = sources
    .filter((x) => x !== "")
    .join("\u0000")
    .toLowerCase();
  if (hay === "" || text.length < REDACT_WINDOW) return text;
  const low = text.toLowerCase();
  const covered = Array.from({ length: text.length }, () => false);
  for (let i = 0; i + REDACT_WINDOW <= text.length; i++)
    if (hay.includes(low.slice(i, i + REDACT_WINDOW))) for (let j = i; j < i + REDACT_WINDOW; j++) covered[j] = true;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (!covered[i]) out += text[i];
    else if (i === 0 || !covered[i - 1]) out += "[mail text removed]";
  }
  return out;
}

export type FailureClass =
  { kind: "outage" } | { kind: "budget"; code: "model_timeout" | "bad_output" | "extractor_error" };

/** What a failed read costs. Host-level failures cost nothing; the rest use the message's budget. */
export function classifyFailure(outcome: ModelFailureOutcome | "error"): FailureClass {
  switch (outcome) {
    case "unreachable":
    case "rate_limited":
    case "bad_key":
      return { kind: "outage" };
    case "timeout":
      return { kind: "budget", code: "model_timeout" };
    case "bad_output":
      return { kind: "budget", code: "bad_output" };
    default:
      return { kind: "budget", code: "extractor_error" };
  }
}

export const circuitBackoffMs = (fails: number): number =>
  CIRCUIT_BACKOFF_MS[Math.min(Math.max(fails, 1), CIRCUIT_BACKOFF_MS.length) - 1]!;

const md5 = (text: string) => createHash("md5").update(text, "utf8").digest("hex");
const clip = (text: string) => text.slice(0, ERROR_MAX_CHARS);
const minutes = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} minute(s)` : `${Math.round(ms / 1000)} second(s)`;

type Lane = "retry" | "forward" | "backfill" | "eval";
interface Item {
  message: ModelSourceRow;
  lane: Lane;
  /** The message's text and its context's, kept only to redact them from anything reported. */
  texts: string[];
}

interface Plan {
  token: string;
  mode: "active" | "shadow";
  pinned: PinnedModels;
  items: Item[];
  labelled: Set<string>;
  settingsDiffer: boolean;
}

type Executed =
  | { item: Item; kind: "rows"; rows: unknown[] }
  | {
      item: Item;
      kind: "failed";
      code: "model_timeout" | "bad_output" | "extractor_error" | "model_unreachable";
      message: string;
    }
  | { item: Item; kind: "no_content" };

const empty = (extractor: ModelExtractor, over: Partial<ModelExtractorResult>): ModelExtractorResult => ({
  extractor: extractor.name,
  version: extractor.version,
  mode: null,
  status: "ok",
  message: "",
  read: 0,
  written: 0,
  alreadyHeld: 0,
  discarded: 0,
  retried: 0,
  failed: 0,
  skipped: 0,
  noContent: 0,
  behind: null,
  more: false,
  ...over
});

const NO_CONTENT_FIX = (source: string) => `PUT /api/activity-sources/${source} {"contentEnabled": true}`;

/** Phase (a). Returns a finished result when there is nothing to do or the run must not go on, else the plan. */
async function begin(
  sql: PoolSql,
  userId: string,
  extractor: ModelExtractor,
  settings: DerivedSettings,
  now: Date,
  batch: number,
  newToken: () => string
): Promise<{ done: ModelExtractorResult; idle?: BehindArgs } | { plan: Plan }> {
  return sql.begin(async (tx) => {
    if (!(await tryLockActivityUser(tx, userId)))
      return {
        done: empty(extractor, {
          status: "busy",
          message:
            "Another tick or a delete of source rows holds the activity lock for a moment. Nothing was done and nothing was lost; the worker calls POST /api/integrations/derived/model-tick again in seconds."
        })
      };
    if ((await readExtractorStateTx(tx, userId, extractor.name, extractor.version)) === null) {
      const missing = extractor.notConfigured(settings);
      if (missing !== null)
        return {
          done: empty(extractor, {
            status: "not_configured",
            message: `Not configured, so no version was created: ${missing}`
          })
        };
    }
    const state = await ensureExtractorStateTx(tx, userId, extractor.name, extractor.version, now);
    const cursor = readModelCursor(state.cursor);
    const mode = state.active ? "active" : "shadow";
    const patch: Record<string, unknown> = {};

    // The marks start one settle margin back, as for the T0 tick; a shadow version never reads history.
    const start: Mark = { at: new Date(now.getTime() - SETTLE_MS).toISOString(), id: NIL_ID };
    const forward = cursor.forward ?? start;
    if (cursor.forward === undefined) patch.forward = forward;
    let backfill = cursor.backfill;
    if (mode === "active" && backfill === undefined) {
      backfill = start;
      patch.backfill = backfill;
    }
    const pinned = cursor.models ?? {
      t2: settings.t2Model ? { id: settings.t2Model, digest: null } : null,
      t3: settings.t3Model ? { id: settings.t3Model } : null
    };
    if (cursor.models === null) patch.models = pinned;
    const settingsDiffer =
      (settings.t2Model ?? null) !== (pinned.t2?.id ?? null) || (settings.t3Model ?? null) !== (pinned.t3?.id ?? null);

    const finish = async (result: ModelExtractorResult, lastError?: string | null) => {
      if (Object.keys(patch).length > 0 || lastError !== undefined)
        await saveExtractorProgressTx(tx, userId, extractor.name, extractor.version, {
          cursor: patch,
          ...(lastError === undefined ? {} : { lastError })
        });
      return { done: { ...result, mode } as ModelExtractorResult };
    };

    if (cursor.circuit && new Date(cursor.circuit.openUntil).getTime() > now.getTime())
      return finish(
        empty(extractor, {
          status: "circuit_open",
          message: `The model could not be reached on the last run (${cursor.circuit.message}), so calls are paused until ${cursor.circuit.openUntil} (${cursor.circuit.fails} failed run(s) in a row; the pause grows 1, 2, 5, then 15 minutes). Nothing was lost and no message used any of its retry budget. To check now, send POST /api/derived-settings/test {"tier":"t2"} from the owner session; otherwise the worker tries again by itself at that time.`
        })
      );

    const lease = cursor.lease;
    if (lease && new Date(lease.expiresAt).getTime() > now.getTime())
      return finish(
        empty(extractor, {
          status: "leased",
          message: `Another run of this version holds the lease (started ${lease.startedAt}, expires ${lease.expiresAt}), so this call did nothing. That is normal while a run is calling the model. If it is still the same after ${lease.expiresAt}, the next call to POST /api/integrations/derived/model-tick takes the lease over by itself.`
        })
      );

    // Read the batch: messages that failed before, then live mail, then (active only) history inside the horizon.
    // A shadow run reads the person's labelled messages first, then live mail.
    const input = extractor.input;
    const items: Item[] = [];
    const seen = new Set<string>();
    const add = (rows: ModelSourceRow[], lane: Lane) => {
      for (const row of rows) {
        if (seen.has(row.id) || items.length >= batch) continue;
        seen.add(row.id);
        items.push({ message: row, lane, texts: [row.content ?? ""] });
      }
    };
    const retryIds = Object.keys(cursor.retries);
    if (retryIds.length > 0) {
      const held = await readModelRowsByIds(tx, userId, input, retryIds);
      const heldIds = new Set(held.map((row) => row.id));
      const gone = retryIds.filter((id) => !heldIds.has(id));
      if (gone.length > 0) {
        const kept = { ...cursor.retries };
        for (const id of gone) delete kept[id];
        cursor.retries = kept;
        patch.retries = kept;
      }
      const due = held.filter((row) => {
        const wait = cursor.retries[row.id]?.notBefore;
        return wait === undefined || new Date(wait).getTime() <= now.getTime();
      });
      add(due.slice(0, batch), "retry");
    }
    const labelled = new Set<string>();
    let pendingEval: string[] = [];
    if (mode === "shadow") {
      for (const key of await readLabelledMessageKeys(tx, userId, SHADOW_EVAL_KEPT)) labelled.add(key);
      const doneSet = new Set(cursor.shadow.done);
      const unread = new Set<string>(cursor.skippedIds.map((item) => item.key));
      pendingEval = [...labelled].filter((key) => !doneSet.has(key) && !unread.has(key));
      add(await readModelRowsByKeys(tx, userId, input, pendingEval, batch - items.length), "eval");
    }
    add(
      await scanModelForward(
        tx,
        userId,
        input,
        forward,
        new Date(now.getTime() - SETTLE_MS),
        batch - items.length,
        mode === "shadow" ? cursor.shadow.done : []
      ),
      "forward"
    );
    if (mode === "active" && backfill !== undefined)
      add(
        await scanModelBackfill(
          tx,
          userId,
          input,
          backfill,
          new Date(now.getTime() - settings.backfillDays * 86_400_000),
          batch - items.length
        ),
        "backfill"
      );

    if (items.length === 0) {
      // An expired circuit with nothing to read is over: the next outage starts again at the shortest pause.
      if (cursor.circuit) patch.circuit = null;
      const done = await finish(empty(extractor, { message: "" }));
      return { ...done, idle: { mode, forward, backfill, pendingEval, doneKeys: cursor.shadow.done } };
    }

    // Text is what the model reads. With the gate off and none of this batch holding any, say so and consume nothing.
    const gateOn = await readContentGate(tx, userId, input.source);
    if (!gateOn && items.every((item) => item.message.content === null)) {
      const message = `${input.source} messages are being stored without their text, so there is nothing for the model to read. Turn text on with ${NO_CONTENT_FIX(input.source)} from the owner session; mail that arrives after that carries its text. Mail already stored without text stays unreadable until it is imported again (docs/operations/importing-your-data.md). Nothing was consumed and the cursor did not move.`;
      return finish(empty(extractor, { status: "no_content", message, read: 0 }), clip(message));
    }

    const token = newToken();
    patch.lease = {
      token,
      startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + LEASE_MS).toISOString()
    } satisfies Lease;
    await saveExtractorProgressTx(tx, userId, extractor.name, extractor.version, { cursor: patch });
    return { plan: { token, mode, pinned, items, labelled, settingsDiffer } };
  });
}

interface BehindArgs {
  mode: "active" | "shadow";
  forward: Mark;
  backfill: Mark | undefined;
  pendingEval: readonly string[];
  /** When given, the labelled messages not in it are the shadow run's pending ones (read after commit). */
  evalDone?: readonly string[];
  /** Messages a shadow run already read ahead of its forward mark; not counted as behind. */
  doneKeys?: readonly string[];
}

/**
 * The exact "behind by N" count, computed AFTER the run's transactions have committed, so the per-person lock is never
 * held for the count scans, under a statement timeout. A count that cannot finish is null, never a failed run.
 */
async function fillBehind(
  sql: PoolSql,
  userId: string,
  extractor: ModelExtractor,
  settings: DerivedSettings,
  now: Date,
  args: BehindArgs
): Promise<number | null> {
  try {
    return await sql.begin("read only", async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '${BEHIND_TIMEOUT}'`);
      const pending = args.evalDone
        ? (await readLabelledMessageKeys(tx, userId, SHADOW_EVAL_KEPT)).filter((key) => !args.evalDone!.includes(key))
        : args.pendingEval;
      return behindCount(
        tx,
        userId,
        extractor,
        args.mode,
        args.forward,
        args.backfill,
        settings,
        now,
        pending,
        args.doneKeys ?? []
      );
    });
  } catch {
    return null;
  }
}

async function behindCount(
  sql: PoolSql | TxSql,
  userId: string,
  extractor: ModelExtractor,
  mode: "active" | "shadow",
  forward: Mark,
  backfill: Mark | undefined,
  settings: DerivedSettings,
  now: Date,
  pendingEval: readonly string[],
  doneKeys: readonly string[] = []
): Promise<number> {
  const live = await countModelForward(sql, userId, extractor.input, forward, mode === "shadow" ? doneKeys : []);
  if (mode === "shadow") return live + (await countModelRowsByKeys(sql, userId, extractor.input, pendingEval));
  const history =
    backfill === undefined
      ? 0
      : await countModelBackfillBefore(
          sql,
          userId,
          extractor.input,
          backfill,
          new Date(now.getTime() - settings.backfillDays * 86_400_000)
        );
  return live + history;
}

/** Drops the lease and nothing else; used when phase (b) throws unexpectedly, so the batch is free for the next call. */
async function releaseLease(sql: PoolSql, userId: string, extractor: ModelExtractor, token: string): Promise<void> {
  await sql.begin(async (tx) => {
    await lockActivityUser(tx, userId);
    const held = (await readExtractorStateTx(tx, userId, extractor.name, extractor.version))?.cursor;
    if (readLease(held?.lease)?.token === token)
      await saveExtractorProgressTx(tx, userId, extractor.name, extractor.version, { cursor: { lease: null } });
  });
}

const isObject = (value: unknown): value is Record<string, unknown> => isRecord(value);

/** Puts the row in this version's target source, and names the pinned model on a model-tier fact (the runner's word, not the extractor's). */
function stamp(
  row: unknown,
  target: "derived" | "derived-shadow",
  pinned: PinnedModels,
  digest: string | null
): unknown {
  if (!isObject(row)) return row;
  const out: Record<string, unknown> = { ...row, source: target };
  const attrs = isObject(row.attrs) ? row.attrs : null;
  if (attrs && row.kind === "fact" && (attrs.tier === "t2" || attrs.tier === "t3")) {
    const pin = attrs.tier === "t2" ? pinned.t2 : pinned.t3;
    if (pin) out.attrs = { ...attrs, model: attrs.tier === "t2" && digest ? { id: pin.id, digest } : { id: pin.id } };
  }
  return out;
}

export async function runModelTick(sql: PoolSql, options: ModelTickOptions = {}): Promise<ModelTickResult> {
  const registered = options.extractors ?? MODEL_EXTRACTORS;
  if (registered.length === 0)
    return {
      status: "no_extractors",
      more: false,
      extractors: [],
      summary:
        "No model extractor is registered in this build, so the model tick has nothing to run. The fact extractor (fact-llm) arrives with slice 2b-6; until then this is a normal no-op and needs no action."
    };
  const userId = await ensureUser(sql);
  const settings = await readDerivedSettings(sql);
  const now = options.now ?? (() => new Date());
  const policy: PolicyDeps = {
    transport: options.transport ?? createModelTransport({ sql, userId, localAddress: settings.ollamaUrl }),
    settings,
    usage: () => hostedUsageLast24Hours(sql, userId),
    recordCall: (row) => recordModelCall(sql, userId, row),
    isHostedEligible: options.isHostedEligible ?? DENY_HOSTED,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    state: options.policyState ?? processPolicyState,
    hosted: MODEL_PROVIDERS.hosted
  };
  const results: ModelExtractorResult[] = [];
  for (const extractor of registered)
    results.push(
      await runExtractor(sql, userId, extractor, settings, policy, {
        now,
        clock: options.clock ?? Date.now,
        budgetMs: options.budgetMs ?? MODEL_BUDGET_MS,
        batch: options.batch ?? MODEL_BATCH,
        newToken: options.newToken ?? randomUUID
      })
    );
  if (results.every((result) => result.status === "busy")) return { status: "busy" };
  return {
    status: "ok",
    more: results.some((result) => result.more),
    extractors: results,
    summary: results.map(summarise).join(" ")
  };
}

function summarise(r: ModelExtractorResult): string {
  const head = `${r.extractor} v${r.version}${r.mode ? ` (${r.mode})` : ""}: ${r.status}.`;
  if (r.status !== "ok") return `${head} ${r.message}`;
  const counts = `read ${r.read}, wrote ${r.written} row(s), discarded ${r.discarded}, failed ${r.failed}, skipped ${r.skipped}, no text ${r.noContent}`;
  const behind = r.behind === null ? "" : `; behind by ${r.behind} message(s)`;
  return `${head} ${counts}${behind}. ${r.message}`;
}

interface RunDeps {
  now: () => Date;
  clock: () => number;
  budgetMs: number;
  batch: number;
  newToken: () => string;
}

async function runExtractor(
  sql: PoolSql,
  userId: string,
  extractor: ModelExtractor,
  settings: DerivedSettings,
  policy: PolicyDeps,
  deps: RunDeps
): Promise<ModelExtractorResult> {
  const startedAt = deps.now();
  const begun = await begin(sql, userId, extractor, settings, startedAt, deps.batch, deps.newToken);
  if ("done" in begun) {
    if (!begun.idle) return begun.done;
    const behind = await fillBehind(sql, userId, extractor, settings, startedAt, begun.idle);
    return {
      ...begun.done,
      behind,
      message: `Nothing to read: this version is up to date (behind by ${behind ?? "an unknown number of"} message(s)). It looks again on the next call to POST /api/integrations/derived/model-tick.`
    };
  }
  const { plan } = begun;
  let finished: { result: ModelExtractorResult; behind: BehindArgs | null };
  try {
    finished = await work(sql, userId, extractor, settings, policy, deps, plan, startedAt);
  } catch (error) {
    await releaseLease(sql, userId, extractor, plan.token).catch(() => undefined);
    throw error;
  }
  const { result } = finished;
  if (finished.behind === null) return result;
  result.behind = await fillBehind(sql, userId, extractor, settings, deps.now(), finished.behind);
  if (
    result.status === "ok" &&
    result.behind !== null &&
    result.behind > 0 &&
    result.message === "Nothing needs doing."
  )
    result.message = `Still behind by ${result.behind} message(s); POST /api/integrations/derived/model-tick again reads the next batch (the worker does this by itself).`;
  return result;
}

async function work(
  sql: PoolSql,
  userId: string,
  extractor: ModelExtractor,
  settings: DerivedSettings,
  policy: PolicyDeps,
  deps: RunDeps,
  plan: Plan,
  startedAt: Date
): Promise<{ result: ModelExtractorResult; behind: BehindArgs | null }> {
  const { pinned, items, mode, token } = plan;
  const target = mode === "active" ? "derived" : "derived-shadow";
  const started = deps.clock();
  const timeLeftMs = () => deps.budgetMs - (deps.clock() - started);
  let outage: string | null = null;
  let modelChanged: string | null = null;
  let learnedDigest: string | null = null;
  // The digest is read once per run, by the opening call below, and only a digest read there is ever stamped on a row:
  // a pinned value the host could not confirm this run is never copied into a row.
  let digest: string | null = null;
  let probeOk = false;

  // The tiny first call: it warms the local model (a cold load can take minutes and must not count against any
  // message), reads the digest, and tells a dead host from a bad message before any message is handed over.
  if (pinned.t2) {
    const probe = await callModel(policy, {
      tier: "t2",
      sourceEventKey: "probe:model-tick",
      model: pinned.t2.id,
      messages: PROBE,
      maxTokens: 8,
      withDigest: true
    });
    if (probe.kind === "failed" && probe.outcome !== "bad_output") outage = probe.message;
    else {
      probeOk = true;
      const seen = probe.kind === "ok" && typeof probe.digest === "string" ? probe.digest : null;
      if (pinned.t2.digest !== null) {
        if (seen === null)
          modelChanged = `The local model "${pinned.t2.id}" was pinned with digest ${pinned.t2.digest}, but this run could not confirm its digest (the host did not report one, or the opening call's reply was unusable), so nothing was read and no message used any budget; the pinned digest is never written onto rows unverified. Check that the ${MODEL_PROVIDERS.local.label} host is up to date and lists this model, then the next call retries (POST /api/derived-settings/test {"tier":"t2"} checks the connection).`;
        else if (seen !== pinned.t2.digest)
          modelChanged = `The local model "${pinned.t2.id}" now has digest ${seen}, but this version was pinned with digest ${pinned.t2.digest}, so it would no longer read mail the way it was measured. Nothing was read and no message used any budget. Either restore the pinned model on the ${MODEL_PROVIDERS.local.label} host (re-pulling a tag brings back its latest build, which may not be the pinned one), or promote a new version pinned to the new digest after reading its shadow run in GET /api/activity-events/summary?report=eval.`;
        else digest = seen;
      } else if (seen !== null) {
        digest = seen;
        learnedDigest = seen;
      }
    }
  }

  const executed: Executed[] = [];
  let current: Item | null = null;
  const context: ModelExtractContext = {
    now: startedAt,
    target,
    pinned,
    timeLeftMs,
    call: (args) => {
      const model = args.tier === "t2" ? pinned.t2?.id : pinned.t3?.id;
      const key = current?.message.key ?? "unknown";
      if (!model)
        return Promise.resolve({
          kind: "refused" as const,
          reason: "not_eligible" as const,
          message: `This version was pinned without a ${args.tier === "t2" ? "local" : "hosted"} model, so it cannot make a ${args.tier} call, and nothing was sent. Save one with PUT /api/derived-settings {"${args.tier === "t2" ? "t2Model" : "t3Model"}":"<model id>"} (Settings > Mail understanding); the next version is pinned to it.`
        });
      return callModel(policy, { ...args, model, sourceEventKey: key });
    }
  };
  let budgetStop = false;
  let timeouts = 0;
  if (outage === null && modelChanged === null)
    for (const item of items) {
      if (item.message.content === null) {
        executed.push({ item, kind: "no_content" });
        timeouts = 0;
        continue;
      }
      if (timeLeftMs() <= 0) {
        budgetStop = true;
        break;
      }
      // Renew before every message: a run whose lease was taken over stops reading at once, and a live run never expires.
      if (
        !(await renewExtractorLease(
          sql,
          userId,
          extractor.name,
          extractor.version,
          token,
          new Date(deps.now().getTime() + LEASE_MS)
        ))
      )
        break;
      current = item;
      let reply: ModelExtractResult | { kind: "failed"; outcome: "error"; message: string };
      let thread: ModelContextMessage[] = [];
      try {
        thread = await readThreadContext(sql, userId, extractor.input, item.message);
        item.texts = [item.message.content, ...thread.map((c) => c.content ?? "")];
        // A version that can use the hosted tier only ever sees context the eligibility rule accepts (F1).
        if (pinned.t3) {
          const kept: ModelContextMessage[] = [];
          for (const c of thread) {
            const verdict = await policy.isHostedEligible({ sourceEventKey: c.key, model: pinned.t3.id });
            if (verdict.eligible) kept.push(c);
          }
          thread = kept;
        }
        reply = await extractor.extract({ ...item.message, content: item.message.content }, thread, context);
      } catch (error) {
        reply = {
          kind: "failed",
          outcome: "error",
          message: error instanceof Error ? error.message : "The extractor failed."
        };
      }
      if (reply.kind === "rows") {
        executed.push({ item, kind: "rows", rows: reply.rows });
        timeouts = 0;
        continue;
      }
      const text = redactMailText(reply.message, item.texts);
      const cost = classifyFailure(reply.outcome);
      // Once the opening call worked this run, a host-level answer on one message is that message's problem.
      if (cost.kind === "outage" && !(reply.outcome === "unreachable" && probeOk)) {
        outage = text;
        break;
      }
      const code = cost.kind === "outage" ? ("model_unreachable" as const) : cost.code;
      executed.push({ item, kind: "failed", code, message: text });
      timeouts = code === "model_timeout" ? timeouts + 1 : 0;
      if (timeouts >= CONSECUTIVE_TIMEOUT_OUTAGE) {
        // Not N bad messages: the model is not answering. Give the messages back uncharged.
        while (executed.length > 0) {
          const last = executed[executed.length - 1]!;
          if (last.kind !== "failed" || last.code !== "model_timeout") break;
          executed.pop();
        }
        outage = `${timeouts} timeouts in a row: ${text}`;
        break;
      }
    }
  current = null;

  return complete(sql, userId, extractor, plan, executed, {
    startedAt,
    deps,
    token,
    outage,
    modelChanged,
    budgetStop,
    digest,
    learnedDigest,
    target
  });
}

interface Finish {
  startedAt: Date;
  deps: RunDeps;
  token: string;
  outage: string | null;
  modelChanged: string | null;
  budgetStop: boolean;
  digest: string | null;
  learnedDigest: string | null;
  target: "derived" | "derived-shadow";
}

/** Phase (c). */
async function complete(
  sql: PoolSql,
  userId: string,
  extractor: ModelExtractor,
  plan: Plan,
  executed: Executed[],
  f: Finish
): Promise<{ result: ModelExtractorResult; behind: BehindArgs | null }> {
  const input = extractor.input;
  return sql.begin(async (tx) => {
    await lockActivityUser(tx, userId);
    const now = f.deps.now();
    const held = await readExtractorStateTx(tx, userId, extractor.name, extractor.version);
    const cursor = readModelCursor(held?.cursor ?? {});
    const result = empty(extractor, { mode: plan.mode, read: executed.length });
    if (held === null || cursor.lease?.token !== f.token)
      return {
        behind: null,
        result: {
          ...result,
          status: "lease_lost" as const,
          discarded: executed.length,
          message: `This run's lease was taken over by another run while the model was working (the lease is the token written when the batch was read; it no longer matches), so everything this run produced was discarded: ${executed.length} message(s), nothing written and the cursor untouched. The other run owns the batch. No action is needed; the next call to POST /api/integrations/derived/model-tick carries on.`
        }
      };
    // A promotion in between changes which source this version's rows belong in (derived or derived-shadow).
    if (held.active !== (plan.mode === "active")) {
      await saveExtractorProgressTx(tx, userId, extractor.name, extractor.version, { cursor: { lease: null } });
      return {
        behind: null,
        result: {
          ...result,
          status: "lease_lost" as const,
          discarded: executed.length,
          message: `A promotion changed this version's role while the model was working (it is now ${held.active ? "the active version" : "a shadow version"}), so the rows it made belong to the other source; everything this run produced was discarded: ${executed.length} message(s), nothing written. No action is needed; the next call to POST /api/integrations/derived/model-tick runs the version in its new role.`
        }
      };
    }

    // Which sources are still there with the text that was read.
    const hashes = await readContentHashes(
      tx,
      userId,
      input,
      executed.map((e) => e.item.message.id)
    );
    const alive = (e: Executed) => hashes.get(e.item.message.id) === md5(e.item.message.content ?? "");

    const retries = { ...cursor.retries };
    let skipped = cursor.skipped;
    let skippedIds = [...cursor.skippedIds];
    const problems: string[] = [];
    const skippedNow: string[] = [];
    let forward = cursor.forward;
    let backfill = cursor.backfill;
    const evalDone = cursor.shadow.done.slice(0, cursor.shadow.evalCount);
    const liveDone = cursor.shadow.done.slice(cursor.shadow.evalCount);

    const skip = (e: Executed, code: string) => {
      delete retries[e.item.message.id];
      skippedIds = trimSkipped([
        ...skippedIds,
        { id: e.item.message.id, key: e.item.message.key, code, at: now.toISOString() }
      ]);
      skipped += 1;
      result.skipped += 1;
      skippedNow.push(`${e.item.message.key} (${code})`);
    };
    const fail = (e: Executed, code: string, reason: string) => {
      const id = e.item.message.id;
      const held = retries[id];
      const fresh = held && now.getTime() - new Date(held.since).getTime() <= MODEL_BUDGET_WINDOW_MS;
      const n = (fresh ? held.n : 0) + 1;
      problems.push(`${e.item.message.key}: ${redactMailText(reason, e.item.texts)}`);
      const room = id in retries || Object.keys(retries).length < RETRY_CAP;
      if (n >= MODEL_MESSAGE_BUDGET || !room) {
        skip(e, room ? code : "retry_list_full");
        return;
      }
      retries[id] = {
        n,
        since: fresh ? held.since : now.toISOString(),
        code,
        notBefore: new Date(now.getTime() + RETRY_COOLDOWN_MS[Math.min(n, RETRY_COOLDOWN_MS.length) - 1]!).toISOString()
      };
      result.failed += 1;
    };
    const reached = (e: Executed) => {
      delete retries[e.item.message.id];
      if (plan.mode !== "shadow") return;
      const key = e.item.message.key;
      if (plan.labelled.has(key)) {
        if (!evalDone.includes(key)) evalDone.push(key);
      } else if (!liveDone.includes(key)) liveDone.push(key);
    };

    const useful = f.outage === null && f.modelChanged === null;
    for (const e of executed) {
      const message = e.item.message;
      if (e.item.lane === "forward") forward = message.mark;
      else if (e.item.lane === "backfill") backfill = message.mark;
      if (!alive(e)) {
        result.discarded += 1;
        delete retries[message.id];
        continue;
      }
      if (e.kind === "no_content") {
        skip(e, "no_content");
        result.noContent += 1;
        continue;
      }
      if (e.kind === "failed") {
        fail(e, e.code, e.message);
        continue;
      }
      let refused: string | null = null;
      for (const rowIn of e.rows) {
        const rowOut = stamp(rowIn, f.target, plan.pinned, f.digest);
        try {
          const [written] = await tx.savepoint((sp) =>
            (f.target === "derived" ? writeDerivedRowsTx : writeShadowRowsTx)(
              sp,
              userId,
              [{ event: rowOut, sourceIds: [message.id] }],
              extractor.via,
              now
            )
          );
          if (!written || !written.ok) refused = written && !written.ok ? written.reason : "The row was not stored.";
          else if (written.added) result.written += 1;
          else result.alreadyHeld += 1;
        } catch (error) {
          refused = error instanceof Error ? error.message : "The store refused the row.";
        }
      }
      if (refused !== null) fail(e, "row_refused", refused);
      else reached(e);
    }
    result.retried = executed.filter((e) => e.item.lane === "retry").length;

    // The lanes are processed in order and a stop leaves the rest unread, so each mark is the last message done.
    const patch: Record<string, unknown> = {
      lease: null,
      retries,
      skipped,
      skippedIds,
      ...(forward ? { forward } : {}),
      ...(backfill ? { backfill } : {})
    };
    if (plan.mode === "shadow")
      patch.shadow = {
        done: shadowDone({ eval: evalDone, live: liveDone }),
        evalCount: Math.min(evalDone.length, SHADOW_EVAL_KEPT)
      };
    if (f.learnedDigest !== null && plan.pinned.t2 && f.modelChanged === null && f.outage === null)
      patch.models = { ...plan.pinned, t2: { id: plan.pinned.t2.id, digest: f.learnedDigest } };

    let status: ModelExtractorStatus = "ok";
    let message = "";
    let lastError: string | null = null;
    if (f.modelChanged !== null) {
      status = "model_changed";
      message = f.modelChanged;
      lastError = clip(f.modelChanged);
    } else if (f.outage !== null) {
      const fails = (cursor.circuit?.fails ?? 0) + 1;
      const openUntil = new Date(now.getTime() + circuitBackoffMs(fails)).toISOString();
      patch.circuit = { fails, openUntil, message: clip(f.outage).slice(0, 300) };
      status = "outage";
      message = `The model could not be used (${f.outage}) After this run's ${executed.length} finished message(s), the run stopped at the one that failed. Nothing was lost and no message used any of its retry budget; calls are paused until ${openUntil} (back-off ${minutes(circuitBackoffMs(fails))}). To check now, send POST /api/derived-settings/test {"tier":"t2"} from the owner session; otherwise the worker tries again by itself.`;
      lastError = clip(`Model outage: ${f.outage}`);
    } else {
      patch.circuit = null;
      if (problems.length > 0) lastError = clip(`${problems.length} message(s) failed this run, first: ${problems[0]}`);
      const notes: string[] = [];
      if (skippedNow.length > 0)
        notes.push(
          `Skipped after their retry budget or because they hold no text: ${skippedNow.join(", ")}; they stay listed in cursor.skippedIds (GET /api/activity-events/summary shows the count).`
        );
      if (result.failed > 0)
        notes.push(
          `${result.failed} message(s) will be tried again on the next call (budget ${MODEL_MESSAGE_BUDGET} within 24 hours).`
        );
      if (result.discarded > 0)
        notes.push(
          `${result.discarded} output(s) were discarded because the source message was deleted or changed while the model was working.`
        );
      if (plan.settingsDiffer)
        notes.push(
          "The saved model settings differ from this version's pinned models; the pin wins, and the saved ones apply to the next version."
        );
      message = notes.join(" ");
    }
    await saveExtractorProgressTx(tx, userId, extractor.name, extractor.version, {
      cursor: patch,
      ...(status === "ok" ? { lastOkAt: now } : {}),
      lastError
    });

    result.more = useful && (f.budgetStop || plan.items.length >= f.deps.batch);
    return {
      result: { ...result, status, message: message === "" ? "Nothing needs doing." : message },
      behind: {
        mode: plan.mode,
        forward: forward ?? { at: new Date(0).toISOString(), id: NIL_ID },
        backfill,
        pendingEval: [],
        evalDone,
        doneKeys: [...evalDone, ...liveDone]
      }
    };
  });
}
