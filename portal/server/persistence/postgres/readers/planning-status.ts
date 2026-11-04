import { PLAN_FORECAST_JOB_TYPE, jobs, planningRuns, recommendations } from "@openrhen/database";
import {
  awaitingRecalculation,
  latestJobFailedAfterRun,
  retryingWithNewerState,
  PLAN_FORECAST_GRACE_MINUTES,
  planRefreshState,
  planningRuntime,
  type PlanningRunRow,
  type PlanningStatus
} from "@/features/planning/planning-runtime";
import type { PortalState } from "@/state/portal-state";
import type { Row } from "../db-row";
import { ensureUser } from "../ensure-user";
import type { Sql } from "../sql-pool";

/** The id of the live recommendation, if one has been calculated and not superseded. */
export async function readCurrentRecommendationId(sql: Sql, userId: string): Promise<string | undefined> {
  const currentRecommendation = await sql<
    Row<typeof recommendations, "id">[]
  >`SELECT id FROM recommendations WHERE user_id=${userId} AND superseded_at IS NULL ORDER BY calculated_at DESC LIMIT 1`;
  return currentRecommendation[0]?.id;
}

/** The planning block of the state document: the latest run, and what the job queue says about it. */
export async function readPlanning(sql: Sql, userId: string): Promise<NonNullable<PortalState["planning"]>> {
  const planningRun = await sql<
    Row<typeof planningRuns, "calculated_at" | "valid_until" | "result">[]
  >`SELECT calculated_at,valid_until,result FROM planning_runs WHERE user_id=${userId} AND superseded_at IS NULL ORDER BY calculated_at DESC LIMIT 1`;
  // `state_captured_at` comes along so the runtime can tell a plan that is merely old from one the
  // database has already moved past. It is the job payload's own record of when its snapshot was read.
  const planningOpen = await readOpenPlanningJobs(sql, userId, new Date());
  const planningTerminalJob = await sql<
    Row<typeof jobs, "status" | "available_at" | "last_error_message" | "created_at">[]
  >`
      SELECT status,available_at,last_error_message,created_at FROM jobs
      WHERE type=${PLAN_FORECAST_JOB_TYPE} AND payload->>'userId'=${userId}
        AND status NOT IN ('pending','running','retrying')
      ORDER BY created_at DESC LIMIT 1
    `;
  return planningRuntime(
    planningRun[0],
    planningOpen.oldest,
    planningTerminalJob[0],
    new Date(),
    planningOpen.newestDue
  );
}

/**
 * The unfinished plan jobs, as three rows: the oldest queue entry (what is next, so what the status
 * chip and `openJob` describe), and the newest-snapshot job among those due or running and among those
 * retrying. "A newer plan is coming" is a question about the newest state any open job holds, not the
 * oldest: with two workers an old job can still be running while a newer one published the run and a
 * third was claimed on state newer again, and only the newest of them knows that.
 */
async function readOpenPlanningJobs(sql: Sql, userId: string, now: Date) {
  const columns = sql`status,available_at,last_error_message,created_at,(payload->>'stateCapturedAt')::timestamptz AS state_captured_at`;
  const newestFirst = sql`ORDER BY COALESCE((payload->>'stateCapturedAt')::timestamptz, created_at) DESC, created_at DESC LIMIT 1`;
  const open = sql`type=${PLAN_FORECAST_JOB_TYPE} AND payload->>'userId'=${userId} AND status IN ('pending','running','retrying')`;
  const rows = await sql<
    (Row<typeof jobs, "status" | "available_at" | "last_error_message" | "created_at"> & {
      state_captured_at: Date | null;
      kind: "oldest" | "due" | "retrying";
    })[]
  >`
    (SELECT 'oldest' AS kind,${columns} FROM jobs WHERE ${open} ORDER BY available_at, created_at LIMIT 1)
    UNION ALL
    (SELECT 'due' AS kind,${columns} FROM jobs WHERE ${open} AND (status='running' OR available_at<=${now}) ${newestFirst})
    UNION ALL
    (SELECT 'retrying' AS kind,${columns} FROM jobs WHERE ${open} AND status='retrying' ${newestFirst})
  `;
  const of = (kind: string) => rows.find((row) => row.kind === kind);
  return { oldest: of("oldest"), newestDue: of("due"), newestRetrying: of("retrying") };
}

/**
 * The cheap half of `readPortalState`: three indexed single-row reads and no `result` column.
 *
 * The whole state document is expensive enough that polling it every couple of seconds to find out
 * whether a recalculation has landed would cost more than the recalculation. This answers that one
 * question, so the browser fetches the full state exactly once — when the answer changes.
 */
export async function readPlanningStatus(sql: Sql): Promise<PlanningStatus> {
  const userId = await ensureUser(sql);
  const runRows = await sql<Row<typeof planningRuns, "calculated_at" | "valid_until">[]>`
    SELECT calculated_at,valid_until FROM planning_runs
    WHERE user_id=${userId} AND superseded_at IS NULL ORDER BY calculated_at DESC LIMIT 1
  `;
  const now = new Date();
  const open = await readOpenPlanningJobs(sql, userId, now);
  // Latest by the state each job captured, not by `created_at` (a transaction timestamp that a long
  // command can leave looking older than the state it read); `created_at` only when that is missing.
  // The newest 50 finished jobs by `created_at` come off the (type, userId, created_at) index; the
  // captured-state ordering then picks among them. Ordering the whole table by that expression would detoast
  // every job payload, and a job only strays this far from creation order by a few places.
  const finishedRows = await sql<
    (Row<typeof jobs, "status" | "created_at" | "last_error_code"> & { state_captured_at: Date | null })[]
  >`
    SELECT status,created_at,state_captured_at,last_error_code FROM (
      SELECT status,created_at,(payload->>'stateCapturedAt')::timestamptz AS state_captured_at,last_error_code
      FROM jobs WHERE type=${PLAN_FORECAST_JOB_TYPE} AND payload->>'userId'=${userId}
        AND status NOT IN ('pending','running','retrying')
      ORDER BY created_at DESC LIMIT 50
    ) recent
    ORDER BY COALESCE(state_captured_at, created_at) DESC, created_at DESC LIMIT 1
  `;
  const run = runRows[0];
  const openJob = open.oldest;
  // `result` is deliberately not read, so the row this stands in for is never loaded here. The
  // freshness question only needs the run's timestamps.
  const runRow: PlanningRunRow | undefined = run
    ? { calculated_at: run.calculated_at, valid_until: run.valid_until, result: null }
    : undefined;
  const latestJobFailed = latestJobFailedAfterRun(runRow, finishedRows[0]);
  const staleForMinutes =
    run && run.valid_until <= now ? Math.floor((now.getTime() - run.valid_until.getTime()) / 60_000) : 0;
  return {
    lastSuccessfulAt: run ? run.calculated_at.toISOString() : null,
    validUntil: run ? run.valid_until.toISOString() : null,
    serverNow: now.toISOString(),
    staleForMinutes,
    graceEndsAt: run ? new Date(run.valid_until.getTime() + PLAN_FORECAST_GRACE_MINUTES * 60_000).toISOString() : null,
    refresh: planRefreshState(runRow, openJob, now),
    stale: Boolean(run && run.valid_until <= now),
    awaitingRecalculation: awaitingRecalculation(runRow, open.newestDue, now),
    openJob: openJob
      ? {
          status: openJob.status,
          availableAt: openJob.available_at.toISOString(),
          dueNow: openJob.status === "running" || openJob.available_at <= now
        }
      : null,
    lastFinishedStatus: finishedRows[0]?.status ?? null,
    latestJobFailed,
    retryingNewerState: retryingWithNewerState(runRow, open.newestRetrying),
    lastErrorCode: latestJobFailed ? (finishedRows[0]?.last_error_code ?? null) : null
  };
}
