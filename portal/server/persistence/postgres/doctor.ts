import {
  agedInputIdsFromSchedule,
  DOCTOR_KEEP_FOR_DAYS,
  DOCTOR_OPEN_ACTION_STATUSES,
  DOCTOR_THRESHOLDS,
  calendarSourceIds,
  projectHealthFromSchedule,
  resolveFreshness,
  runDoctor,
  type DoctorReport,
  type DoctorSnapshot
} from "@openrhen/contracts";
import type { PortalStateContract } from "@openrhen/contracts";
import "./private/index";
import { isFailingSyncStatus, lastSyncRunAt, readExtensionSyncStatuses } from "./sync-status-extensions";
import { countCatchUpUnsettled } from "./catch-up";
import { readCadenceSlice } from "./doctor-cadence";
import { readDuplicatesSlice } from "./doctor-duplicates";
import { unregisteredDiffProfiles } from "./imports/calendar-diff";
import { readPeopleSlice } from "./doctor-people";
import { readPrerequisitesSlice } from "./doctor-prerequisites";
import { readPublishingSlice } from "./doctor-publishing";
import { readRecordingSlice } from "./doctor-recording";
import { readClosedSlice } from "./doctor-closed";
import { readSourcesSlice } from "@/server/data-flow/doctor-sources-reader";
import { ensureUser } from "./ensure-user";
import { readSessions } from "./readers/sessions";
import type { PoolSql, Sql } from "./sql-pool";

/**
 * The data health check's reader: builds the plain snapshot `runDoctor` checks from
 * the tables that own each fact, then returns its report. Derived on read, never stored, and it writes nothing
 * of its own. Integrations are read for status only (provider, state, times): never a subject, an address or an
 * error body. Every query is bounded and the whole read is one round of `Promise.all`.
 */

type Queryable = Sql;
type ActiveSession = PortalStateContract["activeSession"];
type DoctorFreshnessState = Parameters<typeof resolveFreshness>[0];

const DAY_MS = 86_400_000;
const LIMIT = 500;
/** The estimate fields whose being a default makes an estimate "assumed". */
const ESTIMATE_FIELDS: ReadonlySet<string> = new Set([
  "optimisticMinutes",
  "expectedMinutes",
  "pessimisticMinutes",
  "remainingMinutes"
]);

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/**
 * The remaining-effort estimates the current stored plan's forecasts aged (`agedInputs`), with the actions behind
 * them, so doctor reads the same rule Now does. A database with no plan, or one from before effort age, yields none.
 */
async function readAgedEstimates(
  sql: Queryable,
  userId: string
): Promise<{
  projectHealth: ReturnType<typeof projectHealthFromSchedule>;
  agedActionIds: ReturnType<typeof agedInputIdsFromSchedule>;
  actions: NonNullable<DoctorFreshnessState["actions"]>;
}> {
  const runs = await sql<{ schedule: unknown }[]>`
    SELECT result->'schedule' AS schedule FROM planning_runs
    WHERE user_id=${userId} AND superseded_at IS NULL ORDER BY calculated_at DESC LIMIT 1`;
  const projectHealth = projectHealthFromSchedule(runs[0]?.schedule);
  const agedActionIds = agedInputIdsFromSchedule(runs[0]?.schedule);
  if (agedActionIds.size === 0) return { projectHealth, agedActionIds, actions: [] };
  const rows = await sql<
    {
      id: string;
      project_id: string;
      title: string;
      status: string;
      remaining_minutes: number;
      remaining_set_at: Date | null;
      scheduling_mode: string;
    }[]
  >`
    SELECT ac.id, ac.project_id, ac.title, ac.status, ac.remaining_minutes, ac.remaining_set_at, ac.scheduling_mode
    FROM actions ac
    JOIN projects p ON p.id = ac.project_id
    JOIN outcomes o ON o.id = p.outcome_id
    JOIN areas a ON a.id = o.area_id
    WHERE a.user_id = ${userId} AND ac.id IN ${sql([...agedActionIds])}
    LIMIT ${LIMIT}`;
  return {
    projectHealth,
    agedActionIds,
    actions: rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      status: row.status,
      remainingMinutes: row.remaining_minutes,
      ...(row.remaining_set_at ? { remainingSetAt: row.remaining_set_at.toISOString() } : {}),
      schedulingMode: row.scheduling_mode
    }))
  };
}

async function readFreshness(
  sql: Queryable,
  userId: string,
  now: Date
): Promise<{ freshness: DoctorSnapshot["freshness"] }> {
  const { activeSession } = await readSessions(sql, userId, now);
  const prefs = await sql<
    {
      max_awake_hours: number;
      last_woke_at: Date | null;
      location_id: string | null;
      location_set_at: Date | null;
      energy_set_at: Date | null;
    }[]
  >`SELECT max_awake_hours, last_woke_at,
           current_situation->>'locationId' AS location_id,
           (current_situation->>'locationSetAt')::timestamptz AS location_set_at,
           (current_situation->>'energySetAt')::timestamptz AS energy_set_at
    FROM user_preferences WHERE user_id=${userId}`;
  const row = prefs[0];
  const { projectHealth, agedActionIds, actions } = await readAgedEstimates(sql, userId);
  const lastWokeAt = row?.last_woke_at?.toISOString();
  const locationSetAt = row?.location_set_at?.toISOString();
  const energySetAt = row?.energy_set_at?.toISOString();
  return {
    freshness: resolveFreshness(
      {
        settings: { maxAwakeHours: row?.max_awake_hours ?? 18, ...(lastWokeAt ? { lastWokeAt } : {}) },
        activeSession: (activeSession ?? null) as ActiveSession,
        currentSituation: {
          locationId: row?.location_id ?? null,
          ...(locationSetAt ? { locationSetAt } : {}),
          ...(energySetAt ? { energySetAt } : {})
        },
        actions
      },
      now,
      { projectHealth, agedActionIds }
    )
  };
}

/** The open `off/lapsed` pulse segment's start: what `readPulseState` reports as `offReason: "lapsed"`. */
async function readPulseOffSince(sql: Queryable, userId: string): Promise<string | null> {
  const rows = await sql<{ started_at: Date }[]>`
    SELECT started_at FROM pulse_segments
    WHERE user_id=${userId} AND ended_at IS NULL AND state='off' AND reason='lapsed' LIMIT 1`;
  return iso(rows[0]?.started_at ?? null);
}

async function readProjects(sql: Queryable, userId: string, now: Date): Promise<DoctorSnapshot["projects"]> {
  const keptSince = new Date(now.getTime() - DOCTOR_KEEP_FOR_DAYS * DAY_MS);
  const rows = await sql<
    {
      id: string;
      title: string;
      status: string;
      last_worked_at: Date | null;
      focus: boolean;
      open_actions: number;
      open_deliverables: number;
      external_deadline_at: Date | null;
    }[]
  >`
    SELECT p.id, p.title, p.status,
      COALESCE(p.last_worked_at, p.created_at) AS last_worked_at,
      -- Focus as the review reads it: in a current weekly or monthly focus period, or kept in the last 30 days.
      (COALESCE(p.last_reviewed_at >= ${keptSince}, false) OR EXISTS (
        SELECT 1 FROM planning_focus_projects fp JOIN planning_focus_periods fo ON fo.id = fp.focus_period_id
        WHERE fp.project_id = p.id AND fo.user_id = ${userId}
          AND (SELECT (${now}::timestamptz AT TIME ZONE u.timezone)::date FROM users u WHERE u.id = ${userId})
              BETWEEN fo.period_start AND fo.period_end
      )) AS focus,
      (SELECT count(*)::int FROM actions ac WHERE ac.project_id = p.id
        AND ac.status IN ${sql([...DOCTOR_OPEN_ACTION_STATUSES])}) AS open_actions,
      (SELECT count(*)::int FROM deliverables d WHERE d.project_id = p.id
        AND d.status NOT IN ('completed','cancelled','archived')) AS open_deliverables,
      p.external_deadline_at
    FROM projects p
    JOIN outcomes oc ON oc.id = p.outcome_id
    JOIN areas ar ON ar.id = oc.area_id
    WHERE ar.user_id = ${userId} AND p.status = 'active'
    ORDER BY p.last_worked_at ASC NULLS FIRST LIMIT ${LIMIT}`;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    lastWorkedAt: iso(row.last_worked_at),
    focus: row.focus,
    openActionCount: row.open_actions,
    openDeliverableCount: row.open_deliverables,
    externalDeadlineAt: iso(row.external_deadline_at)
  }));
}

async function readActions(sql: Queryable, userId: string): Promise<DoctorSnapshot["actions"]> {
  const rows = await sql<
    {
      id: string;
      title: string;
      project_id: string;
      status: string;
      last_worked_at: Date | null;
      assumed_fields: string[];
      estimate_needs_review: boolean;
    }[]
  >`
    SELECT ac.id, ac.title, ac.project_id, ac.status, ac.last_worked_at, to_jsonb(ac.assumed_fields) AS assumed_fields, ac.estimate_needs_review
    FROM actions ac
    JOIN projects p ON p.id = ac.project_id
    JOIN outcomes oc ON oc.id = p.outcome_id
    JOIN areas ar ON ar.id = oc.area_id
    WHERE ar.user_id = ${userId} AND p.status = 'active' AND ac.status IN ${sql([...DOCTOR_OPEN_ACTION_STATUSES])}
      AND (ac.estimate_needs_review OR cardinality(ac.assumed_fields) > 0)
    ORDER BY ac.created_at DESC LIMIT ${LIMIT}`;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    status: row.status,
    lastWorkedAt: iso(row.last_worked_at),
    // Every action stores minutes (NOT NULL); "no estimate" is one the person was asked to review.
    assumedFields: row.assumed_fields.filter((field) => ESTIMATE_FIELDS.has(field)),
    hasEstimate: !row.estimate_needs_review
  }));
}

/** Days per period unit; `days` is the rule's own count of days, `month` is taken as 30. */
const PERIOD_UNIT_DAYS: Readonly<Record<string, number>> = {
  day: 1,
  days: 1,
  week: 7,
  weeks: 7,
  month: 30,
  months: 30
};

async function readRoutines(sql: Queryable, userId: string): Promise<DoctorSnapshot["routines"]> {
  const rows = await sql<
    {
      id: string;
      title: string;
      interval_days: number;
      period_unit: string | null;
      period_length: number | null;
      started_at: Date;
      end_of_last_day: Date | null;
      last_completed_at: Date | null;
    }[]
  >`
    SELECT ac.id, ac.title, r.interval_days, r.period_unit, r.period_length,
      -- The series began on its start date (midnight in the person's zone), or when the action was made if later.
      GREATEST((r.start_date::timestamp AT TIME ZONE u.timezone), ac.created_at) AS started_at,
      -- The END of the last day in the person's zone: the instant the next local day begins.
      ((r.end_date + 1)::timestamp AT TIME ZONE u.timezone) AS end_of_last_day,
      GREATEST(
        (SELECT max(o.completed_at) FROM action_occurrences o WHERE o.action_id = ac.id AND o.status = 'completed'),
        (SELECT max(c.completed_at) FROM action_cadence_completions c WHERE c.action_id = ac.id)
      ) AS last_completed_at
    FROM action_recurrence_rules r
    JOIN actions ac ON ac.id = r.action_id
    JOIN projects p ON p.id = ac.project_id
    JOIN outcomes oc ON oc.id = p.outcome_id
    JOIN areas ar ON ar.id = oc.area_id
    JOIN users u ON u.id = ar.user_id
    WHERE ar.user_id = ${userId} AND p.status = 'active' AND r.completed_at IS NULL
      AND ac.status IN ${sql([...DOCTOR_OPEN_ACTION_STATUSES])}
    ORDER BY ac.created_at DESC LIMIT ${LIMIT}`;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    intervalDays: row.period_unit
      ? (PERIOD_UNIT_DAYS[row.period_unit] ?? 1) * (row.period_length ?? 1)
      : row.interval_days,
    lastCompletedAt: iso(row.last_completed_at),
    startedAt: row.started_at.toISOString(),
    endDate: iso(row.end_of_last_day),
    // Open work reads as active to doctor's routine checks; rule and project were filtered above.
    status: "active"
  }));
}

async function readCommitments(sql: Queryable, userId: string, now: Date): Promise<DoctorSnapshot["commitments"]> {
  const until = new Date(now.getTime() + DOCTOR_THRESHOLDS.commitmentDetailDays * DAY_MS);
  const rows = await sql<
    { id: string; title: string; starts_at: Date; missing_place: boolean; missing_transport: boolean }[]
  >`
    SELECT id, title, starts_at,
      (location_id IS NULL AND NULLIF(btrim(COALESCE(location, '')), '') IS NULL) AS missing_place,
      (transport_mode IS NULL) AS missing_transport
    FROM commitments
    WHERE user_id = ${userId} AND status = 'confirmed' AND attendance = 'in_person'
      AND starts_at >= ${now} AND starts_at <= ${until}
      AND ((location_id IS NULL AND NULLIF(btrim(COALESCE(location, '')), '') IS NULL) OR transport_mode IS NULL)
    ORDER BY starts_at LIMIT ${LIMIT}`;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    startsAt: row.starts_at.toISOString(),
    // The stored "confirmed" is doctor's "scheduled"; cancelled and tentative rows are not read.
    status: "scheduled",
    missingPlace: row.missing_place,
    missingTransport: row.missing_transport
  }));
}

/**
 * Open review batches of every calendar source, interval or daily. A batch is aged by its oldest held record, not its
 * own creation: a sync that replaces the batch carries each record's first-held time across (`supersedeOpenBatches`).
 */
async function readHeldEvents(sql: Queryable, userId: string): Promise<DoctorSnapshot["heldEvents"]> {
  const rows = await sql<{ id: string; source_type: string; held_since: Date }[]>`
    SELECT b.id, b.source_type, min(r.created_at) AS held_since FROM import_batches b
    JOIN import_records r ON r.batch_id = b.id AND r.entity_type IN ('fixed_commitment','fixed_commitment_recurrence')
    WHERE b.user_id = ${userId} AND b.status IN ('draft','ready','blocked')
      AND b.source_type IN ${sql(calendarSourceIds())}
    GROUP BY b.id, b.source_type, b.created_at
    ORDER BY b.created_at LIMIT 50`;
  return rows.map((row) => ({ batchId: row.id, provider: row.source_type, heldSince: row.held_since.toISOString() }));
}

/**
 * The latest run per provider and the last time each synced, from status columns only. A latest run that failed
 * with a success inside the failing window reads as synced (a run that held changes for review, `needs_review`, is a
 * success: the connection worked): doctor flags a sync that has not worked for a day,
 * not one bad tick.
 */
async function readSyncRuns(sql: Queryable, userId: string, now: Date): Promise<DoctorSnapshot["syncRuns"]> {
  const [rows, extensionStatuses] = await Promise.all([
    sql<{ provider: string; status: string; last_run_at: Date; last_success_at: Date | null }[]>`
      SELECT DISTINCT ON (r.provider) r.provider, r.status, r.started_at AS last_run_at,
        (SELECT max(COALESCE(s.finished_at, s.started_at)) FROM integration_sync_runs s
          WHERE s.user_id = r.user_id AND s.provider = r.provider AND s.status IN ('synced','needs_review')) AS last_success_at
      FROM integration_sync_runs r WHERE r.user_id = ${userId} AND r.provider <> 'backup' AND r.provider NOT LIKE '%:%'
      ORDER BY r.provider, r.started_at DESC LIMIT 50`,
    readExtensionSyncStatuses(sql)
  ]);
  const grace = DOCTOR_THRESHOLDS.syncFailingHours * 3_600_000;
  const recent = (at: Date | string | null): boolean => at !== null && now.getTime() - new Date(at).getTime() <= grace;
  const runs: DoctorSnapshot["syncRuns"] = rows.map((row) => ({
    provider: row.provider,
    status: row.status === "failed" && recent(row.last_success_at) ? "synced" : row.status,
    lastSuccessAt: iso(row.last_success_at),
    lastRunAt: row.last_run_at.toISOString()
  }));
  for (const status of extensionStatuses)
    runs.push({
      provider: status.provider,
      status: isFailingSyncStatus(status) && !recent(status.lastSuccessAt) ? "failed" : "synced",
      lastSuccessAt: status.lastSuccessAt,
      lastRunAt: lastSyncRunAt(status)
    });
  return runs;
}

async function readReviews(sql: Queryable, userId: string, now: Date): Promise<DoctorSnapshot["reviews"]> {
  const [areas, outcomes] = await Promise.all([
    sql<{ id: string; name: string; due_at: Date }[]>`
      SELECT id, name, COALESCE(last_reviewed_at, created_at) + review_interval_days * interval '1 day' AS due_at
      FROM areas
      WHERE user_id = ${userId} AND status = 'active' AND review_interval_days IS NOT NULL
        AND COALESCE(last_reviewed_at, created_at) + review_interval_days * interval '1 day' <= ${now}
      ORDER BY due_at LIMIT ${LIMIT}`,
    sql<{ id: string; title: string; due_on: string }[]>`
      SELECT oc.id, oc.title, oc.review_on::text AS due_on
      FROM outcomes oc JOIN areas ar ON ar.id = oc.area_id
      WHERE ar.user_id = ${userId} AND oc.status = 'active' AND oc.review_on IS NOT NULL AND oc.review_on <= ${now}::date
      ORDER BY oc.review_on LIMIT ${LIMIT}`
  ]);
  return [
    ...areas.map((row) => ({ id: row.id, type: "area" as const, title: row.name, dueAt: row.due_at.toISOString() })),
    ...outcomes.map((row) => ({
      id: row.id,
      type: "outcome" as const,
      title: row.title,
      dueAt: new Date(`${row.due_on}T00:00:00Z`).toISOString()
    }))
  ];
}

async function readProposalsWaiting(sql: Queryable, userId: string): Promise<DoctorSnapshot["proposalsWaiting"]> {
  const rows = await sql<{ id: string; created_at: Date }[]>`
    SELECT id, created_at FROM captures WHERE user_id = ${userId} AND status = 'pending'
    ORDER BY created_at LIMIT ${LIMIT}`;
  return rows.map((row) => ({ id: row.id, waitingSince: row.created_at.toISOString() }));
}

async function countOpenFindings(sql: Queryable, userId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM plan_findings WHERE user_id = ${userId} AND status = 'open'`;
  return rows[0]?.n ?? 0;
}

/**
 * Builds the doctor snapshot from the database and returns `runDoctor`'s report. The catch-up owner's
 * `countCatchUpUnsettled` supplies the unsettled count (it lists the entries); the read writes nothing.
 */
export async function readDoctorReport(sql: PoolSql, opts: { now?: Date } = {}): Promise<DoctorReport> {
  const userId = await ensureUser(sql);
  const now = opts.now ?? new Date();
  const [
    { freshness },
    pulseOffSince,
    projects,
    actions,
    routines,
    commitments,
    heldEvents,
    syncRuns,
    reviews,
    catchUpUnsettled,
    openFindings,
    proposalsWaiting,
    prerequisites,
    people,
    publishing,
    cadence,
    duplicates,
    recording,
    closed,
    sources
  ] = await Promise.all([
    readFreshness(sql, userId, now),
    readPulseOffSince(sql, userId),
    readProjects(sql, userId, now),
    readActions(sql, userId),
    readRoutines(sql, userId),
    readCommitments(sql, userId, now),
    readHeldEvents(sql, userId),
    readSyncRuns(sql, userId, now),
    readReviews(sql, userId, now),
    countCatchUpUnsettled(sql, userId, now),
    countOpenFindings(sql, userId),
    readProposalsWaiting(sql, userId),
    readPrerequisitesSlice(sql, userId, now),
    readPeopleSlice(sql, userId, now),
    readPublishingSlice(sql, userId, now),
    readCadenceSlice(sql, userId, now),
    readDuplicatesSlice(sql, userId, now),
    readRecordingSlice(sql, userId),
    readClosedSlice(sql, userId),
    readSourcesSlice(sql, now, userId)
  ]);
  return runDoctor({
    now: now.toISOString(),
    unregisteredDiffProfiles: unregisteredDiffProfiles(),
    freshness,
    pulseOffSince,
    projects,
    actions,
    routines,
    commitments,
    heldEvents,
    syncRuns,
    reviews,
    catchUpUnsettled: catchUpUnsettled,
    openFindings,
    proposalsWaiting,
    prerequisites,
    people,
    publishing,
    cadence,
    duplicates,
    recording,
    closed,
    sources
  });
}
