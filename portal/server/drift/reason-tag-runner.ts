import { randomBytes } from "node:crypto";
import { REASON_MODEL_ID, resolveReasons } from "@openrhen/contracts/drift/reasons";
import { REASON_TAG_WINDOW_DAYS, needsModelTags, resolveReasonTags } from "@openrhen/contracts/drift/reason-tags";
import { callModel, processPolicyState, type ModelTransport, type PolicyState } from "@/server/derived/call-policy";
import { buildPolicyDeps } from "@/server/derived/model-runner";
import { lockActivityUser, tryLockActivityUser } from "@/server/persistence/postgres/activity-lock";
import { readDerivedSettings } from "@/server/persistence/postgres/derived-settings-store";
import {
  insertInferredReasonTags,
  readReasonRows,
  readReasonRowsOf,
  readReasonTagRows
} from "@/server/persistence/postgres/drift-reason-store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";
import {
  REASON_TAG_PROMPT_VERSION,
  buildReasonTagPrompt,
  parseReasonTagReply,
  validateReasonTagReply
} from "./reason-tag-prompt";

/**
 * The reason-tag job: after the fact, names in a few short phrases what a saved reason says, with the owner's local
 * model (tier `t2`), and stores them as a `reason_tag` row of origin `inferred`. The model is shown only the owner's
 * words: no plan text, no earlier tag and no list to choose from. An empty list is a valid answer.
 *
 * Three phases per reason, as the work-label job has: (a) under the per-person activity lock, pick the oldest reason
 * with no tags made under the current prompt and model (the owner's own answer ends the search for that reason);
 * (b) with no lock, call the model; (c) under the lock again, store the row only if the words are still the ones that
 * were sent. A tick tags at most `TICK_BATCH` reasons, oldest first, from a scan of at most `SCAN_LIMIT` rows of the
 * last `REASON_TAG_WINDOW_DAYS` days, and stops at the first failure.
 *
 * One reason that cannot be tagged never blocks the ones after it: each failure is counted per reason, and a reason is
 * not asked about again until its backoff has passed (`backoffMs`), which after `ATTEMPT_CAP` failures is a day. The
 * counts live in the process (`ReasonTagAttempts`), hold a key made of the check-in id and the time the words were
 * saved, never the words, and are lost when the portal restarts, which only means one more try.
 *
 * Nothing logs or returns the words or the model's reply: an answer carries a status, counts and fixed sentences, and a
 * failure is recorded as a count and an outcome code. See docs/architecture/drift.md.
 */

export type ReasonTagTickStatus = "ok" | "idle" | "busy" | "not_configured" | "failed" | "discarded";

export interface ReasonTagTickResult {
  status: ReasonTagTickStatus;
  /** True when another reason is waiting to be tagged, so the worker may come back soon. */
  more: boolean;
  /** Reasons tagged in this run. */
  tagged: number;
  /** Outcome code of the failure that ended the run, when one did: no words in it. */
  outcome?: string;
  summary: string;
}

export const SCAN_LIMIT = 500;
export const TICK_BATCH = 3;
export const ATTEMPT_CAP = 3;
const DAY_MS = 86_400_000;
const BACKOFF_BASE_MS = 600_000;
const ATTEMPTS_KEPT = 1000;

/** How long a reason waits after its `failures`th failure in a row: 10 minutes, 40 minutes, then a day for every failure from the cap on. */
export function backoffMs(failures: number): number {
  return failures >= ATTEMPT_CAP ? DAY_MS : BACKOFF_BASE_MS * 4 ** (failures - 1);
}

/** Failures in a row per reason, and when the reason may be tried again. */
export type ReasonTagAttempts = Map<string, { failures: number; retryAt: number }>;
export const createReasonTagAttempts = (): ReasonTagAttempts => new Map();
export const processReasonTagAttempts = createReasonTagAttempts();

const attemptKey = (checkInId: string, savedAt: Date) => `${checkInId}|${savedAt.getTime()}`;

function noteFailure(attempts: ReasonTagAttempts, key: string, nowMs: number): void {
  const failures = (attempts.get(key)?.failures ?? 0) + 1;
  attempts.set(key, { failures, retryAt: nowMs + backoffMs(failures) });
  if (attempts.size > ATTEMPTS_KEPT)
    for (const [held, state] of attempts) if (state.retryAt <= nowMs) attempts.delete(held);
}

export interface ReasonTagTickOptions {
  now?: () => Date;
  transport?: ModelTransport;
  sleep?: (ms: number) => Promise<void>;
  policyState?: PolicyState;
  attempts?: ReasonTagAttempts;
  newBoundary?: () => string;
}

type Step =
  | { kind: "busy" | "idle" | "tagged" | "discarded"; more: boolean }
  | { kind: "failed"; outcome: string; more: boolean };

export async function runReasonTagTick(sql: PoolSql, options: ReasonTagTickOptions = {}): Promise<ReasonTagTickResult> {
  const now = options.now ?? (() => new Date());
  const userId = await ensureUser(sql);
  const settings = await readDerivedSettings(sql);
  const modelId = settings.t2Model;
  if (modelId === null || !REASON_MODEL_ID.test(modelId))
    return {
      status: "not_configured",
      more: false,
      tagged: 0,
      summary:
        modelId === null
          ? "No local model is set, so no reason is tagged automatically. Pick one in Settings > Mail understanding, or add tags yourself on the Review page. This is normal until then."
          : "The local model's name is longer or different from what a tag can record (letters, digits and . _ : / @ + - up to 64 characters). Pick another model in Settings > Mail understanding."
    };

  let tagged = 0;
  for (let n = 0; n < TICK_BATCH; n += 1) {
    const step = await tagNext(sql, userId, settings, modelId, options, now);
    if (step.kind === "tagged") {
      tagged += 1;
      if (!step.more || n === TICK_BATCH - 1)
        return {
          status: "ok",
          more: step.more,
          tagged,
          summary: `Tagged ${tagged} reason${tagged === 1 ? "" : "s"}.`
        };
      continue;
    }
    if (step.kind === "discarded")
      return {
        status: "discarded",
        more: true,
        tagged,
        summary:
          "A reason was saved again while the model was working, so its tags were dropped. The next run starts again."
      };
    if (step.kind === "busy")
      return {
        status: tagged > 0 ? "ok" : "busy",
        more: false,
        tagged,
        summary: "The activity store is busy with another job; this run stopped."
      };
    if (step.kind === "failed")
      return {
        status: "failed",
        more: step.more,
        tagged,
        outcome: step.outcome,
        summary: `A reason could not be tagged (${step.outcome}). Nothing was kept for it; it is tried again after a wait, and the reasons after it are not held up. Check that the model is running (Settings > Mail understanding has a test).`
      };
    return {
      status: tagged > 0 ? "ok" : "idle",
      more: false,
      tagged,
      summary:
        tagged > 0
          ? `Tagged ${tagged} reason${tagged === 1 ? "" : "s"}.`
          : "Every recent reason has tags, an answer of your own, or is waiting out a retry."
    };
  }
  return { status: "ok", more: true, tagged, summary: `Tagged ${tagged} reasons.` };
}

async function tagNext(
  sql: PoolSql,
  userId: string,
  settings: Awaited<ReturnType<typeof readDerivedSettings>>,
  modelId: string,
  options: ReasonTagTickOptions,
  now: () => Date
): Promise<Step> {
  const attempts = options.attempts ?? processReasonTagAttempts;
  // Reasons a call is in line or running for in this process, so two overlapping runs never ask about the same one.
  const inFlight = (options.policyState ?? processPolicyState).working;

  // (a) Under the lock: pick the oldest reason that needs tags and fix the words to be sent.
  const picked = await sql.begin(async (tx) => {
    if (!(await tryLockActivityUser(tx, userId))) return "busy" as const;
    const since = new Date(now().getTime() - REASON_TAG_WINDOW_DAYS * DAY_MS);
    const reasons = await readReasonRows(tx, userId, { since, limit: SCAN_LIMIT, order: "oldest" });
    const standing = [...resolveReasons(reasons).values()];
    const tagRows = await readReasonTagRows(
      tx,
      userId,
      standing.map((reason) => reason.checkInId)
    );
    const resolved = resolveReasonTags(tagRows, reasons, { promptVersion: REASON_TAG_PROMPT_VERSION, modelId });
    const nowMs = now().getTime();
    const waiting = [...resolved.values()]
      .filter((item) => needsModelTags(item))
      .filter((item) => !inFlight.has(`reason_tag|${item.checkInId}`))
      .filter((item) => (attempts.get(attemptKey(item.checkInId, item.savedAt))?.retryAt ?? 0) <= nowMs)
      .sort((a, b) => a.savedAt.getTime() - b.savedAt.getTime() || (a.checkInId < b.checkInId ? -1 : 1));
    const [next] = waiting;
    // Marked inside the lock, so a second run that gets the lock next cannot pick the same reason.
    if (next) inFlight.add(`reason_tag|${next.checkInId}`);
    return next ? { reason: next, more: waiting.length > 1 } : ("idle" as const);
  });
  if (picked === "busy") return { kind: "busy", more: false };
  if (picked === "idle") return { kind: "idle", more: false };

  const { reason, more } = picked;
  const flightKey = `reason_tag|${reason.checkInId}`;
  const key = attemptKey(reason.checkInId, reason.savedAt);
  const prompt = buildReasonTagPrompt(reason.text, options.newBoundary?.() ?? randomBytes(16).toString("hex"));
  if (prompt === null) {
    inFlight.delete(flightKey);
    noteFailure(attempts, key, now().getTime());
    return { kind: "failed", outcome: "bad_prompt", more };
  }

  // (b) With no lock: ask the model.
  let result;
  try {
    const policy = buildPolicyDeps(sql, userId, settings, options);
    result = await callModel(policy, {
      tier: "t2",
      sourceEventKey: flightKey,
      model: modelId,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ],
      maxTokens: 200,
      format: "json",
      validate: validateReasonTagReply
    });
  } catch {
    // The call itself threw: counted like any other failure, with a fixed code and none of its text.
    inFlight.delete(flightKey);
    noteFailure(attempts, key, now().getTime());
    return { kind: "failed", outcome: "error", more };
  }
  inFlight.delete(flightKey);
  if (result.kind !== "ok") {
    noteFailure(attempts, key, now().getTime());
    return { kind: "failed", outcome: result.kind === "failed" ? result.outcome : "refused", more };
  }
  const reply = parseReasonTagReply(result.text);
  if (!reply.ok) {
    noteFailure(attempts, key, now().getTime());
    return { kind: "failed", outcome: "bad_output", more };
  }

  // (c) Under the lock: keep the tags only if the words are still the ones that were sent.
  const stored = await sql.begin(async (tx) => {
    await lockActivityUser(tx, userId);
    const standing = resolveReasons(await readReasonRowsOf(tx, userId, reason.checkInId)).get(reason.checkInId);
    if (
      standing === undefined ||
      standing.text !== reason.text ||
      standing.ingestedAt.getTime() !== reason.savedAt.getTime()
    )
      return "discarded" as const;
    return insertInferredReasonTags(
      tx,
      userId,
      { checkInId: reason.checkInId, tags: reply.tags, modelId, promptVersion: REASON_TAG_PROMPT_VERSION },
      now()
    );
  });
  if (stored === "discarded") return { kind: "discarded", more: true };
  if (!stored.ok) {
    noteFailure(attempts, key, now().getTime());
    return { kind: "failed", outcome: "refused_by_store", more };
  }
  attempts.delete(key);
  return { kind: "tagged", more };
}
