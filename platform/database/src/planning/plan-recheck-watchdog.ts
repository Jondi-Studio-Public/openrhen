import type postgres from "postgres";
import { PLAN_FORECAST_JOB_TYPE } from "./plan-forecast-runtime.js";

/** A plan is refreshed hourly, so a run older than this plus the grace means the chain is dead. */
export const PLAN_RECHECK_STALE_AFTER_MINUTES = 60;
export const PLAN_RECHECK_GRACE_MINUTES = 10;
/** The longest a run may age before the watchdog acts, and the least gap between two heals of one user. */
export const PLAN_RECHECK_THRESHOLD_MS = (PLAN_RECHECK_STALE_AFTER_MINUTES + PLAN_RECHECK_GRACE_MINUTES) * 60_000;

export interface PlanRecheckFacts {
  now: Date;
  /** `calculated_at` of the user's newest planning run. */
  newestRunAt: Date;
  /** A plan_forecast job is pending, retrying or running for the user. */
  hasActiveJob: boolean;
  /**
   * When the user's most recent plan job failed with `plan_forecast_unavailable` (the engine was down), else null.
   * Nothing retries that failure, so it only holds the watchdog back while it is recent: an old one with the engine
   * back is a dead chain.
   */
  lastJobEngineUnavailableAt: Date | null;
  /** When this process last healed the user, if it has. */
  lastHealAt?: Date | undefined;
}

export type PlanRecheckDecision =
  { heal: true } | { heal: false; reason: "active_job" | "recent_run" | "engine_unavailable" | "recently_healed" };

/**
 * Whether the plan chain is dead and needs one fresh job. Pure so the rules are tested without a database.
 * The order says which reason wins when several apply; none of them heals.
 */
export function decidePlanRecheck(facts: PlanRecheckFacts): PlanRecheckDecision {
  if (facts.hasActiveJob) return { heal: false, reason: "active_job" };
  if (facts.now.getTime() - facts.newestRunAt.getTime() <= PLAN_RECHECK_THRESHOLD_MS)
    return { heal: false, reason: "recent_run" };
  if (
    facts.lastJobEngineUnavailableAt &&
    facts.now.getTime() - facts.lastJobEngineUnavailableAt.getTime() <= PLAN_RECHECK_THRESHOLD_MS
  )
    return { heal: false, reason: "engine_unavailable" };
  if (facts.lastHealAt && facts.now.getTime() - facts.lastHealAt.getTime() <= PLAN_RECHECK_THRESHOLD_MS)
    return { heal: false, reason: "recently_healed" };
  return { heal: true };
}

export interface PlanRecheckHealRecord {
  userId: string;
  newestRunAt: string;
  runAgeMinutes: number;
}

export interface HealStalePlanChainOptions {
  /**
   * Enqueues one recalculation for the user from state read fresh from the database, through the same write path an
   * ordinary change uses. The caller supplies it because reading the state belongs to the portal, not this package;
   * it must never reuse an old job's payload.
   */
  enqueue: (userId: string) => Promise<void>;
  /** When each user was last healed by this process. Held by the caller so it outlives one call. */
  lastHealAt: Map<string, Date>;
  /** Called once per heal, after the enqueue succeeded. */
  onHeal?: (record: PlanRecheckHealRecord) => void;
}

interface UserFacts {
  user_id: string;
  newest_run_at: Date;
  has_active_job: boolean;
  last_error_code: string | null;
  last_status: string | null;
  last_failed_at: Date | null;
}

/**
 * Restarts a plan chain that died silently (a failed or superseded boundary job whose successor never chained).
 * Users are enumerated from `planning_runs`, so one who never had a plan is skipped. Returns the users healed. A
 * failed enqueue for one user is rethrown only after the others were tried, and is not recorded as a heal, so the
 * next tick retries it.
 */
export async function healStalePlanChain(
  sql: postgres.Sql,
  now: Date,
  options: HealStalePlanChainOptions
): Promise<string[]> {
  const rows = await sql<UserFacts[]>`
    SELECT r.user_id, r.newest_run_at,
      EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.type=${PLAN_FORECAST_JOB_TYPE} AND j.payload->>'userId'=r.user_id::text
          AND j.status IN ('pending','retrying','running')
      ) AS has_active_job,
      last_job.status AS last_status,
      last_job.last_error_code AS last_error_code,
      last_job.failed_at AS last_failed_at
    FROM (SELECT user_id, MAX(calculated_at) AS newest_run_at FROM planning_runs GROUP BY user_id) r
    LEFT JOIN LATERAL (
      SELECT j.status, j.last_error_code, j.failed_at FROM jobs j
      WHERE j.type=${PLAN_FORECAST_JOB_TYPE} AND j.payload->>'userId'=r.user_id::text
      ORDER BY j.seq DESC LIMIT 1
    ) last_job ON true
  `;
  const healed: string[] = [];
  let firstError: unknown;
  for (const row of rows) {
    const decision = decidePlanRecheck({
      now,
      newestRunAt: row.newest_run_at,
      hasActiveJob: row.has_active_job,
      lastJobEngineUnavailableAt:
        row.last_status === "failed" && row.last_error_code === "plan_forecast_unavailable" ? row.last_failed_at : null,
      lastHealAt: options.lastHealAt.get(row.user_id)
    });
    if (!decision.heal) continue;
    try {
      await options.enqueue(row.user_id);
    } catch (error) {
      firstError ??= error;
      continue;
    }
    options.lastHealAt.set(row.user_id, now);
    healed.push(row.user_id);
    options.onHeal?.({
      userId: row.user_id,
      newestRunAt: row.newest_run_at.toISOString(),
      runAgeMinutes: Math.round((now.getTime() - row.newest_run_at.getTime()) / 60_000)
    });
  }
  if (firstError) throw firstError;
  return healed;
}
