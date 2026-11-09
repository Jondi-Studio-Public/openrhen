import type postgres from "postgres";
import {
  PLAN_FORECAST_CONTRACT_VERSION,
  addLocalDays,
  buildDeliverableProjections,
  commitmentRepeatFallsOn,
  prerequisiteNodes,
  unmetPrerequisites,
  planForecastRequestSchema,
  planForecastResponseSchema,
  portalStateSchema,
  type CommitmentRepeat,
  type PlanForecastRequest,
  type PlanForecastResponse,
  type PortalStateContract
} from "@openrhen/contracts";
import {
  applyRoutineStepPlan,
  contextList,
  reconcileSleepRoutineSteps,
  type CommitmentRoutineStepInput,
  type ExistingRoutineStepForPlan,
  type RoutineStepPlanOp
} from "./routine-inheritance.js";
import { sweepMootRoutineSteps } from "./routine-step-mootness.js";
import { deriveProjectPace } from "./completion-ratios.js";
import { refitConsequenceIfStale } from "../consequence/refit.js";
import { notifyStateChanged } from "./state-changed.js";
import { recordNudgeShadow } from "./plan-nudge-shadow.js";
import { readJourneySummary } from "./journey-summary.js";
import { OFFER_LOG_TOP_CANDIDATES, recordOffered, type OfferedCandidate } from "../offer-log/offer-log.js";

export const PLAN_FORECAST_JOB_TYPE = "plan_forecast.recalculate.v1";
type UpsertAssignments = ReadonlyArray<readonly [column: string, value: postgres.PendingQuery<postgres.Row[]>]>;

/**
 * The `DO UPDATE` half of an upsert the planner replays on every replan: `set` writes each column's
 * value, and `changed` is true only when at least one of them differs from the stored row. Put `changed`
 * in the `WHERE` of `ON CONFLICT ... DO UPDATE` so a replan that decides nothing new skips the row
 * altogether, leaving `updated_at` (the "something about this row changed" signal) alone. Both halves
 * come from the one assignment list, so they cannot drift apart.
 */
function guardedConflictUpdate(sql: postgres.Sql, table: string, assignments: UpsertAssignments) {
  const join = (parts: ReadonlyArray<postgres.PendingQuery<postgres.Row[]>>) =>
    parts.reduce((all, part) => sql`${all}, ${part}`);
  return {
    set: join([
      ...assignments.map(([column, value]) => sql`${sql(column)}=${value}`),
      sql`updated_at=CURRENT_TIMESTAMP`
    ]),
    changed: sql`(${join(assignments.map(([column]) => sql`${sql(table)}.${sql(column)}`))}) IS DISTINCT FROM (${join(assignments.map(([, value]) => value))})`
  };
}

/** How far past `calculatedAt` a forecast request asks the engine to expand recurrence rules. */
const PLAN_FORECAST_HORIZON_DAYS = 180;
const RETRY_DELAYS_SECONDS = [1, 5, 30, 120, 600] as const;

/**
 * What a failed engine call does next, given the attempt that just failed (`attempts` counts from 1
 * and is incremented at claim). Each entry of `RETRY_DELAYS_SECONDS` is a wait before one more
 * attempt, so every delay is waited out and the job fails only on the attempt after the last one:
 * six attempts over about 12.6 minutes of delays.
 */
export function planForecastRetryAfterFailure(
  attempts: number
): { failed: false; delaySeconds: number } | { failed: true } {
  if (attempts > RETRY_DELAYS_SECONDS.length) return { failed: true };
  return { failed: false, delaySeconds: RETRY_DELAYS_SECONDS[Math.max(attempts, 1) - 1]! };
}

/**
 * How a failed attempt is recorded and whether it retries. An engine rejection fails at once
 * (`plan_forecast_rejected`). An engine that could not answer (`plan_forecast_unavailable`) never
 * exhausts the job: it follows the usual schedule and then keeps retrying at the longest delay, so an
 * unattended plan recovers on its own once the engine is back. Anything else failed after the engine
 * answered, while persisting, and retries under its own code so it is never blamed on the engine.
 */
export function classifyPlanForecastFailure(
  error: unknown,
  attempts: number
): { code: string; retry: ReturnType<typeof planForecastRetryAfterFailure> } {
  if (error instanceof PlanForecastEngineError)
    return error.rejected
      ? { code: "plan_forecast_rejected", retry: { failed: true } }
      : {
          code: "plan_forecast_unavailable",
          retry: planForecastRetryAfterFailure(Math.min(attempts, RETRY_DELAYS_SECONDS.length))
        };
  return { code: "plan_forecast_persist_failed", retry: planForecastRetryAfterFailure(attempts) };
}

export interface PlanForecastServiceConfig {
  url: string;
  token: string;
  timeoutMs: number;
}

export interface PlanForecastJobPayload {
  userId: string;
  cause: string;
  request: PlanForecastRequest;
  /** When the portal state inside `request` was read. Used to detect a snapshot overtaken by writes. */
  stateCapturedAt?: string;
}

/**
 * The shortest continuation ever requested. Work whose own minimum is this or less keeps extending in
 * the familiar 15-minute step, so nothing about ordinary sessions changes.
 */
export const CONTINUATION_FLOOR_MINUTES = 15;

export interface ContinuationTargetFacts {
  actions: ReadonlyArray<{ id: string; minimumSessionMinutes: number }>;
  occurrences: ReadonlyArray<{ id: string; actionId: string }>;
  deliverables: ReadonlyArray<{ id: string; minimumUsefulSessionMinutes: number | null }>;
}

/**
 * How many minutes a continuation of `targetId` should ask for.
 *
 * The engine refuses any continuation shorter than the target's own minimum useful session, so a fixed
 * 15-minute request made every deliverable with a 20-, 25- or 30-minute minimum permanently
 * uncontinuable — the refusal was correct and there was no way to satisfy it. Asking for the target's
 * own minimum, never below 15, is the smallest request that can succeed. This only raises the ceiling
 * the engine may offer: it still bounds the answer by remaining effort, maximum session, the compatible
 * window and displacement, so every safety rule is unchanged.
 *
 * A recurring session names its occurrence, which carries no session limits of its own; the template
 * action's minimum is the one the engine will apply. A deliverable session names the deliverable, whose
 * minimum lives on the projection — the same projection the engine turns into a forecast unit, so the
 * number asked for and the number checked against come from one place.
 */
export function continuationRequestMinutes(targetId: string, facts: ContinuationTargetFacts): number {
  const occurrence = facts.occurrences.find((item) => item.id === targetId);
  const action = facts.actions.find((item) => item.id === (occurrence ? occurrence.actionId : targetId));
  if (action) return Math.max(CONTINUATION_FLOOR_MINUTES, action.minimumSessionMinutes);
  const deliverable = facts.deliverables.find((item) => item.id === targetId);
  if (deliverable)
    return Math.max(CONTINUATION_FLOOR_MINUTES, deliverable.minimumUsefulSessionMinutes ?? CONTINUATION_FLOOR_MINUTES);
  return CONTINUATION_FLOOR_MINUTES;
}

/**
 * @param continuation The session to simulate extending. Omitting `requestedMinutes` asks for the
 * target's own minimum useful session (never below 15), resolved here because this is where the
 * deliverable projections the engine plans against are built.
 * @param sql when given, `deriveProjectPace` (`./completion-ratios.js`) runs here — this is
 * where the engine's project input is assembled — and the derived `actualCompletionRatio` /
 * `requiredCompletionRatio` are folded into `state.projects` before the request (and its
 * `inputVersion` hash) is built, so the persisted row and what the engine sees are identical.
 * Omitted by callers with no database handle (chiefly tests exercising unrelated behaviour), in
 * which case a project keeps whatever ratios its `stateInput` already carried.
 * @param userId Whom the journey summary (the travel time model design note "Persistence"/"The
 * lookup") is read for. Required alongside `sql` to actually read it — `journey_samples` has no other
 * scope than the user it belongs to — so a caller that passes `sql` without `userId` gets project pace
 * but an empty journey summary rather than a query with no `WHERE user_id`.
 */
export async function buildPlanForecastRequest(
  stateInput: unknown,
  at: Date,
  continuation?: { actionId: string; requestedMinutes?: number },
  sql?: postgres.Sql | postgres.TransactionSql,
  userId?: string
): Promise<PlanForecastRequest> {
  const state = portalStateSchema.parse(stateInput);
  if (sql) {
    const updates = await deriveProjectPace(sql, state.projects, state.actions, at);
    for (const project of state.projects) {
      const update = updates.get(project.id);
      if (update) Object.assign(project, update);
    }
    // The day-roll refresh of the comparison-derived consequence (comparison-consequence-ranking design, 3.5): answers
    // age by calendar day, so a plan built on a new day first refits any value fitted on an earlier one. The values the
    // refit wrote are folded into this request, so the persisted rows and the engine's input agree, like the pace above.
    // A failed refit changes nothing and the engine falls back to stars for any value it cannot trust.
    if (userId) {
      const refit = await refitConsequenceIfStale(sql, userId, at, state.settings.timezone);
      if (refit?.ok)
        for (const record of [...state.projects, ...state.actions]) {
          if (!refit.changed.has(record.id)) continue;
          const next = refit.changed.get(record.id);
          if (next) {
            record.consequenceRefined = next.value;
            record.consequenceRefinedForStars = next.forStars;
          } else {
            delete record.consequenceRefined;
            delete record.consequenceRefinedForStars;
          }
        }
    }
  }
  // The journey summary is built here, alongside project pace, whenever there is both a database
  // handle and a user to read it for. `inputVersion` hashes it below along with everything else, so a
  // new sample — which changes what `readJourneySummary` returns — always makes a new version, even
  // when nothing else about the state changed.
  const journeys =
    sql && userId ? await readJourneySummary(sql, userId, at, state.settings.timezone) : { cells: [], latest: [] };
  const horizonEnd = new Date(at.getTime() + PLAN_FORECAST_HORIZON_DAYS * 86_400_000);
  // Derived here rather than inside the engine, so the engine never reads a deliverable's criteria,
  // blockers or evidence — only the accepted facts this projection carries.
  const deliverables = buildDeliverableProjections({
    deliverables: state.deliverables,
    situation: state.currentSituation,
    conditionDefinitions: state.conditionDefinitions,
    now: at,
    commitments: state.commitments,
    unmet: unmetPrerequisites(prerequisiteNodes(state))
  });
  const requested = continuation
    ? {
        actionId: continuation.actionId,
        requestedMinutes:
          continuation.requestedMinutes ??
          continuationRequestMinutes(continuation.actionId, {
            actions: state.actions,
            occurrences: state.occurrences,
            deliverables
          })
      }
    : undefined;
  // Hashing `journeys` alongside `state` is what makes a new sample change `inputVersion` on its own:
  // nothing about `state` moves when a Google measurement or an own trip lands, only the summary this
  // read just recomputed — so the hash must actually see it, not just the request that carries it.
  const inputVersion = await sha256(
    canonicalJson({ at: at.toISOString(), horizonEnd: horizonEnd.toISOString(), state, journeys })
  );
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: crypto.randomUUID(),
    inputVersion,
    calculatedAt: at.toISOString(),
    horizonEnd: horizonEnd.toISOString(),
    state,
    deliverables,
    journeys,
    ...(requested ? { continuation: requested } : {})
  });
}

/**
 * A failed call to the Plan and Forecast Engine. `rejected` marks an answer that the same request will
 * always get again: the engine refused the input (400, 413), its calculation threw on it
 * (`calculation_failed`), or its reply broke the contract. Retrying those only repeats the failure, so
 * the job fails at once. Anything else (unreachable, timed out, 401, 404, 5xx) may pass, and retries.
 */
export class PlanForecastEngineError extends Error {
  readonly rejected: boolean;
  constructor(
    readonly status: number | null,
    readonly code: string
  ) {
    super(
      status === null
        ? `Plan and Forecast Engine ${code}.`
        : `Plan and Forecast Engine returned ${status}${code ? ` (${code})` : ""}.`
    );
    this.name = "PlanForecastEngineError";
    this.rejected = status === 400 || status === 413 || code === "calculation_failed" || code === "invalid_response";
  }
}

export async function requestPlanForecast(
  config: PlanForecastServiceConfig,
  request: PlanForecastRequest
): Promise<PlanForecastResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(`${config.url.replace(/\/$/, "")}/v1/plan-and-forecast`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal
      });
    } catch {
      throw new PlanForecastEngineError(null, controller.signal.aborted ? "timed out" : "unreachable");
    }
    // A body that fails to arrive (connection dropped, timeout mid-read) is the engine being
    // unavailable, not a malformed answer; only a fully received body that is not JSON or fails the
    // schema counts as `invalid_response`, which is terminal.
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new PlanForecastEngineError(null, controller.signal.aborted ? "timed out" : "unreachable");
    }
    let body: { error?: { code?: unknown } } | null;
    try {
      body = JSON.parse(text) as { error?: { code?: unknown } } | null;
    } catch {
      body = null;
    }
    if (!response.ok)
      throw new PlanForecastEngineError(response.status, typeof body?.error?.code === "string" ? body.error.code : "");
    const parsed = planForecastResponseSchema.safeParse(body);
    if (!parsed.success) throw new PlanForecastEngineError(response.status, "invalid_response");
    return parsed.data;
  } finally {
    clearTimeout(timeout);
  }
}

export async function enqueuePlanForecastJob(
  // `portal/server/persistence/postgres/planning-evidence.ts`'s `recordStateChange` calls this from
  // inside a caller's already-open transaction (every command handler enqueues a recalculation as
  // part of its own write), passing a real `postgres.TransactionSql` — this only ever runs tagged-
  // template queries and `sql.json`, which both handles provide identically.
  sql: postgres.Sql | postgres.TransactionSql,
  userId: string,
  request: PlanForecastRequest,
  cause: string,
  availableAt?: Date,
  stateCapturedAt?: string
): Promise<string> {
  const idempotencyKey = `${PLAN_FORECAST_JOB_TYPE}:${userId}:${request.inputVersion}`;
  const payload: PlanForecastJobPayload = {
    userId,
    cause,
    request,
    stateCapturedAt: stateCapturedAt ?? request.calculatedAt
  };
  const rows = await sql<{ id: string }[]>`
    INSERT INTO jobs (type,payload,idempotency_key,status,available_at)
    VALUES (${PLAN_FORECAST_JOB_TYPE},${sql.json(payload as never)},${idempotencyKey},'pending',${availableAt ?? new Date(0)})
    ON CONFLICT (idempotency_key) DO UPDATE SET
      available_at=LEAST(jobs.available_at,EXCLUDED.available_at),
      status=CASE WHEN jobs.status IN ('failed','superseded') THEN 'pending' ELSE jobs.status END,
      attempts=CASE WHEN jobs.status IN ('failed','superseded') THEN 0 ELSE jobs.attempts END,
      failed_at=CASE WHEN jobs.status IN ('failed','superseded') THEN NULL ELSE jobs.failed_at END,
      last_error_code=CASE WHEN jobs.status IN ('failed','superseded') THEN NULL ELSE jobs.last_error_code END,
      last_error_message=CASE WHEN jobs.status IN ('failed','superseded') THEN NULL ELSE jobs.last_error_message END
    RETURNING id
  `;
  const id = rows[0]!.id;
  await supersedeOlderPendingPlanForecastJobs(sql, userId, id);
  return id;
}

/**
 * At most one future plan-forecast job may wait per user, whatever caused it.
 *
 * Every completed run chains the next boundary job, and its key carries that run's input version, so
 * two runs against the same `validUntil` produce two distinct rows rather than one idempotent one —
 * and every ordinary write does the same under `planning_state_changed`. Nothing removed the loser, so
 * a week of ordinary use left over twelve hundred superseded boundary rows and, worse, N sequential
 * writes (an import, a bulk edit, the CLI) left N-1 pending `planning_state_changed` jobs that each
 * cost a full engine call before being discarded the instant they were claimed.
 *
 * A newly queued job makes every other *waiting* job for that user pointless, whatever caused either
 * one: a state change has already invalidated the snapshot any earlier job — boundary or
 * state-change — was built from, and a newer job supersedes an older one by definition regardless of
 * why either was queued. Only waiting rows are touched — a job already claimed by a worker keeps its
 * own outcome, so this cannot race a run to its result — and the row just enqueued is excluded, so
 * re-enqueueing an existing key never cancels itself. This is a courtesy that keeps the queue from
 * accumulating dead rows between writes; `processPlanForecastJob`'s own claim-time check is what
 * actually guarantees an engine call is never wasted, since a race can still leave an older row
 * `pending` here (see its comment for why the check has to be repeated there).
 */
async function supersedeOlderPendingPlanForecastJobs(
  sql: postgres.Sql | postgres.TransactionSql,
  userId: string,
  keepJobId: string
) {
  await sql`
    UPDATE jobs SET status='superseded',completed_at=CURRENT_TIMESTAMP,finished_at=CURRENT_TIMESTAMP,locked_at=NULL,locked_by=NULL
    WHERE type=${PLAN_FORECAST_JOB_TYPE}
      AND status IN ('pending','retrying')
      AND payload->>'userId'=${userId}
      AND id<>${keepJobId}::uuid
  `;
}

export async function claimPlanForecastJob(
  sql: postgres.Sql,
  workerId: string,
  specificJobId?: string
): Promise<{ id: string; attempts: number; payload: PlanForecastJobPayload } | null> {
  const rows = await sql<{ id: string; attempts: number; payload: unknown }[]>`
    WITH candidate AS (
      SELECT id FROM jobs
      WHERE type=${PLAN_FORECAST_JOB_TYPE}
        AND status IN ('pending','retrying')
        AND available_at<=CURRENT_TIMESTAMP
        AND (${specificJobId ?? null}::uuid IS NULL OR id=${specificJobId ?? null}::uuid)
      ORDER BY available_at,seq
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE jobs SET status='running',locked_at=CURRENT_TIMESTAMP,locked_by=${workerId},attempts=attempts+1
    WHERE id IN (SELECT id FROM candidate)
    RETURNING id,attempts,payload
  `;
  if (!rows[0]) return null;
  const payload = rows[0].payload as PlanForecastJobPayload;
  const parsed = planForecastRequestSchema.safeParse(payload.request);
  if (!parsed.success) {
    // The claim above has already committed, so throwing here alone left the row `running` with no
    // attempt to clear it. A payload that fails its schema fails the same way on every retry.
    await sql`
      UPDATE jobs SET status='failed',failed_at=CURRENT_TIMESTAMP,locked_at=NULL,locked_by=NULL,
        last_error_code='invalid_payload',last_error_message=${parsed.error.message.slice(0, 500)}
      WHERE id=${rows[0].id}
    `;
    throw parsed.error;
  }
  return { id: rows[0].id, attempts: rows[0].attempts, payload };
}

/**
 * True when another still-relevant plan-forecast job for this user was enqueued after the one named
 * by `jobId` — "relevant" meaning still pending, waiting out a retry delay, or already claimed by
 * (possibly another) worker; a completed, superseded or cancelled row can never make this one stale
 * (a failed state-change job is the one exception, below). Ordering is by `seq`, the enqueue-order sequence — never `created_at` (the enqueuing transaction's wall-clock start, which a long transaction or a clock correction can put out of order, #795) and never `input_version`, which is an opaque
 * content hash with no ordering of its own and must not be read as one.
 *
 * A newer state-change job that has already failed counts too. It carries a write no plan has seen,
 * and with two workers it can fail (an engine rejection is terminal at once) while an older job is
 * still in its engine call. Letting that older job publish, or chain a boundary job from its request
 * state, would date a plan after the write while omitting it, so the status would call the plan
 * current and hide the failure. A failed boundary job holds no write, so it is no barrier.
 *
 * Used both before and after the engine call in `processPlanForecastJob`: the first avoids paying for
 * a call already known to be wasted, the second catches a write that lands while that call is still in
 * flight. Neither check can ever make the *newest* job for a user supersede itself, since nothing can
 * have a `created_at` later than its own.
 */
async function newerActivePlanForecastJobExists(sql: postgres.Sql, userId: string, jobId: string): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM jobs
      WHERE type=${PLAN_FORECAST_JOB_TYPE}
        AND payload->>'userId'=${userId}
        AND (
          status IN ('pending','retrying','running')
          OR (status='failed' AND payload->>'cause' IS DISTINCT FROM 'validity_boundary')
        )
        AND id<>${jobId}::uuid
        AND seq>(SELECT seq FROM jobs WHERE id=${jobId}::uuid)
    ) AS exists
  `;
  return rows[0]?.exists === true;
}

/** What one finished attempt cost and how it ended, for the worker's completion log line. */
export interface PlanForecastJobOutcome {
  jobId: string;
  userId: string;
  cause: string;
  attempts: number;
  outcome: "completed" | "retrying" | "failed" | "superseded";
  durationMs: number;
}

/**
 * The rows a live worker may still write its attempt's outcome to: its own `running` claim, or one the
 * reaper gave up on mid-call (`abandoned_lock`, `failed` once the retry budget was spent, `retrying`
 * otherwise) that nobody has claimed since. The worker is alive and the result in hand is its own, so
 * the outcome belongs on the row; refusing it left a stale `retrying` row to pay for another engine
 * call, and an exhausted one recorded as an abandonment. A row another worker holds (`running` under a
 * different `locked_by`) or that already finished matches neither, so a replacement's claim is never
 * touched. Every end-of-attempt write goes through this one condition.
 */
function claimStillHeldBy(sql: postgres.Sql, workerId: string) {
  return sql`((status='running' AND locked_by=${workerId}) OR (status IN ('failed','retrying') AND last_error_code='abandoned_lock'))`;
}

export async function processPlanForecastJob(
  sql: postgres.Sql,
  config: PlanForecastServiceConfig,
  workerId: string,
  specificJobId?: string,
  // Reporting through a callback rather than the return value keeps `"idle"` comparable at the call
  // site, so a worker that only wants to know whether the queue was empty needs no change at all.
  report?: (outcome: PlanForecastJobOutcome) => void
): Promise<"idle" | "completed" | "retrying" | "failed" | "superseded"> {
  const job = await claimPlanForecastJob(sql, workerId, specificJobId);
  if (!job) return "idle";
  // `completed_at` and `finished_at` are stamped as the lock is cleared, so nothing afterwards can
  // recover how long the attempt took. Measuring from the claim is the only window that covers the
  // engine call itself, and it is recorded on the row so a finished job still answers the question.
  const startedAt = Date.now();
  const finish = async (
    outcome: PlanForecastJobOutcome["outcome"],
    update: (durationMs: number) => Promise<unknown>
  ) => {
    const durationMs = Date.now() - startedAt;
    await update(durationMs);
    report?.({
      jobId: job.id,
      userId: job.payload.userId,
      cause: job.payload.cause,
      attempts: job.attempts,
      outcome,
      durationMs
    });
    return outcome;
  };
  // Every end-of-attempt write is guarded on the row still being this worker's claim: a lease that
  // expired mid-call may have been reclaimed and handed to another worker, whose outcome must stand.
  const markSuperseded = () =>
    finish(
      "superseded",
      (durationMs) =>
        sql`UPDATE jobs SET status='superseded',completed_at=CURRENT_TIMESTAMP,finished_at=CURRENT_TIMESTAMP,duration_ms=${durationMs},locked_at=NULL,locked_by=NULL,failed_at=NULL WHERE id=${job.id} AND ${claimStillHeldBy(sql, workerId)}`
    );
  // A boundary-triggered job carries the snapshot it was chained from. If the user has written
  // anything since, that write enqueued its own job with fresh state and this one must not persist
  // a result derived from state that has already moved on. `recordStateChange` guarantees every
  // `write_rows` row came with its own job (one write path, invariant 2 of
  // The one write path design note), so a newer `write_rows` row always means a newer job exists to
  // supersede this one. `write_rows.created_at` is its transaction's start, though, so a write that
  // committed after the snapshot can still date before it; a write's job that is still waiting is
  // the check that does not depend on timestamps.
  if (
    job.payload.cause === "validity_boundary" &&
    ((await stateChangedSince(sql, job.payload.userId, job.payload.stateCapturedAt)) ||
      (await stateChangeJobWaiting(sql, job.payload.userId, job.id)))
  )
    return markSuperseded();
  // `enqueuePlanForecastJob`'s own supersession keeps the queue from accumulating dead rows between
  // writes, but it cannot guarantee this claimed job is still the latest one: a newer job can be
  // enqueued in the gap between that UPDATE and this claim (or a caller can pass `specificJobId` to
  // process an older row directly). Checking before paying for an engine call is the whole point of
  // this finding — N sequential writes used to cost N engine calls with N-1 of them thrown away the
  // moment they were claimed. "Newer" is always enqueue order (`created_at`), never `input_version`:
  // that's an opaque content hash with no ordering of its own.
  if (await newerActivePlanForecastJobExists(sql, job.payload.userId, job.id)) return markSuperseded();
  let result: PlanForecastResponse;
  try {
    result = await requestPlanForecast(config, job.payload.request);
    // The same race the pre-call check above guards against can also land while the engine call
    // itself was in flight — that window is exactly what this second check is for, and it must never
    // be removed on the assumption the first one already covered it.
    if (await newerActivePlanForecastJobExists(sql, job.payload.userId, job.id)) return markSuperseded();
    // A result older than the one already current is never persisted: with a second worker,
    // a newer job can have completed while this one's engine call was still in flight, and the
    // active-job check above cannot see a job that has already finished.
    if (!(await persistPlanForecastResult(sql, job.payload.userId, result))) return markSuperseded();
    // The forecast is committed by the time `persistPlanForecastResult` resolves (it wraps its own
    // `sql.begin`), so every open tab's `/api/events` listener is safe to wake up here — anything it
    // goes on to fetch will already see this result.
    notifyStateChanged(sql, { userId: job.payload.userId, kind: "planning" });
    // Advisory and after the commit: it reads the published ranking, writes only `plan_shadow_log`, and
    // never throws, so it cannot change or fail the live run.
    await recordNudgeShadow(sql, job.payload.userId, result);
  } catch (error) {
    const { code, retry } = classifyPlanForecastFailure(error, job.attempts);
    const failed = retry.failed;
    const delay = retry.failed ? 0 : retry.delaySeconds;
    return finish(
      failed ? "failed" : "retrying",
      (durationMs) => sql`
        UPDATE jobs SET status=${failed ? "failed" : "retrying"},available_at=CURRENT_TIMESTAMP+(${delay}*INTERVAL '1 second'),
          failed_at=${failed ? new Date() : null},duration_ms=${durationMs},locked_at=NULL,locked_by=NULL,last_error_code=${code},
          last_error_message=${error instanceof Error ? error.message.slice(0, 500) : "Unknown Plan and Forecast Engine error"}
        WHERE id=${job.id} AND ${claimStillHeldBy(sql, workerId)}
      `
    );
  }
  let owned = true;
  await finish("completed", async (durationMs) => {
    // Ownership is `claimStillHeldBy`: a reaped-but-unclaimed row is still this live worker's, which has
    // just published, so the job is done and the boundary job is its to chain. Left failed, nothing
    // would chain it (boot recovery skips `abandoned_lock`) and an unattended plan would go stale.
    const updated = await sql`
      UPDATE jobs SET status='completed',completed_at=CURRENT_TIMESTAMP,finished_at=CURRENT_TIMESTAMP,duration_ms=${durationMs},
        locked_at=NULL,locked_by=NULL,failed_at=NULL,last_error_code=NULL,last_error_message=NULL
      WHERE id=${job.id} AND ${claimStillHeldBy(sql, workerId)}
    `;
    owned = updated.count > 0;
  });
  // Another worker holds the claim now (the reaper handed the row on and it was claimed again, or the
  // job already finished): the result above is still a valid plan (persistence refuses one older than
  // the current run), but the boundary job is that worker's to chain from whatever it computes.
  if (!owned) return "superseded";
  // Chaining the next boundary job is outside the engine/persist `try`: the plan is already
  // persisted and the job already completed, so a failure here must not turn it back into a retry
  // that re-pays for the engine call and blames the engine. It is recorded on the completed row
  // under its own code instead, and the user's next write chains a fresh boundary job.
  try {
    await chainValidityBoundaryJob(sql, job.id, job.payload, result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : "Unknown error chaining the next boundary job";
    await sql`UPDATE jobs SET last_error_code='boundary_chain_failed',last_error_message=${message} WHERE id=${job.id}`;
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "Chaining the next validity boundary job failed", jobId: job.id, userId: job.payload.userId, error: message })}\n`
    );
  }
  return "completed";
}

/**
 * Enqueues the job that refreshes the plan at `result.validUntil`, built from the snapshot `sourceJob`
 * ran on. That snapshot is the oldest state in the queue by construction, so unlike an ordinary
 * enqueue this must never supersede a job carrying newer state: a write that landed while the
 * result was persisting has its own `planning_state_changed` job, and discarding it left the plan
 * ignoring the write. If any such job is waiting, or any job newer than the source is still active,
 * nothing is chained at all — that job will chain its own boundary from fresher state.
 */
async function chainValidityBoundaryJob(
  sql: postgres.Sql,
  sourceJobId: string,
  source: PlanForecastJobPayload,
  result: PlanForecastResponse
) {
  const nextAt = new Date(result.validUntil);
  if (nextAt <= new Date()) return;
  if (
    (await newerActivePlanForecastJobExists(sql, source.userId, sourceJobId)) ||
    (await stateChangeJobWaiting(sql, source.userId, sourceJobId))
  )
    return;
  const nextRequest = await buildPlanForecastRequest(source.request.state, nextAt, undefined, sql, source.userId);
  // The snapshot this plan was built from is only settled once the result is persisted. Forwarding
  // the originating command's `calculatedAt` dated the chained job before that command's own
  // write_rows row, so every boundary job superseded itself and the hourly refresh never ran.
  const persistedAt = new Date().toISOString();
  const idempotencyKey = `${PLAN_FORECAST_JOB_TYPE}:${source.userId}:${nextRequest.inputVersion}`;
  const payload: PlanForecastJobPayload = {
    userId: source.userId,
    cause: "validity_boundary",
    request: nextRequest,
    stateCapturedAt: persistedAt
  };
  await sql.begin(async (transaction) => {
    const rows = await transaction<{ id: string }[]>`
      INSERT INTO jobs (type,payload,idempotency_key,status,available_at)
      VALUES (${PLAN_FORECAST_JOB_TYPE},${transaction.json(payload as never)},${idempotencyKey},'pending',${nextAt})
      ON CONFLICT (idempotency_key) DO UPDATE SET
        available_at=LEAST(jobs.available_at,EXCLUDED.available_at),
        status=CASE WHEN jobs.status IN ('failed','superseded') THEN 'pending' ELSE jobs.status END,
        attempts=CASE WHEN jobs.status IN ('failed','superseded') THEN 0 ELSE jobs.attempts END,
        failed_at=CASE WHEN jobs.status IN ('failed','superseded') THEN NULL ELSE jobs.failed_at END,
        last_error_code=CASE WHEN jobs.status IN ('failed','superseded') THEN NULL ELSE jobs.last_error_code END,
        last_error_message=CASE WHEN jobs.status IN ('failed','superseded') THEN NULL ELSE jobs.last_error_message END
      RETURNING id
    `;
    // Only older boundary jobs give way: each was chained from a snapshot older than this one.
    await transaction`
      UPDATE jobs SET status='superseded',completed_at=CURRENT_TIMESTAMP,finished_at=CURRENT_TIMESTAMP,locked_at=NULL,locked_by=NULL
      WHERE type=${PLAN_FORECAST_JOB_TYPE}
        AND status IN ('pending','retrying')
        AND payload->>'userId'=${source.userId}
        AND payload->>'cause'='validity_boundary'
        AND id<>${rows[0]!.id}::uuid
    `;
  });
}

/**
 * True when a job other than `jobId` that was queued by a write (any cause but `validity_boundary`) is
 * still waiting for this user. Such a job carries state at least as new as any boundary job's snapshot,
 * whatever the two rows' `created_at` say: `created_at` is the enqueuing transaction's start, so a write
 * that committed late can sort before a boundary job it actually postdates.
 */
async function stateChangeJobWaiting(sql: postgres.Sql, userId: string, jobId: string): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM jobs
      WHERE type=${PLAN_FORECAST_JOB_TYPE}
        AND payload->>'userId'=${userId}
        AND payload->>'cause'<>'validity_boundary'
        AND status IN ('pending','retrying')
        AND id<>${jobId}::uuid
    ) AS exists
  `;
  return rows[0]?.exists === true;
}

/**
 * Takes the per-user lock that serialises publishing a plan run. Held to the end of the caller's
 * transaction. `persistPlanForecastResult` takes it to publish; a command that acts on a plan run
 * already past its validity boundary takes it too, so the run it read cannot be superseded while the
 * command is still in flight, and a publish in progress finishes before the command reads.
 */
export async function lockPlanForecastPublication(
  sql: postgres.Sql | postgres.TransactionSql,
  userId: string
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`plan_forecast_persist:${userId}`}, 0))`;
}

/**
 * Publishes one engine result and everything derived from it, atomically. Returns false, writing
 * nothing, when the user's current run was calculated later than this result: results are
 * ordered by `calculated_at`, and a slower job finishing second must never put an older plan back.
 * The per-user advisory lock makes that comparison and the write one step, so two workers persisting
 * at once cannot both pass it.
 */
export async function persistPlanForecastResult(
  sql: postgres.Sql,
  userId: string,
  resultInput: PlanForecastResponse,
  withinTransaction = false
): Promise<boolean> {
  if (!withinTransaction) {
    return sql.begin((transaction) =>
      persistPlanForecastResult(transaction as unknown as postgres.Sql, userId, resultInput, true)
    );
  }
  const result = planForecastResponseSchema.parse(resultInput);
  await lockPlanForecastPublication(sql, userId);
  const existing = await sql<
    { id: string }[]
  >`SELECT id FROM planning_runs WHERE request_id=${result.requestId} LIMIT 1`;
  if (existing[0]) return true;
  const newer = await sql<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM planning_runs
      WHERE user_id=${userId} AND superseded_at IS NULL AND calculated_at>${new Date(result.calculatedAt)}
    ) AS exists
  `;
  if (newer[0]?.exists === true) return false;
  await sql`UPDATE planning_runs SET superseded_at=${new Date(result.calculatedAt)} WHERE user_id=${userId} AND superseded_at IS NULL`;
  await sql`
      INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
      VALUES (${userId},${result.requestId},${result.inputVersion},${result.contractVersion},${result.engineVersion},${new Date(result.calculatedAt)},${new Date(result.validUntil)},${sql.json(result as never)})
      ON CONFLICT (request_id) DO NOTHING
  `;
  // Occurrences must exist before recommendation candidates reference them.
  // All derived rows and normalized evidence are still published atomically.
  await persistDerivedState(sql, userId, result);
  const schedule = result.schedule as unknown as { forecasts?: Array<Record<string, unknown>> };
  const recommendation = result.recommendation as unknown as {
    primary?: { action?: Record<string, unknown>; recommendedMinutes?: number | null } | null;
    candidates?: Array<Record<string, unknown>>;
    headline?: string;
    explanation?: string;
    evidence?: string[];
  };
  for (const item of schedule.forecasts ?? []) {
    if (typeof item.projectId !== "string" || typeof item.health !== "string") continue;
    await sql`INSERT INTO forecast_snapshots (project_id,calculated_at,input_version,protected_remaining_minutes,pessimistic_remaining_minutes,compatible_capacity_minutes,gross_compatible_capacity_minutes,reserved_by_earlier_deadlines_minutes,required_pace_minutes_per_week,forecast_band,forecast_confidence,forecast_through,expected_margin_minutes,pessimistic_margin_minutes,schedule_variance,health,explanation) VALUES (${item.projectId},${new Date(result.calculatedAt)},${result.inputVersion},${numberOrNull(item.protectedRemainingMinutes)},${numberOrNull(item.pessimisticRemainingMinutes)},${numberOrNull(item.compatibleCapacityMinutes)},${numberOrNull(item.grossCompatibleCapacityMinutes)},${numberOrNull(item.reservedByEarlierDeadlinesMinutes)},${numberOrNull(item.requiredPaceMinutesPerWeek)},${stringOrNull(item.forecastBand)},${stringOrNull(item.confidence)},${dateOrNull(item.forecastThrough)},${numberOrNull(item.expectedMarginMinutes)},${numberOrNull(item.pessimisticMarginMinutes)},${numberOrNull(item.scheduleVariance)},${item.health},${sql.json({ reasons: item.reasons, latestSafeStarts: item.latestSafeStarts } as never)})`;
  }
  await pruneReplacedForecastSnapshots(sql, result, schedule.forecasts ?? []);
  await sql`UPDATE recommendations SET superseded_at=${new Date(result.calculatedAt)} WHERE user_id=${userId} AND superseded_at IS NULL`;
  await pruneSupersededRecommendationCandidates(sql, userId);
  const recommendationId = crypto.randomUUID();
  const primaryAction = recommendation.primary?.action;
  const primaryDeliverableId = stringOrNull(primaryAction?.deliverableId);
  const primaryTargetType = primaryDeliverableId ? "deliverable" : primaryAction ? "action" : "none";
  const primaryActionId = primaryDeliverableId
    ? null
    : stringOrNull(primaryAction?.templateActionId ?? primaryAction?.id);
  const primaryTargetId = primaryDeliverableId ?? primaryActionId;
  await sql`INSERT INTO recommendations (id,user_id,calculated_at,valid_until,input_version,kind,primary_action_id,primary_occurrence_id,target_type,target_id,execution_option_id,planned_minutes,planned_end_at,headline,explanation,reason_data) VALUES (${recommendationId},${userId},${new Date(result.calculatedAt)},${new Date(result.validUntil)},${result.inputVersion},${primaryTargetType},${primaryActionId},${stringOrNull(primaryAction?.occurrenceId)},${primaryTargetType},${primaryTargetId},${stringOrNull(primaryAction?.executionOptionId)},${recommendation.primary?.recommendedMinutes ?? null},${recommendation.primary?.recommendedMinutes ? new Date(new Date(result.calculatedAt).getTime() + recommendation.primary.recommendedMinutes * 60_000) : null},${recommendation.headline ?? "No suitable action"},${recommendation.explanation ?? "The Plan and Forecast Engine returned no explanation."},${sql.json({ evidence: recommendation.evidence ?? [] } as never)})`;
  for (const [index, rawCandidate] of (recommendation.candidates ?? []).entries()) {
    const candidate = rawCandidate as {
      action?: Record<string, unknown>;
      totalScore?: number;
      scoreComponents?: unknown;
      eligible?: boolean;
      exclusionReasons?: unknown;
      recommendedMinutes?: number | null;
    };
    const deliverableId = stringOrNull(candidate.action?.deliverableId);
    const actionId = deliverableId ? null : stringOrNull(candidate.action?.templateActionId ?? candidate.action?.id);
    const targetType = deliverableId ? "deliverable" : "action";
    const targetId = deliverableId ?? actionId;
    if (!targetId) continue;
    await sql`INSERT INTO recommendation_candidates (recommendation_id,action_id,occurrence_id,target_type,target_id,execution_option_id,rank,total_score,score_components,eligible,exclusion_reasons,recommended_minutes) VALUES (${recommendationId},${actionId},${stringOrNull(candidate.action?.occurrenceId)},${targetType},${targetId},${stringOrNull(candidate.action?.executionOptionId)},${index + 1},${candidate.totalScore ?? 0},${sql.json((candidate.scoreComponents ?? {}) as never)},${candidate.eligible ?? false},${sql.json((candidate.exclusionReasons ?? []) as never)},${candidate.recommendedMinutes ?? null}) ON CONFLICT DO NOTHING`;
  }
  // The offer history keeps what was offered after this run's candidates are gone (they are deleted on the next
  // publish, and the recommendation row after a week). Same transaction: a plan that cannot be logged is not published.
  // Only the top five are kept, and a run that offers what the last one did writes nothing (`recordOffered`).
  const offeredCandidates: OfferedCandidate[] = [];
  for (const [index, rawCandidate] of (recommendation.candidates ?? []).entries()) {
    if (offeredCandidates.length >= OFFER_LOG_TOP_CANDIDATES) break;
    const candidate = rawCandidate as {
      action?: Record<string, unknown>;
      totalScore?: number;
      eligible?: boolean;
      recommendedMinutes?: number | null;
    };
    const deliverableId = stringOrNull(candidate.action?.deliverableId);
    const targetId = deliverableId ?? stringOrNull(candidate.action?.templateActionId ?? candidate.action?.id);
    if (!targetId) continue;
    offeredCandidates.push({
      targetType: deliverableId ? "deliverable" : "action",
      targetId,
      executionOptionId: stringOrNull(candidate.action?.executionOptionId),
      rank: index + 1,
      score: candidate.totalScore ?? 0,
      eligible: candidate.eligible ?? false,
      minutes: candidate.recommendedMinutes ?? null
    });
  }
  await recordOffered(sql, userId, {
    recommendationId,
    validUntil: new Date(result.validUntil),
    primary:
      primaryTargetId === null
        ? null
        : {
            targetType: primaryTargetType,
            targetId: primaryTargetId,
            executionOptionId: stringOrNull(primaryAction?.executionOptionId),
            label: stringOrNull(primaryAction?.title)
          },
    candidates: offeredCandidates,
    actor: "system"
  });
  return true;
}

/**
 * The normalized ranking exists so the current recommendation can be queried relationally — which
 * candidates were eligible, at what rank, for how long. Nothing reads a superseded run's candidates:
 * `session-commands` looks them up only for the recommendation that is current when a session
 * starts, and every superseded run keeps its whole ranking inside the JSON `result` on
 * `planning_runs` anyway. Keeping them meant one row per candidate per recalculation, which was over
 * three hundred thousand rows and a third of a gigabyte after ten days for a single user.
 *
 * Only the candidates go. The `recommendations` rows themselves stay for the age-and-cap policy in
 * `plan-retention.ts`, because `sessions.recommendation_id` points at them with ON DELETE SET NULL
 * and removing one would quietly edit an authored session row.
 */
async function pruneSupersededRecommendationCandidates(sql: postgres.Sql, userId: string) {
  await sql`
    DELETE FROM recommendation_candidates
    WHERE recommendation_id IN (
      SELECT id FROM recommendations WHERE user_id=${userId} AND superseded_at IS NOT NULL
    )
  `;
}

/**
 * A forecast row is a project's position under one run, and the run that replaced it has just
 * written a fresher one for the same project. The superseded row is only reachable through the JSON
 * `result` it was derived from, so it is dropped rather than accumulating one row per project per
 * recalculation.
 *
 * Restricting the delete to projects named in this result preserves the invariant retention already
 * relies on: a project the plan no longer forecasts keeps its last known position instead of losing
 * its history the first time it drops out of the plan.
 */
async function pruneReplacedForecastSnapshots(
  sql: postgres.Sql,
  result: PlanForecastResponse,
  forecasts: Array<Record<string, unknown>>
) {
  const projectIds = [
    ...new Set(forecasts.map((item) => item.projectId).filter((id): id is string => typeof id === "string"))
  ];
  if (!projectIds.length) return;
  await sql`
    DELETE FROM forecast_snapshots
    WHERE project_id IN ${sql(projectIds)}
      AND calculated_at < ${new Date(result.calculatedAt)}
  `;
}

/** A derived repeating-commitment row carrying everything the write-back needs to upsert it. */
type DerivedCommitmentRepeatRow = Record<string, unknown> & {
  id: string;
  recurrenceRuleId: string;
  localDate: string;
  startsAt: string;
  endsAt: string;
};

/** `derivedState` crosses the wire as untyped JSON (`jsonValueSchema`), so a row's shape is checked here. */
function isDerivedCommitmentRepeatRow(value: unknown): value is DerivedCommitmentRepeatRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.recurrenceRuleId === "string" &&
    typeof row.localDate === "string" &&
    typeof row.startsAt === "string" &&
    typeof row.endsAt === "string"
  );
}

interface RuleHorizonRow {
  start_date: string;
  end_date: string | null;
  from_date: string;
  through_date: string;
  interval_unit: string;
  interval_days: number | null;
  interval_weeks: number | null;
  weekdays: number[] | null;
  interval_months: number | null;
  month_anchor: string | null;
}

/**
 * Whether a rule's own repeat lands on any local day the engine scans for this run, using the same
 * `commitmentRepeatFallsOn` the engine expands with. The engine (`resolveCommitmentRecurrenceRepeats`)
 * scans one extra local day each side of today..horizon's last day, because a moved (`custom`)
 * occurrence may land on the boundary day from just outside it; so does this, which keeps the guard
 * failing toward "do not prune" for a moved occurrence the engine should have emitted. The range is
 * still clamped to the rule's own start/end dates, as the engine does. At most ~183 day checks per rule.
 * A row whose repeat columns cannot be read as a repeat is reported as placing one: the guard this
 * feeds only ever skips a delete, so "cannot tell" must not unlock it.
 */
function rulePlacesOccurrenceInHorizon(row: RuleHorizonRow): boolean {
  const repeat = repeatOfRuleRow(row);
  if (!repeat) return true;
  const scanFrom = addLocalDays(row.from_date, -1);
  const scanThrough = addLocalDays(row.through_date, 1);
  const first = row.start_date > scanFrom ? row.start_date : scanFrom;
  const last = row.end_date !== null && row.end_date < scanThrough ? row.end_date : scanThrough;
  for (let day = first; day <= last; day = addLocalDays(day, 1)) {
    if (commitmentRepeatFallsOn(repeat, row.start_date, day)) return true;
  }
  return false;
}

function repeatOfRuleRow(row: RuleHorizonRow): CommitmentRepeat | undefined {
  if (row.interval_unit === "days")
    return row.interval_days === null ? undefined : { unit: "days", intervalDays: row.interval_days };
  if (row.interval_unit === "weeks")
    return row.interval_weeks === null || !Array.isArray(row.weekdays)
      ? undefined
      : { unit: "weeks", intervalWeeks: row.interval_weeks, weekdays: row.weekdays };
  if (row.interval_unit === "months")
    return row.interval_months === null || row.month_anchor === null
      ? undefined
      : {
          unit: "months",
          intervalMonths: row.interval_months,
          anchor: row.month_anchor as Extract<CommitmentRepeat, { unit: "months" }>["anchor"]
        };
  return undefined;
}

export async function persistDerivedState(sql: postgres.Sql, userId: string, result: PlanForecastResponse) {
  const sleeps = result.derivedState.sleepPlans as Array<Record<string, unknown>>;
  // A `planned` row carrying an answer (`stay_up_answer_minutes`/`placement_choice`) is kept across
  // this sweep-and-reinsert, same as an override, until its wake has actually passed — otherwise a
  // recorded "not tonight" or "keep this night" would vanish on the very next recalculation
  // Measured against this run's own `calculatedAt`,
  // not `CURRENT_TIMESTAMP`, matching the sibling cleanup this run already does the same way
  // (`pruneReplacedForecastSnapshots`, `sweepMootRoutineSteps`, `archiveExpiredOneOffPlaces`): a run
  // computed against a past or replayed instant sweeps consistently with everything else it touches,
  // rather than against whatever the wall clock happens to read when this statement executes.
  const calculatedAt = new Date(result.calculatedAt);
  await sql`DELETE FROM sleep_plans WHERE user_id=${userId} AND status='planned' AND COALESCE(input_version,'')<>'override' AND (stay_up_answer_minutes IS NULL AND placement_choice IS NULL OR planned_wake_at <= ${calculatedAt})`;
  for (const sleep of sleeps) {
    if (
      typeof sleep.id !== "string" ||
      typeof sleep.plannedStartAt !== "string" ||
      typeof sleep.plannedWakeAt !== "string"
    )
      continue;
    const evidence = {
      targetMinutes: sleep.targetMinutes,
      minimumShortfallMinutes: sleep.minimumShortfallMinutes,
      replannedFromMissedStart: sleep.replannedFromMissedStart,
      wakeConstraint: sleep.wakeConstraint,
      deviationOptions: sleep.deviationOptions
    };
    // Belt-and-braces against the engine ever again handing this an off-identity row for a decided
    // plan: whatever the incoming values say, a row already `sleeping` or `completed` here is frozen —
    // status, actuals, and every other evidentiary column (allowed_minutes, planned_wake_at,
    // sleep_deficit_minutes, hard_errors, explanation, score_components) all stay exactly as stored.
    // Ending a sleep, or correcting a completed one's logged duration via sleep_log_entry, is a
    // deliberate user action that goes through its own write path, never a side effect of an unrelated
    // recalculation replaying this table — and (see engine/core/src/engine.ts's `decided` branch) once
    // fixed there the engine itself echoes those columns back unchanged for such a row, so this is a
    // second, independent line of defence rather than the only one. `cancelled` keeps the narrower,
    // pre-existing escape hatch (freeze only when `planned_start_at` didn't move) rather than the same
    // blanket freeze: an abandoned missed-start attempt reuses its row's id for the next attempt at the
    // same night, and that legitimate revival is exactly a `cancelled` row whose freshly calculated
    // `planned_start_at` *has* moved — the one case that must still fall through to the fresh values.
    const frozen = sql`(sleep_plans.status IN ('sleeping','completed') OR (sleep_plans.status='cancelled' AND sleep_plans.planned_start_at IS NOT DISTINCT FROM EXCLUDED.planned_start_at))`;
    // Finding 24: `input_version` and `desired_minutes` used to sit outside this upsert's UPDATE branch
    // entirely, so ON CONFLICT never touched them at all — a row's `input_version` was fixed forever at
    // whatever it was the moment the row was first created. That is invisible for an ordinary row
    // (a non-'override' 'planned' row is deleted and reinserted fresh every run, above, so it never
    // hits this branch), but the one row category that always *does* hit UPDATE — a still-'planned'
    // 'override' row, which the DELETE above deliberately spares — could then never lose 'override',
    // because nothing ever wrote a different value over it. The sleep editor (entity-commands.ts,
    // `sleep_plan` entity) is the only write path that sets 'override', and it never clears it either,
    // so a bedtime pushed back once stayed pinned to that stale `desired_minutes` and timing every
    // night afterwards, long after the overridden night had come and gone unslept.
    //
    // The rule chosen here: an override stands — protected exactly like `frozen` above — for as long
    // as its window is still live, i.e. until either the user's own edit changes it or it actually
    // starts ('sleeping', which `frozen` already covers). Once its planned_wake_at has passed while
    // the row is still merely 'planned', the bedtime was never acted on and the override has nothing
    // left to protect: releasing it here lets `input_version` fall through to this run's own value, so
    // the DELETE above (`status='planned' AND input_version<>'override'`) sweeps the now-stale row away
    // on the very next run and a genuinely fresh candidate takes its place, rather than pinning it shut
    // forever.
    const overrideLapsed =
      sleep.overridden === true &&
      sleep.status !== "sleeping" &&
      new Date(sleep.plannedWakeAt).getTime() <= new Date(result.calculatedAt).getTime();
    const inputVersion = sleep.overridden === true && !overrideLapsed ? "override" : result.inputVersion;
    const stayUpAnswerMinutes = numberOrNull(sleep.stayUpAnswerMinutes);
    const placementChoice =
      sleep.placementChoice === "early" || sleep.placementChoice === "near" ? sleep.placementChoice : null;
    const sleepUpsert = guardedConflictUpdate(sql, "sleep_plans", [
      [
        "planned_start_at",
        sql`CASE WHEN ${frozen} THEN sleep_plans.planned_start_at ELSE EXCLUDED.planned_start_at END`
      ],
      ["planned_wake_at", sql`CASE WHEN ${frozen} THEN sleep_plans.planned_wake_at ELSE EXCLUDED.planned_wake_at END`],
      ["desired_minutes", sql`CASE WHEN ${frozen} THEN sleep_plans.desired_minutes ELSE EXCLUDED.desired_minutes END`],
      ["allowed_minutes", sql`CASE WHEN ${frozen} THEN sleep_plans.allowed_minutes ELSE EXCLUDED.allowed_minutes END`],
      [
        "sleep_deficit_minutes",
        sql`CASE WHEN ${frozen} THEN sleep_plans.sleep_deficit_minutes ELSE EXCLUDED.sleep_deficit_minutes END`
      ],
      ["hard_errors", sql`CASE WHEN ${frozen} THEN sleep_plans.hard_errors ELSE EXCLUDED.hard_errors END`],
      ["explanation", sql`CASE WHEN ${frozen} THEN sleep_plans.explanation ELSE EXCLUDED.explanation END`],
      [
        "score_components",
        sql`CASE WHEN ${frozen} THEN sleep_plans.score_components ELSE EXCLUDED.score_components END`
      ],
      ["status", sql`CASE WHEN ${frozen} THEN sleep_plans.status ELSE EXCLUDED.status END`],
      ["input_version", sql`CASE WHEN ${frozen} THEN sleep_plans.input_version ELSE EXCLUDED.input_version END`],
      ["actual_start_at", sql`CASE WHEN ${frozen} THEN sleep_plans.actual_start_at ELSE NULL END`],
      ["actual_wake_at", sql`CASE WHEN ${frozen} THEN sleep_plans.actual_wake_at ELSE NULL END`],
      [
        "stay_up_answer_minutes",
        sql`CASE WHEN ${frozen} THEN sleep_plans.stay_up_answer_minutes ELSE COALESCE(EXCLUDED.stay_up_answer_minutes,sleep_plans.stay_up_answer_minutes) END`
      ],
      [
        "placement_choice",
        sql`CASE WHEN ${frozen} THEN sleep_plans.placement_choice ELSE COALESCE(EXCLUDED.placement_choice,sleep_plans.placement_choice) END`
      ]
    ]);
    await sql`INSERT INTO sleep_plans (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,sleep_deficit_minutes,anchor_deviation_minutes,hard_errors,explanation,status,input_version,score_components,stay_up_answer_minutes,placement_choice) VALUES (${sleep.id},${userId},${new Date(sleep.plannedStartAt)},${new Date(sleep.plannedWakeAt)},${numberOrNull(sleep.desiredMinutes) ?? 0},${numberOrNull(sleep.allowedMinutes) ?? 0},${numberOrNull(sleep.sleepDeficitMinutes) ?? 0},${numberOrNull(sleep.anchorDeviationMinutes) ?? 0},${sql.json((sleep.hardErrors ?? []) as never)},${typeof sleep.explanation === "string" ? sleep.explanation : "Calculated by the Plan and Forecast Engine."},${sleep.status === "sleeping" ? "sleeping" : "planned"},${inputVersion},${sql.json(evidence as never)},${stayUpAnswerMinutes},${placementChoice}) ON CONFLICT (id) DO UPDATE SET ${sleepUpsert.set} WHERE ${sleepUpsert.changed}`;
  }
  const resolvedOccurrenceIds: string[] = [];
  for (const occurrence of result.derivedState.occurrences as Array<Record<string, unknown>>) {
    if (
      typeof occurrence.id !== "string" ||
      typeof occurrence.actionId !== "string" ||
      typeof occurrence.recurrenceRuleId !== "string" ||
      typeof occurrence.windowId !== "string" ||
      typeof occurrence.windowStartsAt !== "string" ||
      typeof occurrence.windowEndsAt !== "string" ||
      typeof occurrence.localDate !== "string"
    )
      continue;
    resolvedOccurrenceIds.push(occurrence.id);
    await upsertActionOccurrence(sql, {
      id: occurrence.id,
      actionId: occurrence.actionId,
      ruleId: occurrence.recurrenceRuleId,
      windowId: occurrence.windowId,
      localDate: occurrence.localDate,
      windowStartsAt: new Date(occurrence.windowStartsAt),
      windowEndsAt: new Date(occurrence.windowEndsAt),
      anchorSource: typeof occurrence.anchorSource === "string" ? occurrence.anchorSource : "local_time",
      status: typeof occurrence.status === "string" ? occurrence.status : "pending",
      routineCovered: occurrence.routineCovered === true
    });
  }
  await dropSupersededOccurrences(sql, userId, resolvedOccurrenceIds, new Date(result.calculatedAt));
  const commitmentOccurrenceIds: string[] = [];
  // A newly materialised occurrence copies its rule's routine source at insert time; the conflict
  // branch deliberately leaves both columns alone so a per-occurrence override survives replans.
  // Presence used to be written unconditionally on both branches — the engine derives it from the
  // rule for every occurrence, and healing on conflict is what lets a rule switched to 'anchor' reach
  // the future rows it already materialised — but that left no way for a single occurrence's own
  // engagement-level edit to survive the next replan. presence_source is the same
  // inherit/custom split as routine_source, just narrower: an 'inherit' row (the default, and every
  // row this loop freshly inserts) keeps healing from the rule on conflict; a 'custom' row — one an
  // occurrence-level save pinned directly — is left alone, the same one-way detach, and
  // presence_source itself is never written here on conflict so it only ever moves to 'custom' from
  // an explicit edit (entity-commands.ts), never back.
  // share_to_calendar/share_source (family calendar sharing) follow the exact same
  // inherit/custom shape as presence/presence_source: every freshly inserted row copies the rule's
  // share_to_calendar with share_source='inherit'; the conflict branch only heals share_to_calendar
  // from the rule when the existing row is still 'inherit', and share_source itself is never written
  // here on conflict so it only ever moves to 'custom' from an explicit occurrence-level edit
  // (entity-commands.ts), never back.
  // schedule_source guards the wider overlay: title, starts_at, ends_at, location, location_id,
  // setup_before_minutes, transition_after_minutes, project_id, lateness_matters, transport_mode and
  // contact_id. The engine already emits the occurrence's overlaid values (custom rows are folded in
  // before this loop runs, `commitment-timeline.md`'s "Recurring occurrences carry their per-date
  // facts"), so this guard only matters when an edit lands between the run's read and its persist —
  // the supersede race described for another table. Every freshly inserted row is 'inherit'; the conflict
  // branch heals all of those columns from EXCLUDED only while the stored row is still 'inherit', and
  // keeps the stored values once it is 'custom'. schedule_source itself is never written here on
  // conflict, so a row only ever moves to 'custom' from an explicit occurrence or series edit
  // (entity-commands.ts, recurrence-commands.ts), never back — the same one-way detach as
  // presence_source and share_source, just wider.
  // "Future" is judged by the run's own clock, as everywhere else in this function: the engine resolved
  // `commitmentRepeats` from `calculatedAt`, and the persist can land well after it.
  const resolvedFrom = new Date(result.calculatedAt);
  // `inHorizon` is "this rule can produce an occurrence inside the horizon this run asked the engine to
  // expand" (`rulePlacesOccurrenceIn`): active, and its own recurrence lands on at least one local day
  // between the day before today and the day after the horizon's last day (the engine's own scan, one
  // extra local day each side), in the rule's timezone. It is only read to decide whether
  // an empty derived list can be believed, below. A rule that starts after the horizon, or whose next
  // occurrence is past it (a long interval), legitimately yields nothing here.
  const horizonThrough = new Date(resolvedFrom.getTime() + PLAN_FORECAST_HORIZON_DAYS * 86_400_000 - 1);
  const ruleRoutineRows = await sql<
    {
      id: string;
      routine_source: string;
      routine_preset_id: string | null;
      share_to_calendar: boolean;
      live: boolean;
      start_date: string;
      end_date: string | null;
      from_date: string;
      through_date: string;
      interval_unit: string;
      interval_days: number | null;
      interval_weeks: number | null;
      weekdays: number[] | null;
      interval_months: number | null;
      month_anchor: string | null;
    }[]
  >`
    SELECT id,routine_source,routine_preset_id,share_to_calendar,
      (status='active' AND (end_date IS NULL OR end_date >= (${resolvedFrom}::timestamptz AT TIME ZONE timezone)::date - 1)) AS live,
      start_date::text AS start_date, end_date::text AS end_date,
      ((${resolvedFrom}::timestamptz AT TIME ZONE timezone)::date)::text AS from_date,
      ((${horizonThrough}::timestamptz AT TIME ZONE timezone)::date)::text AS through_date,
      interval_unit::text AS interval_unit, interval_days, interval_weeks, weekdays, interval_months,
      month_anchor::text AS month_anchor
    FROM commitment_recurrence_rules WHERE user_id=${userId}
  `;
  const ruleRoutines = new Map(ruleRoutineRows.map((row) => [row.id, row]));
  const horizonRuleCount = ruleRoutineRows.filter((row) => row.live && rulePlacesOccurrenceInHorizon(row)).length;
  const derivedCommitmentRepeats = (result.derivedState.commitmentRepeats ?? []) as unknown[];
  let malformedCommitmentRepeats = 0;
  for (const candidate of derivedCommitmentRepeats) {
    if (!isDerivedCommitmentRepeatRow(candidate)) {
      malformedCommitmentRepeats += 1;
      continue;
    }
    const occurrence = candidate;
    commitmentOccurrenceIds.push(occurrence.id);
    const ruleRoutine = ruleRoutines.get(occurrence.recurrenceRuleId);
    // Each column keeps its stored value while its source flag says the user owns it, and otherwise
    // takes the planner's. `schedule_source` guards the schedule columns; presence and sharing have
    // their own flags (all three are NOT NULL, 'inherit' | 'custom').
    const followsPlanner = (column: string, ownedWhen: postgres.PendingQuery<postgres.Row[]>) =>
      [column, sql`CASE WHEN ${ownedWhen} THEN commitments.${sql(column)} ELSE EXCLUDED.${sql(column)} END`] as const;
    const scheduleCustom = sql`commitments.schedule_source='custom'`;
    const commitmentUpsert = guardedConflictUpdate(sql, "commitments", [
      followsPlanner("title", scheduleCustom),
      followsPlanner("starts_at", scheduleCustom),
      followsPlanner("ends_at", scheduleCustom),
      followsPlanner("location", scheduleCustom),
      followsPlanner("location_id", scheduleCustom),
      followsPlanner("setup_before_minutes", scheduleCustom),
      followsPlanner("transition_after_minutes", scheduleCustom),
      followsPlanner("presence", sql`commitments.presence_source<>'inherit'`),
      followsPlanner("share_to_calendar", sql`commitments.share_source<>'inherit'`),
      followsPlanner("project_id", scheduleCustom),
      followsPlanner("lateness_matters", scheduleCustom),
      followsPlanner("transport_mode", scheduleCustom),
      followsPlanner("contact_id", scheduleCustom)
    ]);
    await sql`INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status,location,location_id,setup_before_minutes,transition_after_minutes,presence,presence_source,recurrence_rule_id,local_date,project_id,routine_source,routine_preset_id,share_to_calendar,share_source,schedule_source,lateness_matters,transport_mode,contact_id) VALUES (${occurrence.id},${userId},${stringOrNull(occurrence.title) ?? "Commitment"},${new Date(occurrence.startsAt)},${new Date(occurrence.endsAt)},${typeof occurrence.status === "string" ? occurrence.status : "confirmed"},${stringOrNull(occurrence.location)},${stringOrNull(occurrence.locationId)},${numberOrNull(occurrence.setupBeforeMinutes) ?? 0},${numberOrNull(occurrence.transitionAfterMinutes) ?? 0},${stringOrNull(occurrence.presence) ?? "blocking"},'inherit',${occurrence.recurrenceRuleId},${occurrence.localDate},${stringOrNull(occurrence.projectId)},${ruleRoutine?.routine_source ?? "inherit"},${ruleRoutine?.routine_preset_id ?? null},${ruleRoutine?.share_to_calendar ?? false},'inherit','inherit',${occurrence.latenessMatters === false ? false : true},${stringOrNull(occurrence.transportMode)},${stringOrNull(occurrence.contactId)}) ON CONFLICT (id) DO UPDATE SET ${commitmentUpsert.set} WHERE ${commitmentUpsert.changed}`;
  }
  // routine_steps has ON DELETE CASCADE from commitments, so dropping a no-longer-resolved
  // future occurrence (its rule ended, was edited off this date, or simply fell out of this run's
  // window) would silently take any prep already done for it along too — a step marked 'doing' or
  // 'completed' ahead of the commitment itself, which the pre-commitment routine model explicitly
  // allows. 'pending' steps carry no such evidence and 'cancelled' ones were already withdrawn, so
  // only those two statuses stay deletable; anything else pins the commitment in place until whatever
  // step is stuck gets resolved through its own path.
  const routineStepsActedOn = sql`
    NOT EXISTS (
      SELECT 1 FROM routine_steps s
      WHERE s.commitment_id=commitments.id AND s.status NOT IN ('pending','cancelled')
    )
  `;
  // A date restored on its own while its rule is still ended is the person's (`custom`): it is not pruned either.
  const restoredDateOfEndedRule = sql`
    NOT (schedule_source='custom' AND EXISTS (
      SELECT 1 FROM commitment_recurrence_rules r WHERE r.id=commitments.recurrence_rule_id AND r.status='ended'))
  `;
  // A closed (cancelled) occurrence is never pruned: ending a rule, or a person's own cancel, closes it for good and
  // restoring it needs the row (archive-removals design section 7). The delete below leaves such rows alone.
  // The delete below treats the derived list as the complete set of surviving future occurrences, so it
  // is only as safe as the list is trustworthy. Two shapes of list are not, and each skips the delete
  // for this run (the upserts above still applied — they only ever add or heal a row the engine named,
  // so a bad row costs nothing there; the next clean run prunes whatever is stale):
  //   - any malformed row: its occurrence id is unknown, so an id that should survive may be missing
  //     from `commitmentOccurrenceIds` and its stored row would be deleted (with its routine
  //     steps' evidence for anything not yet acted on);
  //   - an empty list while some rule should have yielded inside the horizon: none at all then means the
  //     derivation failed, not that every future occurrence is gone. A rule that ended, or whose next
  //     occurrence is past the horizon (an edit moved its start later, a long interval), is not evidence,
  //     so a user who really ended or moved their last rule still has the leftover future rows swept.
  const pruneUser = { userId, requestId: result.requestId };
  let pruneFutureCommitments = true;
  if (malformedCommitmentRepeats > 0) {
    pruneFutureCommitments = false;
    console.error(
      JSON.stringify({
        level: "error",
        message: "Derived repeating commitments were malformed; skipped pruning future commitments this run",
        ...pruneUser,
        malformedCount: malformedCommitmentRepeats,
        derivedCount: derivedCommitmentRepeats.length
      })
    );
  } else if (commitmentOccurrenceIds.length === 0 && horizonRuleCount > 0) {
    pruneFutureCommitments = false;
    console.warn(
      JSON.stringify({
        level: "warn",
        message:
          "Derived repeating commitments were empty while recurrence rules should yield inside the horizon; skipped pruning future commitments this run",
        ...pruneUser,
        horizonRuleCount
      })
    );
  }
  if (pruneFutureCommitments) {
    const deleted = commitmentOccurrenceIds.length
      ? await sql<
          { id: string }[]
        >`DELETE FROM commitments WHERE user_id=${userId} AND recurrence_rule_id IS NOT NULL AND starts_at>${resolvedFrom} AND id NOT IN ${sql(commitmentOccurrenceIds)} AND status<>'cancelled' AND ${restoredDateOfEndedRule} AND ${routineStepsActedOn} RETURNING id`
      : await sql<
          { id: string }[]
        >`DELETE FROM commitments WHERE user_id=${userId} AND recurrence_rule_id IS NOT NULL AND starts_at>${resolvedFrom} AND status<>'cancelled' AND ${restoredDateOfEndedRule} AND ${routineStepsActedOn} RETURNING id`;
    if (deleted.length > 0)
      console.info(
        JSON.stringify({
          level: "info",
          message: "Pruned future repeating commitments no longer derived by the plan",
          ...pruneUser,
          deletedCount: deleted.length,
          deletedIds: deleted.slice(0, 200).map((row) => row.id),
          ...(deleted.length > 200 ? { deletedIdsTruncated: true } : {})
        })
      );
  }
  // The engine is the only placer now: it has already derived
  // which commitment-anchored routine steps exist and where they are placed, in `derivedState.routineSteps`
  // (mirrored below). The persist has nothing left to compute from a journey's minutes.
  await syncCommitmentRoutineSteps(
    sql,
    userId,
    new Date(result.calculatedAt),
    result.derivedState.routineSteps as Array<Record<string, unknown>>
  );
  // Backstop for the write-time skip's one edge-triggered chance — see
  // routine-step-mootness.ts.
  await sweepMootRoutineSteps(sql, userId, new Date(result.calculatedAt));
  await archiveExpiredOneOffPlaces(sql, userId, new Date(result.calculatedAt));
  await syncSleepRoutineSteps(sql, userId, result.derivedState.routineSteps as Array<Record<string, unknown>>);
}

/** One commitment-anchored step as the engine's `deriveCommitmentRoutineSteps` returns it in
 *  `derivedState.routineSteps` — the engine's own final row for that step, already reconciled and,
 *  once `applyPlacement` has run, placed. */
interface DerivedCommitmentRoutineStep {
  id: string;
  commitmentId: string;
  title: string;
  durationMinutes: number;
  sequence: number;
  timingRule: "contiguous" | "flexible";
  maxLeadMinutes: number | null;
  energy: string;
  phase: "before" | "after";
  contexts: string[];
  dependencyIds: string[];
  actionWindowId: string | null;
  cadenceActionId: string | null;
  presetStepId: string | null;
  status: string;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  waitAfterMinutes: number;
  mustStartByMinutes: number | null;
  preferredBands: string[];
}

function readDerivedCommitmentRoutineStep(value: Record<string, unknown>): DerivedCommitmentRoutineStep | undefined {
  if (
    value.anchorType === "sleep_plan" ||
    typeof value.id !== "string" ||
    typeof value.commitmentId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.durationMinutes !== "number" ||
    typeof value.sequence !== "number"
  )
    return undefined;
  return {
    id: value.id,
    commitmentId: value.commitmentId,
    title: value.title,
    durationMinutes: value.durationMinutes,
    sequence: value.sequence,
    timingRule: value.timingRule === "flexible" ? "flexible" : "contiguous",
    maxLeadMinutes: typeof value.maxLeadMinutes === "number" ? value.maxLeadMinutes : null,
    energy: typeof value.energy === "string" ? value.energy : "low",
    phase: value.phase === "after" ? "after" : "before",
    contexts: contextList(value.contexts),
    dependencyIds: Array.isArray(value.dependencyIds)
      ? value.dependencyIds.filter((item): item is string => typeof item === "string")
      : [],
    actionWindowId: typeof value.actionWindowId === "string" ? value.actionWindowId : null,
    cadenceActionId: typeof value.cadenceActionId === "string" ? value.cadenceActionId : null,
    presetStepId: typeof value.presetStepId === "string" ? value.presetStepId : null,
    status: typeof value.status === "string" ? value.status : "pending",
    scheduledStartAt: typeof value.scheduledStartAt === "string" ? new Date(value.scheduledStartAt) : null,
    scheduledEndAt: typeof value.scheduledEndAt === "string" ? new Date(value.scheduledEndAt) : null,
    waitAfterMinutes: typeof value.waitAfterMinutes === "number" ? value.waitAfterMinutes : 0,
    mustStartByMinutes: typeof value.mustStartByMinutes === "number" ? value.mustStartByMinutes : null,
    preferredBands: contextList(value.preferredBands)
  };
}

interface StoredCommitmentStepRow {
  id: string;
  commitment_id: string;
  sequence: number;
  title: string;
  duration_minutes: number;
  timing_rule: string;
  max_lead_minutes: number | null;
  energy: string;
  phase: string;
  contexts: unknown;
  action_window_id: string | null;
  cadence_action_id: string | null;
  preset_step_id: string | null;
  status: string;
  scheduled_start_at: Date | null;
  scheduled_end_at: Date | null;
  wait_after_minutes: number;
  must_start_by_minutes: number | null;
  preferred_bands: unknown;
}

function toCommitmentRoutineStepInput(row: DerivedCommitmentRoutineStep): CommitmentRoutineStepInput {
  return {
    title: row.title,
    durationMinutes: row.durationMinutes,
    timingRule: row.timingRule,
    maxLeadMinutes: row.maxLeadMinutes,
    energy: row.energy,
    phase: row.phase,
    contexts: row.contexts,
    actionWindowId: row.actionWindowId,
    cadenceActionId: row.cadenceActionId,
    presetStepId: row.presetStepId,
    dependsOn: [],
    status: "pending",
    scheduledStartAt: row.scheduledStartAt,
    scheduledEndAt: row.scheduledEndAt,
    waitAfterMinutes: row.waitAfterMinutes,
    mustStartByMinutes: row.mustStartByMinutes,
    preferredBands: row.preferredBands
  };
}

function commitmentStepMatches(
  stored: StoredCommitmentStepRow,
  engineRow: DerivedCommitmentRoutineStep,
  dependsOnIds: readonly string[]
): boolean {
  const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
  const sameSet = (a: readonly string[], b: readonly string[]) => {
    const left = [...a].sort();
    const right = [...b].sort();
    return left.length === right.length && left.every((item, index) => item === right[index]);
  };
  const sameSequence = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((item, index) => item === b[index]);
  return (
    stored.sequence === engineRow.sequence &&
    stored.title === engineRow.title &&
    stored.duration_minutes === engineRow.durationMinutes &&
    stored.timing_rule === engineRow.timingRule &&
    stored.max_lead_minutes === engineRow.maxLeadMinutes &&
    stored.energy === engineRow.energy &&
    stored.phase === engineRow.phase &&
    sameSequence(contextList(stored.contexts), engineRow.contexts) &&
    stored.action_window_id === engineRow.actionWindowId &&
    stored.cadence_action_id === engineRow.cadenceActionId &&
    stored.preset_step_id === engineRow.presetStepId &&
    sameSet(dependsOnIds, engineRow.dependencyIds) &&
    sameTime(stored.scheduled_start_at, engineRow.scheduledStartAt) &&
    sameTime(stored.scheduled_end_at, engineRow.scheduledEndAt) &&
    stored.wait_after_minutes === engineRow.waitAfterMinutes &&
    (stored.must_start_by_minutes ?? null) === engineRow.mustStartByMinutes &&
    sameSequence(contextList(stored.preferred_bands), engineRow.preferredBands)
  );
}

/**
 * Diffs one candidate commitment's stored `routine_steps` rows against the engine's own final rows
 * for that commitment (`derivedState.routineSteps`, already reconciled and placed) — "equivalent to
 * re-running the reconciliation with the engine's rows as template and ids"
 * except the diff is by id directly rather than by re-deriving
 * a preset template: the engine has already done that work, and its output for a matched (kept or
 * reseq'd) row always carries the same id the stored row has. An engine row with no stored match is a
 * fresh insert (already placed, if pending). A stored pending row matched to an engine row is updated
 * to its content and placement; matched but already identical, it is kept untouched. A stored locked
 * (non-pending) row matched to an engine row only ever moves its `sequence` (`reseq`), never its
 * content or times. A stored pending row with no engine match at all was reconciled away — `delete`.
 */
function buildCommitmentReconciliationOps(
  storedRows: readonly StoredCommitmentStepRow[],
  engineRows: readonly DerivedCommitmentRoutineStep[],
  dependsOnIdsByStepId: ReadonlyMap<string, string[]>
): RoutineStepPlanOp[] {
  const storedById = new Map(storedRows.map((row) => [row.id, row]));
  const matchedStoredIds = new Set<string>();
  const ops: RoutineStepPlanOp[] = [];
  engineRows.forEach((engineRow, index) => {
    const stored = storedById.get(engineRow.id);
    if (!stored) {
      ops.push({
        kind: "insert",
        id: engineRow.id,
        templateIndex: index,
        sequence: engineRow.sequence,
        step: toCommitmentRoutineStepInput(engineRow),
        dependsOnIds: engineRow.dependencyIds
      });
      return;
    }
    matchedStoredIds.add(stored.id);
    if (stored.status !== "pending") {
      ops.push(
        stored.sequence === engineRow.sequence
          ? { kind: "keep", id: stored.id }
          : { kind: "reseq", id: stored.id, sequence: engineRow.sequence }
      );
      return;
    }
    const currentDependsOnIds = dependsOnIdsByStepId.get(stored.id) ?? [];
    ops.push(
      commitmentStepMatches(stored, engineRow, currentDependsOnIds)
        ? { kind: "keep", id: stored.id }
        : {
            kind: "update",
            id: stored.id,
            templateIndex: index,
            sequence: engineRow.sequence,
            step: toCommitmentRoutineStepInput(engineRow),
            dependsOnIds: engineRow.dependencyIds
          }
    );
  });
  for (const stored of storedRows) {
    if (matchedStoredIds.has(stored.id)) continue;
    if (stored.status === "pending") ops.push({ kind: "delete", id: stored.id });
  }
  return ops;
}

/**
 * Mirrors the engine's own commitment-anchored routine steps (`derivedState.routineSteps`, already
 * reconciled and placed this run — the routine step timing design note) into `routine_steps`,
 * replacing `syncInheritedRoutineSteps`'s database-side preset resolution and scheduling entirely: the
 * engine is the only author of which steps exist and where they are placed now.
 *
 * A **candidate** commitment (the same filter the engine uses: not cancelled, `starts_at>now`,
 * `routine_source<>'custom'` — by this point in the persist every regenerated occurrence already
 * exists as a `commitments` row, so the filter reaches them too) gets its full row set
 * reconciled against the engine's own rows for it (`buildCommitmentReconciliationOps`). Every other
 * commitment whose rows the engine emitted (custom, already started, tentative) is not a candidate for
 * existence changes — its steps pass through unchanged — but a pending one may still have moved: the
 * engine places every pending step it emits regardless of candidacy, so its `scheduled_start_at`/
 * `scheduled_end_at` are written directly, guarded by `status='pending'`.
 *
 * Write-back only (one-write-path invariant 3): no `write_rows` row, no job enqueued.
 */
export async function syncCommitmentRoutineSteps(
  sql: postgres.Sql,
  userId: string,
  now: Date,
  derivedRoutineSteps: Array<Record<string, unknown>>
): Promise<void> {
  const derived = derivedRoutineSteps
    .map(readDerivedCommitmentRoutineStep)
    .filter((step): step is DerivedCommitmentRoutineStep => step !== undefined);
  const derivedByCommitment = new Map<string, DerivedCommitmentRoutineStep[]>();
  for (const step of derived) {
    const list = derivedByCommitment.get(step.commitmentId) ?? [];
    list.push(step);
    derivedByCommitment.set(step.commitmentId, list);
  }
  const candidateRows = await sql<{ id: string }[]>`
    SELECT id FROM commitments
    WHERE user_id=${userId} AND starts_at>${now} AND status<>'cancelled' AND routine_source<>'custom'
  `;
  const candidateIds = new Set(candidateRows.map((row) => row.id));
  const commitmentIds = new Set<string>([...candidateIds, ...derivedByCommitment.keys()]);
  if (!commitmentIds.size) return;
  const commitmentIdList = [...commitmentIds];
  const stepRows = await sql<StoredCommitmentStepRow[]>`
    SELECT id,commitment_id,sequence,title,duration_minutes,timing_rule,max_lead_minutes,energy,phase,contexts,action_window_id,cadence_action_id,preset_step_id,status,scheduled_start_at,scheduled_end_at,wait_after_minutes,must_start_by_minutes,preferred_bands
    FROM routine_steps WHERE commitment_id IN ${sql(commitmentIdList)}
    ORDER BY commitment_id, sequence, id
  `;
  const stepEdges = stepRows.length
    ? await sql<{ step_id: string; depends_on_step_id: string }[]>`
        SELECT d.step_id,d.depends_on_step_id FROM routine_step_dependencies d
        JOIN routine_steps s ON s.id=d.step_id
        WHERE s.commitment_id IN ${sql(commitmentIdList)}
      `
    : [];
  const dependsOnIdsByStepId = new Map<string, string[]>();
  for (const edge of stepEdges) {
    const list = dependsOnIdsByStepId.get(edge.step_id) ?? [];
    list.push(edge.depends_on_step_id);
    dependsOnIdsByStepId.set(edge.step_id, list);
  }
  const stepsByCommitment = new Map<string, StoredCommitmentStepRow[]>();
  for (const row of stepRows) {
    const list = stepsByCommitment.get(row.commitment_id) ?? [];
    list.push(row);
    stepsByCommitment.set(row.commitment_id, list);
  }
  for (const commitmentId of commitmentIds) {
    const engineRows = (derivedByCommitment.get(commitmentId) ?? []).slice().sort((a, b) => a.sequence - b.sequence);
    const storedRows = stepsByCommitment.get(commitmentId) ?? [];
    if (candidateIds.has(commitmentId)) {
      const ops = buildCommitmentReconciliationOps(storedRows, engineRows, dependsOnIdsByStepId);
      if (ops.some((op) => op.kind !== "keep"))
        await applyRoutineStepPlan(
          sql,
          userId,
          { anchorType: "commitment", anchorId: commitmentId, commitmentId },
          { ops, changed: true, finalSteps: [] }
        );
      continue;
    }
    for (const row of engineRows) {
      if (row.status !== "pending" || !row.scheduledStartAt || !row.scheduledEndAt) continue;
      await sql`
        UPDATE routine_steps SET scheduled_start_at=${row.scheduledStartAt},scheduled_end_at=${row.scheduledEndAt},updated_at=CURRENT_TIMESTAMP
        WHERE id=${row.id} AND status='pending'
          AND (scheduled_start_at,scheduled_end_at) IS DISTINCT FROM (${row.scheduledStartAt},${row.scheduledEndAt})
      `;
    }
  }
}

/** One bedtime/wake step as the engine's `deriveSleepRoutineSteps` returns it in `derivedState.routineSteps`. */
interface DerivedSleepRoutineStep {
  id: string;
  anchorId: string;
  purpose: "bedtime" | "wake";
  title: string;
  durationMinutes: number;
  sequence: number;
  timingRule: "contiguous" | "flexible";
  maxLeadMinutes: number | null;
  energy: string;
  phase: "before" | "after";
  contexts: string[];
  actionWindowId: string | null;
  cadenceActionId: string | null;
  presetStepId: string | null;
  status: "pending" | "skipped";
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  waitAfterMinutes: number;
  mustStartByMinutes: number | null;
  preferredBands: string[];
}

function readDerivedSleepRoutineStep(value: Record<string, unknown>): DerivedSleepRoutineStep | undefined {
  if (
    value.anchorType !== "sleep_plan" ||
    typeof value.id !== "string" ||
    typeof value.anchorId !== "string" ||
    (value.purpose !== "bedtime" && value.purpose !== "wake") ||
    typeof value.title !== "string" ||
    typeof value.durationMinutes !== "number" ||
    typeof value.sequence !== "number"
  )
    return undefined;
  return {
    id: value.id,
    anchorId: value.anchorId,
    purpose: value.purpose,
    title: value.title,
    durationMinutes: value.durationMinutes,
    sequence: value.sequence,
    timingRule: value.timingRule === "flexible" ? "flexible" : "contiguous",
    maxLeadMinutes: typeof value.maxLeadMinutes === "number" ? value.maxLeadMinutes : null,
    energy: typeof value.energy === "string" ? value.energy : "low",
    phase: value.phase === "after" ? "after" : "before",
    contexts: Array.isArray(value.contexts)
      ? value.contexts.filter((item): item is string => typeof item === "string")
      : [],
    actionWindowId: typeof value.actionWindowId === "string" ? value.actionWindowId : null,
    cadenceActionId: typeof value.cadenceActionId === "string" ? value.cadenceActionId : null,
    presetStepId: typeof value.presetStepId === "string" ? value.presetStepId : null,
    status: value.status === "skipped" ? "skipped" : "pending",
    scheduledStartAt: typeof value.scheduledStartAt === "string" ? new Date(value.scheduledStartAt) : null,
    scheduledEndAt: typeof value.scheduledEndAt === "string" ? new Date(value.scheduledEndAt) : null,
    waitAfterMinutes: typeof value.waitAfterMinutes === "number" ? value.waitAfterMinutes : 0,
    mustStartByMinutes: typeof value.mustStartByMinutes === "number" ? value.mustStartByMinutes : null,
    preferredBands: contextList(value.preferredBands)
  };
}

/**
 * Aligns every bedtime/wake `routine_steps` row with what the engine just derived, one (anchor,
 * purpose) group at a time, through the same `planRoutineStepReconciliation`/`reconcileSleepRoutineSteps`
 * a commitment's own preparation goes through. A group
 * with no fresh steps at all (the preset was unconfigured, or every step gated out) still reconciles
 * against an empty template, so its stale pending rows are deleted rather than left orphaned — the
 * per-step equivalent of the old model's `DELETE ... WHERE status='planned'` sweep before every upsert.
 */
async function syncSleepRoutineSteps(
  sql: postgres.Sql,
  userId: string,
  derivedRoutineSteps: Array<Record<string, unknown>>
): Promise<void> {
  const derived = derivedRoutineSteps
    .map(readDerivedSleepRoutineStep)
    .filter((step): step is DerivedSleepRoutineStep => step !== undefined);
  const derivedByGroup = new Map<string, DerivedSleepRoutineStep[]>();
  for (const step of derived) {
    const key = `${step.anchorId}:${step.purpose}`;
    const list = derivedByGroup.get(key) ?? [];
    list.push(step);
    derivedByGroup.set(key, list);
  }
  const existingGroupRows = await sql<{ anchor_id: string; purpose: string }[]>`
    SELECT DISTINCT anchor_id, purpose FROM routine_steps WHERE user_id=${userId} AND anchor_type='sleep_plan'
  `;
  const groupKeys = new Set<string>([
    ...derivedByGroup.keys(),
    ...existingGroupRows.map((row) => `${row.anchor_id}:${row.purpose}`)
  ]);
  for (const key of groupKeys) {
    const [anchorId, purpose] = key.split(":") as [string, "bedtime" | "wake"];
    const steps = (derivedByGroup.get(key) ?? []).slice().sort((a, b) => a.sequence - b.sequence);
    const existingRows = await sql<
      {
        id: string;
        status: string;
        sequence: number;
        preset_step_id: string | null;
        title: string;
        duration_minutes: number;
        timing_rule: string;
        max_lead_minutes: number | null;
        energy: string;
        phase: string;
        contexts: unknown;
        action_window_id: string | null;
        cadence_action_id: string | null;
        scheduled_start_at: Date | null;
        scheduled_end_at: Date | null;
        wait_after_minutes: number;
        must_start_by_minutes: number | null;
        preferred_bands: unknown;
      }[]
    >`
      SELECT id,status,sequence,preset_step_id,title,duration_minutes,timing_rule,max_lead_minutes,energy,phase,contexts,action_window_id,cadence_action_id,scheduled_start_at,scheduled_end_at,wait_after_minutes,must_start_by_minutes,preferred_bands
      FROM routine_steps WHERE user_id=${userId} AND anchor_type='sleep_plan' AND anchor_id=${anchorId} AND purpose=${purpose}
      ORDER BY sequence, id
    `;
    const existingEdges = existingRows.length
      ? await sql<{ step_id: string; depends_on_step_id: string }[]>`
          SELECT step_id,depends_on_step_id FROM routine_step_dependencies WHERE step_id IN ${sql(existingRows.map((row) => row.id))}
        `
      : [];
    const dependsOnIdsByStepId = new Map<string, string[]>();
    for (const edge of existingEdges) {
      const list = dependsOnIdsByStepId.get(edge.step_id) ?? [];
      list.push(edge.depends_on_step_id);
      dependsOnIdsByStepId.set(edge.step_id, list);
    }
    const existingForPlan: ExistingRoutineStepForPlan[] = existingRows.map((row) => ({
      id: row.id,
      status: row.status,
      sequence: row.sequence,
      presetStepId: row.preset_step_id,
      title: row.title,
      durationMinutes: row.duration_minutes,
      timingRule: row.timing_rule === "flexible" ? "flexible" : "contiguous",
      maxLeadMinutes: row.max_lead_minutes,
      energy: row.energy,
      phase: row.phase === "after" ? "after" : "before",
      contexts: contextList(row.contexts),
      actionWindowId: row.action_window_id,
      cadenceActionId: row.cadence_action_id,
      dependsOnIds: dependsOnIdsByStepId.get(row.id) ?? [],
      scheduledStartAt: row.scheduled_start_at,
      scheduledEndAt: row.scheduled_end_at,
      waitAfterMinutes: row.wait_after_minutes,
      mustStartByMinutes: row.must_start_by_minutes,
      preferredBands: contextList(row.preferred_bands)
    }));
    // No dependency chain for sleep-anchored steps (a deliberate scope decision): they display and sort by sequence but are not
    // blocked from starting out of order the way a commitment's own dependency-linked steps are.
    const template: CommitmentRoutineStepInput[] = steps.map((step) => ({
      title: step.title,
      durationMinutes: step.durationMinutes,
      timingRule: step.timingRule,
      maxLeadMinutes: step.maxLeadMinutes,
      energy: step.energy,
      phase: step.phase,
      contexts: step.contexts,
      actionWindowId: step.actionWindowId,
      cadenceActionId: step.cadenceActionId,
      presetStepId: step.presetStepId,
      dependsOn: [],
      status: step.status,
      scheduledStartAt: step.scheduledStartAt,
      scheduledEndAt: step.scheduledEndAt,
      waitAfterMinutes: step.waitAfterMinutes,
      mustStartByMinutes: step.mustStartByMinutes,
      preferredBands: step.preferredBands
    }));
    await reconcileSleepRoutineSteps(
      sql,
      userId,
      anchorId,
      purpose,
      existingForPlan,
      template,
      (templateIndex) => steps[templateIndex]?.id ?? crypto.randomUUID()
    );
  }
}

/**
 * Archives one-off places nothing upcoming refers to any more.
 *
 * A one-off place is created quietly from a place search on a commitment and lives for exactly that
 * commitment. Once every commitment referencing it has ended — and no active recurrence rule still
 * points at it — the place has done its job, and archiving keeps it from accumulating in the travel
 * measurement set. The hour's grace covers the window between the place being created and the
 * commitment that references it being saved: a replan can run between the two writes, and archiving
 * the place in that gap would make the commitment save fail against an inactive location. A place
 * abandoned by a cancelled form is caught by the same rule an hour later.
 */
export async function archiveExpiredOneOffPlaces(sql: postgres.Sql, userId: string, now: Date): Promise<void> {
  await sql`
    UPDATE condition_definitions SET status='archived', version=version+1, updated_at=CURRENT_TIMESTAMP
    WHERE user_id=${userId} AND kind='location' AND one_off=true AND status='active'
      AND created_at<${now}-INTERVAL '1 hour'
      AND NOT EXISTS (
        SELECT 1 FROM commitments c
        WHERE c.user_id=${userId} AND c.location_id=condition_definitions.id AND c.status<>'cancelled' AND c.ends_at>${now}
      )
      AND NOT EXISTS (
        SELECT 1 FROM commitment_recurrence_rules r
        WHERE r.user_id=${userId} AND r.location_id=condition_definitions.id AND r.status='active'
      )
  `;
}

/**
 * How far ahead the engine materialises recurring windows. `deriveOccurrences` bounds itself to
 * fourteen days from the moment it calculated, so a row starting beyond that was never this run's to
 * confirm or withdraw.
 */
const OCCURRENCE_HORIZON_MS = 14 * 86_400_000;

/**
 * Write one materialised recurring window, correcting an existing row unless it has become evidence.
 *
 * A `pending` row is a resolution: the next run re-anchors it, which is the whole point of
 * `actual_wake` anchoring — wake late and this morning's window legitimately slides. Once the row is
 * `completed` or `missed` it has stopped describing a plan and started recording when the work
 * actually happened, so the same freeze the sleep upsert applies to a decided night applies here:
 * finish a bedtime routine, sleep, wake, and the completed row's recorded times would otherwise shift
 * by however far the wake anchor moved, silently rewriting history. `routine_covered` freezes with
 * them because completing an occurrence deliberately clears it and healing it from the rule would
 * undo that. `cancelled` stays free to move, matching the sleep upsert's revival escape hatch.
 */
export async function upsertActionOccurrence(
  sql: postgres.Sql,
  occurrence: {
    id: string;
    actionId: string;
    ruleId: string;
    windowId: string;
    localDate: string;
    windowStartsAt: Date;
    windowEndsAt: Date;
    anchorSource: string;
    status: string;
    routineCovered: boolean;
  }
): Promise<void> {
  const frozen = sql`(action_occurrences.status IN ('completed','missed'))`;
  const occurrenceUpsert = guardedConflictUpdate(sql, "action_occurrences", [
    [
      "window_starts_at",
      sql`CASE WHEN ${frozen} THEN action_occurrences.window_starts_at ELSE EXCLUDED.window_starts_at END`
    ],
    [
      "window_ends_at",
      sql`CASE WHEN ${frozen} THEN action_occurrences.window_ends_at ELSE EXCLUDED.window_ends_at END`
    ],
    ["anchor_source", sql`CASE WHEN ${frozen} THEN action_occurrences.anchor_source ELSE EXCLUDED.anchor_source END`],
    [
      "routine_covered",
      sql`CASE WHEN ${frozen} THEN action_occurrences.routine_covered ELSE EXCLUDED.routine_covered END`
    ]
  ]);
  await sql`INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source,status,routine_covered) VALUES (${occurrence.id},${occurrence.actionId},${occurrence.ruleId},${occurrence.windowId},${occurrence.localDate},${occurrence.windowStartsAt},${occurrence.windowEndsAt},${occurrence.anchorSource},${occurrence.status},${occurrence.routineCovered}) ON CONFLICT (id) DO UPDATE SET ${occurrenceUpsert.set} WHERE ${occurrenceUpsert.changed}`;
}

/**
 * Drop pending occurrence rows this run no longer places.
 *
 * An occurrence row is a *resolution*, not a record: its window times come from whichever sleep
 * anchor was current the last time a forecast ran. The upsert above corrects a row whenever the run
 * re-resolves it, so a moved sleep plan normally carries its wind-down window with it. What went
 * uncorrected was the row a run stops producing altogether — the rule ended, the action stopped
 * recurring, or the re-resolved window has already passed — because writing nothing leaves the
 * superseded row in place at its stale times, and every later run leaves it there too. That is how a
 * bedtime window went on showing a fixed fallback clock hours away from the sleep plan it was
 * supposed to track, and how a cancelled series kept offering windows the planner had forgotten.
 *
 * Only rows inside the horizon this run actually covered are considered, and only ones still open:
 * anything already finished is history the engine has stopped resolving and must keep. Completed,
 * missed and cancelled rows are outcomes rather than resolutions and are never touched, nor is a row
 * a session points at, whose time is already being spent. A window the next run does place returns
 * under the same deterministic id.
 */
export async function dropSupersededOccurrences(
  sql: postgres.Sql,
  userId: string,
  resolved: readonly string[],
  calculatedAt: Date
) {
  const through = new Date(calculatedAt.getTime() + OCCURRENCE_HORIZON_MS);
  // A run that resolved nothing has withdrawn everything in range, and an empty list is not
  // renderable as `NOT IN ()`, so the exclusion is left out rather than faked.
  const exceptResolved = resolved.length ? sql`AND id NOT IN ${sql(resolved as string[])}` : sql``;
  await sql`
    DELETE FROM action_occurrences
    WHERE status='pending' AND window_ends_at>${calculatedAt} AND window_starts_at<${through}
      AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.occurrence_id=action_occurrences.id)
      -- A still-live (not yet superseded) recommendation's candidate rows can cite this occurrence,
      -- and recommendation_candidates.occurrence_id has no ON DELETE rule: deleting the occurrence out
      -- from under that ranking would violate recommendation_candidates_occurrence_id_fkey rather than
      -- silently edit a live recommendation. A still-referenced occurrence must outlive the ranking
      -- that cites it, so it is left in place here and deleted on a later run, once
      -- pruneSupersededRecommendationCandidates has cleared the superseded ranking's candidate rows.
      AND NOT EXISTS (
        SELECT 1 FROM recommendation_candidates WHERE recommendation_candidates.occurrence_id=action_occurrences.id
      )
      AND action_id IN (
        SELECT ac.id FROM actions ac
          JOIN projects p ON p.id=ac.project_id
          JOIN outcomes o ON o.id=p.outcome_id
          JOIN areas a ON a.id=o.area_id
        WHERE a.user_id=${userId}
      )
      ${exceptResolved}
  `;
}

/** True when any command has written to this user's planning state since the snapshot was taken. */
async function stateChangedSince(
  sql: postgres.Sql,
  userId: string,
  stateCapturedAt: string | undefined
): Promise<boolean> {
  if (!stateCapturedAt) return false;
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM write_rows WHERE user_id=${userId} AND created_at>${new Date(stateCapturedAt)}) AS exists
  `;
  return rows[0]?.exists === true;
}

/**
 * How long a claimed job may stay `running` before the reaper treats its worker as gone. Nothing
 * renews a claim, so the lease has to outlast the longest a live attempt can take: the engine call
 * is cut off at `timeoutMs`, and the minute on top covers the database work either side of it.
 */
export function planForecastLeaseSeconds(timeoutMs: number): number {
  return Math.max(120, Math.ceil(timeoutMs / 1000) + 60);
}

/**
 * Puts every claim older than its lease back in the queue. A claim is only ever cleared by the
 * attempt that took it, so a worker that crashed, or one whose own status UPDATE failed in a
 * database blip, left a row `running` that no claim would ever pick up again. The worker runs this on
 * a timer, not just at boot: a crashed worker restarts within seconds, when its dead claim is still
 * inside the lease. `attempts` was counted at claim, so a job that keeps dying mid-attempt runs out of
 * retries and fails like any other instead of looping forever.
 */
export async function reclaimExpiredPlanForecastJobs(
  sql: postgres.Sql,
  leaseSeconds = planForecastLeaseSeconds(0)
): Promise<{ requeued: number; failed: number }> {
  // `last_error_code` on the right-hand side is the previous attempt's: a job whose attempts were run
  // up by an engine outage keeps its unlimited outage retries (`classifyPlanForecastFailure`) through
  // one mid-attempt death, and fails only if its claims keep dying.
  const rows = await sql<{ status: string }[]>`
    UPDATE jobs SET
      status=CASE WHEN attempts>${RETRY_DELAYS_SECONDS.length} AND last_error_code IS DISTINCT FROM 'plan_forecast_unavailable' THEN 'failed' ELSE 'retrying' END,
      failed_at=CASE WHEN attempts>${RETRY_DELAYS_SECONDS.length} AND last_error_code IS DISTINCT FROM 'plan_forecast_unavailable' THEN CURRENT_TIMESTAMP ELSE NULL END,
      available_at=CURRENT_TIMESTAMP,locked_at=NULL,locked_by=NULL,last_error_code='abandoned_lock',
      last_error_message='Recovered after worker lock timeout.'
    WHERE type=${PLAN_FORECAST_JOB_TYPE} AND status='running'
      AND locked_at<CURRENT_TIMESTAMP-(${leaseSeconds}*INTERVAL '1 second')
    RETURNING status
  `;
  const failed = rows.filter((row) => row.status === "failed").length;
  return { requeued: rows.length - failed, failed };
}

export async function recoverAbandonedPlanForecastJobs(sql: postgres.Sql, leaseSeconds = planForecastLeaseSeconds(0)) {
  await reclaimExpiredPlanForecastJobs(sql, leaseSeconds);
  // The retry budget spans about thirteen minutes, far shorter than a realistic engine outage. A worker
  // starting up is evidence the outage may be over, so give permanently failed jobs a fresh run.
  // Only the latest failure per user is worth reviving; anything older is already superseded work.
  // Terminal failures stay failed: a request the engine rejected or a payload that cannot parse is
  // immutable and fails the same way again, and a job the reaper has just exhausted kept dying
  // mid-attempt, so a restart is no evidence it would now finish.
  await sql`
    UPDATE jobs SET status='retrying',attempts=0,available_at=CURRENT_TIMESTAMP,failed_at=NULL,locked_at=NULL,locked_by=NULL,last_error_code='recovered_after_restart'
    WHERE type=${PLAN_FORECAST_JOB_TYPE} AND status='failed'
      AND COALESCE(last_error_code,'') NOT IN ('plan_forecast_rejected','invalid_payload','abandoned_lock')
      AND NOT EXISTS (SELECT 1 FROM jobs newer WHERE newer.type=${PLAN_FORECAST_JOB_TYPE} AND newer.payload->>'userId'=jobs.payload->>'userId' AND newer.seq>jobs.seq)
  `;
}

export function planForecastConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): PlanForecastServiceConfig {
  return {
    url: env.PLAN_FORECAST_SERVICE_URL ?? "http://127.0.0.1:4100",
    token: env.PLAN_FORECAST_SERVICE_TOKEN ?? "",
    timeoutMs: positiveInteger(env.PLAN_FORECAST_REQUEST_TIMEOUT_MS, 10_000)
  };
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function stringOrNull(value: unknown) {
  return typeof value === "string" && value ? value : null;
}
function dateOrNull(value: unknown) {
  return typeof value === "string" ? new Date(value) : null;
}

export type { PortalStateContract };
