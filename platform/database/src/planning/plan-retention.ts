import type postgres from "postgres";
import { PLAN_FORECAST_JOB_TYPE } from "./plan-forecast-runtime.js";
import { JOURNEY_SUMMARY_WINDOW_DAYS } from "./journey-summary.js";

/**
 * Bounded retention for the evidence a planning run leaves behind.
 *
 * Every material mutation and every validity boundary enqueues a job whose payload embeds the whole
 * portal state, and a completed job writes a `planning_runs` row embedding the whole engine result
 * plus a forecast row per project and a recommendation with its candidates. Nothing removed any of
 * it, so the database grew without limit while none of it is authored data — `REGENERABLE_TABLES`
 * already classifies all five tables as recomputed output that backups deliberately skip.
 *
 * The policy keeps what is still load-bearing and drops the rest:
 * - anything still in flight, and the newest job per user, so the queue and the portal's job-status
 *   read never lose their subject;
 * - the current (non-superseded) planning run and recommendation, which the portal reads directly;
 * - a recent window of history for debugging, plus a per-user cap on superseded rows so a quiet
 *   month cannot be undone by a busy day;
 * - everything an issue snapshot points at, because a frozen report is only replayable while the
 *   job that carried its engine input and the run that produced its result still exist;
 * - every recommendation a session was started from, because that reference is a nullable FK with
 *   ON DELETE SET NULL and deleting the parent would quietly edit an authored `sessions` row.
 *
 * A finished job that survives the window may still shed the engine request embedded in its payload,
 * which is the bulk of its size and is unreachable once its run has been superseded. The row, its
 * status and its timings are kept; only the state blob goes.
 *
 * No `writes` or `write_rows` row is ever deleted here. They record what the user did rather than what the
 * engine computed, and `stateChangedSince` reads the row timestamps to decide whether a boundary job has
 * been overtaken; pruning them would make old jobs look unopposed. A `writes` header is also its command's
 * receipt, so a client retrying a `commandId` of any age gets the stored answer, never a second execution. The
 * one thing that goes is an old row's before-image (`clearExpiredBeforeImages`), never the row.
 *
 * `provider_call_telemetry` rides along here too, even though it is not planning evidence: it is
 * unrelated to a run or a job, has its own fixed window, and the portal has no worker of its own —
 * this loop is the only process in the deploy stack that runs continuously and can prune anything on
 * a schedule. `pruneExpiredProviderTelemetry` is exported separately so `provider-call-recorder.ts`'s
 * on-request prune calls the same query rather than keeping a second copy of it.
 */
export interface PlanningRetentionConfig {
  /** Set `PLANNING_RETENTION_ENABLED=false` to turn pruning off without redeploying the worker. */
  enabled: boolean;
  /** Jobs finished longer ago than this are candidates for deletion. */
  jobRetentionDays: number;
  /** Planning runs, forecasts and recommendations calculated longer ago than this are candidates. */
  runRetentionDays: number;
  /** Superseded planning runs and recommendations kept per user regardless of age. */
  supersededPerUser: number;
  /**
   * How long a `provider_call_telemetry` row is kept. Seven days is enough to eyeball a slow week and
   * small enough that nobody needs to think about the table — the same constant the recorder used
   * before this loop took over pruning it.
   */
  providerTelemetryRetentionDays: number;
  /** How often the worker prunes. */
  intervalMinutes: number;
}

export interface PlanningRetentionCounts {
  jobs: number;
  planningRuns: number;
  forecastSnapshots: number;
  recommendations: number;
  recommendationCandidates: number;
  /** Finished jobs whose embedded engine request was dropped while the row itself was kept. */
  jobPayloadsCompacted: number;
  /** Expired `provider_call_telemetry` rows deleted. */
  providerTelemetryDeleted: number;
  /** `journey_samples` rows older than `JOURNEY_SUMMARY_WINDOW_DAYS` deleted. */
  journeySamplesDeleted: number;
  /** `push_outbox` rows older than `PUSH_OUTBOX_RETENTION_DAYS` deleted. */
  pushOutboxDeleted: number;
  /** Closed `pulse_segments` rows older than `PULSE_SEGMENTS_RETENTION_DAYS` deleted. */
  pulseSegmentsDeleted: number;
  /** `write_rows` older than `BEFORE_IMAGE_RETENTION_DAYS` that lost their before-image (the row is kept). */
  beforeImagesCleared: number;
}

/** `push_outbox` rows this old carry no signal anything still reads. */
export const PUSH_OUTBOX_RETENTION_DAYS = 30;

/**
 * Measured against ten days of single-user data: 734 MB total, of which `jobs` held 192 MB at about
 * 60 KB of embedded state per row and `planning_runs` 120 MB at about 87 KB per result. The first
 * sweep under the old windows pruned 95 jobs and no runs at all, because nothing had yet aged past
 * thirty days. Windows short enough to bite while the data is still growing are the point; the rules
 * that protect in-flight work, the current run, snapshot references and session references are what
 * make a short window safe.
 */
export const defaultPlanningRetentionConfig: PlanningRetentionConfig = {
  enabled: true,
  jobRetentionDays: 3,
  runRetentionDays: 7,
  supersededPerUser: 50,
  providerTelemetryRetentionDays: 7,
  intervalMinutes: 60
};

export function planningRetentionConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): PlanningRetentionConfig {
  return {
    enabled: env.PLANNING_RETENTION_ENABLED !== "false",
    jobRetentionDays: positiveInteger(env.PLANNING_RETENTION_JOB_DAYS, defaultPlanningRetentionConfig.jobRetentionDays),
    runRetentionDays: positiveInteger(env.PLANNING_RETENTION_RUN_DAYS, defaultPlanningRetentionConfig.runRetentionDays),
    supersededPerUser: positiveInteger(
      env.PLANNING_RETENTION_PER_USER,
      defaultPlanningRetentionConfig.supersededPerUser
    ),
    providerTelemetryRetentionDays: positiveInteger(
      env.PLANNING_RETENTION_PROVIDER_TELEMETRY_DAYS,
      defaultPlanningRetentionConfig.providerTelemetryRetentionDays
    ),
    intervalMinutes: positiveInteger(
      env.PLANNING_RETENTION_INTERVAL_MINUTES,
      defaultPlanningRetentionConfig.intervalMinutes
    )
  };
}

/**
 * Deletes expired planning evidence in one transaction, children before parents, and returns how
 * many rows each table lost. A partial prune is never committed, so a failure leaves the evidence
 * exactly as it was rather than half-severed.
 */
export async function pruneExpiredPlanningEvidence(
  sql: postgres.Sql,
  config: PlanningRetentionConfig = defaultPlanningRetentionConfig
): Promise<PlanningRetentionCounts> {
  const counts: PlanningRetentionCounts = {
    jobs: 0,
    planningRuns: 0,
    forecastSnapshots: 0,
    recommendations: 0,
    recommendationCandidates: 0,
    jobPayloadsCompacted: 0,
    providerTelemetryDeleted: 0,
    journeySamplesDeleted: 0,
    pushOutboxDeleted: 0,
    pulseSegmentsDeleted: 0,
    beforeImagesCleared: 0
  };
  if (!config.enabled) return counts;
  await sql.begin(async (transaction) => {
    const tx = transaction as unknown as postgres.Sql;
    counts.recommendationCandidates = await deleteExpiredRecommendationCandidates(tx, config);
    counts.recommendations = await deleteExpiredRecommendations(tx, config);
    counts.forecastSnapshots = await deleteExpiredForecastSnapshots(tx, config);
    counts.planningRuns = await deleteExpiredPlanningRuns(tx, config);
    counts.jobs = await deleteExpiredJobs(tx, config);
    counts.jobPayloadsCompacted = await compactUnreachableJobPayloads(tx);
    counts.providerTelemetryDeleted = await pruneExpiredProviderTelemetry(tx, config.providerTelemetryRetentionDays);
    counts.journeySamplesDeleted = await pruneExpiredJourneySamples(tx);
    counts.pushOutboxDeleted = await pruneExpiredPushOutbox(tx);
    counts.pulseSegmentsDeleted = await pruneExpiredPulseSegments(tx);
    counts.beforeImagesCleared = await clearExpiredBeforeImages(tx);
  });
  return counts;
}

/**
 * Deletes `push_outbox` rows older than {@link PUSH_OUTBOX_RETENTION_DAYS}
 * neither table is plan input, so nothing downstream
 * reads a row this old. Filtered on `created_at` rather than `expires_at`/`sent_at`, so a row stuck
 * `pending` (a worker outage) is still swept eventually rather than kept forever.
 */
export async function pruneExpiredPushOutbox(sql: postgres.Sql): Promise<number> {
  const result = await sql`
    DELETE FROM push_outbox WHERE created_at < now() - (${PUSH_OUTBOX_RETENTION_DAYS} * INTERVAL '1 day')
  `;
  return result.count;
}

/**
 * Deletes `journey_samples` rows older than `JOURNEY_SUMMARY_WINDOW_DAYS`
 * a sample this old carries no signal
 * `readJourneySummary` would ever read (it windows to the same number of days), so nothing downstream
 * loses anything by its absence. Filtered on `observed_at`, the same column the summary windows by.
 */
export async function pruneExpiredJourneySamples(sql: postgres.Sql): Promise<number> {
  const result = await sql`
    DELETE FROM journey_samples WHERE observed_at < now() - (${JOURNEY_SUMMARY_WINDOW_DAYS} * INTERVAL '1 day')
  `;
  return result.count;
}

/** The pulse criteria and publish design note ("Persistence"): the pulse history is authored data
    (`BACKUP_TABLES`), not recomputable, so it keeps a long window rather than the short ones above. */
export const PULSE_SEGMENTS_RETENTION_DAYS = 400;

/** Deletes closed `pulse_segments` rows older than {@link PULSE_SEGMENTS_RETENTION_DAYS}, filtered on
    `ended_at` so the one open segment per user is never touched. */
export async function pruneExpiredPulseSegments(sql: postgres.Sql): Promise<number> {
  const result = await sql`
    DELETE FROM pulse_segments
    WHERE ended_at IS NOT NULL AND ended_at < now() - (${PULSE_SEGMENTS_RETENTION_DAYS} * INTERVAL '1 day')
  `;
  return result.count;
}

/** How long an agent write's before-image is kept: undo is a recent-changes tool. */
export const BEFORE_IMAGE_RETENTION_DAYS = 90;

/**
 * Drops `evidence.before` from `write_rows` older than {@link BEFORE_IMAGE_RETENTION_DAYS}, keeping
 * the row itself: the ledger is the audit trail and `stateChangedSince` reads its timestamps, so no row
 * is ever deleted. Only the stored copy of the old entity goes, and `beforeRecorded` reads false afterwards.
 */
export async function clearExpiredBeforeImages(sql: postgres.Sql): Promise<number> {
  const result = await sql`
    UPDATE write_rows SET evidence = evidence - 'before'
    WHERE evidence ? 'before' AND created_at < now() - (${BEFORE_IMAGE_RETENTION_DAYS} * INTERVAL '1 day')
  `;
  return result.count;
}

/**
 * Deletes `provider_call_telemetry` rows older than `retentionDays`. Exported on its own, not just
 * folded into `pruneExpiredPlanningEvidence`, so `provider-call-recorder.ts`'s on-request prune (still
 * called from `POST /api/connections/status` for anyone who opens that page before the next hourly
 * sweep) runs this exact query instead of keeping a second copy of it.
 */
export async function pruneExpiredProviderTelemetry(sql: postgres.Sql, retentionDays: number): Promise<number> {
  const result = await sql`
    DELETE FROM provider_call_telemetry WHERE started_at < now() - (${retentionDays} * INTERVAL '1 day')
  `;
  return result.count;
}

/**
 * A superseded recommendation is expendable unless it is recent, within the per-user cap, or a
 * session records it as the reason that session was started.
 */
const expiredRecommendations = (sql: postgres.Sql, config: PlanningRetentionConfig) => sql`
  SELECT expired.id FROM recommendations expired
  WHERE expired.superseded_at IS NOT NULL
    AND expired.calculated_at < CURRENT_TIMESTAMP - (${config.runRetentionDays} * INTERVAL '1 day')
    AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.recommendation_id = expired.id)
    AND expired.id NOT IN (
      SELECT ranked.id FROM (
        SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY calculated_at DESC) AS position
        FROM recommendations WHERE superseded_at IS NOT NULL
      ) ranked WHERE ranked.position <= ${config.supersededPerUser}
    )
`;

async function deleteExpiredRecommendationCandidates(sql: postgres.Sql, config: PlanningRetentionConfig) {
  const result = await sql`
    DELETE FROM recommendation_candidates
    WHERE recommendation_id IN (${expiredRecommendations(sql, config)})
  `;
  return result.count;
}

async function deleteExpiredRecommendations(sql: postgres.Sql, config: PlanningRetentionConfig) {
  const result = await sql`DELETE FROM recommendations WHERE id IN (${expiredRecommendations(sql, config)})`;
  return result.count;
}

/**
 * Forecast rows carry no user and no link to the run that wrote them, so the per-user cap cannot
 * apply. The most recent row per project is kept unconditionally: it is the only record of where a
 * project stood, and a project that has been dormant longer than the window would otherwise lose
 * its entire forecast history.
 */
async function deleteExpiredForecastSnapshots(sql: postgres.Sql, config: PlanningRetentionConfig) {
  const result = await sql`
    DELETE FROM forecast_snapshots
    WHERE calculated_at < CURRENT_TIMESTAMP - (${config.runRetentionDays} * INTERVAL '1 day')
      AND id NOT IN (
        SELECT DISTINCT ON (project_id) id FROM forecast_snapshots ORDER BY project_id, calculated_at DESC
      )
  `;
  return result.count;
}

async function deleteExpiredPlanningRuns(sql: postgres.Sql, config: PlanningRetentionConfig) {
  const result = await sql`
    WITH snapshot_request_ids AS (
      SELECT DISTINCT snapshot #>> '{server,planningRun,requestId}' AS request_id
      FROM issue_snapshots
      WHERE snapshot #>> '{server,planningRun,requestId}' IS NOT NULL
    )
    DELETE FROM planning_runs
    WHERE superseded_at IS NOT NULL
      AND calculated_at < CURRENT_TIMESTAMP - (${config.runRetentionDays} * INTERVAL '1 day')
      AND request_id::text NOT IN (SELECT request_id FROM snapshot_request_ids)
      AND id NOT IN (
        SELECT ranked.id FROM (
          SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY calculated_at DESC) AS position
          FROM planning_runs WHERE superseded_at IS NOT NULL
        ) ranked WHERE ranked.position <= ${config.supersededPerUser}
      )
  `;
  return result.count;
}

/**
 * Only plan-and-forecast jobs are pruned; another job type would have its own claim rules and its
 * own idea of which rows still matter.
 *
 * The newest job per user is kept whatever its status. The portal reads it to report planning
 * status, and `recoverAbandonedPlanForecastJobs` decides whether a failed job is worth reviving by
 * asking whether a newer one exists — deleting the newer row would resurrect stale work.
 */
/**
 * The jobs whose identity still matters to something outside the queue: the newest per user and the
 * newest completed per user, which the portal's status read and the issue-snapshot engine-input
 * fallback both depend on, plus everything an issue snapshot names directly or by input version.
 */
const retainedJobs = (sql: postgres.Sql) => sql`
  WITH snapshot_job_ids AS (
    SELECT DISTINCT entry.item->>'id' AS job_id
    FROM issue_snapshots
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(snapshot #> '{server,jobs}') = 'array' THEN snapshot #> '{server,jobs}'
        ELSE '[]'::jsonb
      END
    ) AS entry(item)
    WHERE entry.item->>'id' IS NOT NULL
  ),
  snapshot_input_versions AS (
    SELECT DISTINCT engine_input_version AS input_version
    FROM issue_snapshots WHERE engine_input_version IS NOT NULL
  )
  SELECT id FROM (
    SELECT DISTINCT ON (payload->>'userId') id FROM jobs
    WHERE type = ${PLAN_FORECAST_JOB_TYPE}
    ORDER BY payload->>'userId', created_at DESC
  ) newest_per_user
  UNION
  SELECT id FROM (
    SELECT DISTINCT ON (payload->>'userId') id FROM jobs
    WHERE type = ${PLAN_FORECAST_JOB_TYPE} AND status = 'completed'
    ORDER BY payload->>'userId', created_at DESC
  ) newest_completed_per_user
  UNION
  SELECT id FROM jobs WHERE id::text IN (SELECT job_id FROM snapshot_job_ids)
  UNION
  SELECT jobs.id FROM jobs
  JOIN snapshot_input_versions
    ON right(jobs.idempotency_key, length(snapshot_input_versions.input_version) + 1) =
       ':' || snapshot_input_versions.input_version
`;

async function deleteExpiredJobs(sql: postgres.Sql, config: PlanningRetentionConfig) {
  const result = await sql`
    DELETE FROM jobs
    WHERE type = ${PLAN_FORECAST_JOB_TYPE}
      AND status NOT IN ('pending', 'retrying', 'running')
      AND created_at < CURRENT_TIMESTAMP - (${config.jobRetentionDays} * INTERVAL '1 day')
      AND id NOT IN (${retainedJobs(sql)})
  `;
  return result.count;
}

/** A finished job's payload is unreachable for at least this long before it is dropped. */
const PAYLOAD_COMPACTION_GRACE_HOURS = 1;

/**
 * Drops the embedded engine request from finished jobs nothing can still ask for it.
 *
 * The payload is a whole portal state — about 60 KB — and it exists so a worker can run the job and
 * so a new issue snapshot can recover the engine input behind the *current* plan. Once the job has
 * finished and its run has been superseded, neither use remains: the request survives inside any
 * snapshot that already captured it, and a superseded run's own ranking is inside its JSON result.
 *
 * Everything the queue or a reader can still reach keeps its payload in full: in-flight jobs, whose
 * payload is the work itself; the retained set above; and the job keyed by the input version of a
 * planning run that is still current, which is the row `issue-snapshot-store` looks up by
 * idempotency key. The one-hour grace keeps a job that has only just finished intact, so a capture
 * racing the sweep cannot find its subject half-emptied. The row itself stays, so job history,
 * status, timings and error evidence are unchanged.
 */
async function compactUnreachableJobPayloads(sql: postgres.Sql) {
  const result = await sql`
    UPDATE jobs SET payload = payload - 'request'
    WHERE type = ${PLAN_FORECAST_JOB_TYPE}
      AND status NOT IN ('pending', 'retrying', 'running')
      AND payload->'request' IS NOT NULL
      AND created_at < CURRENT_TIMESTAMP - (${PAYLOAD_COMPACTION_GRACE_HOURS} * INTERVAL '1 hour')
      AND NOT EXISTS (
        SELECT 1 FROM planning_runs
        WHERE planning_runs.superseded_at IS NULL
          AND right(jobs.idempotency_key, length(planning_runs.input_version) + 1) =
              ':' || planning_runs.input_version
      )
      AND id NOT IN (${retainedJobs(sql)})
  `;
  return result.count;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
