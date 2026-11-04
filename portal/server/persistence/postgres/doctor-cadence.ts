import { calendarSourceIds, type CadenceDueRule, type DoctorCadenceSlice } from "@openrhen/contracts";
import "./private/index";
import { isFailingSyncStatus, lastSyncRunAt, readExtensionSyncStatuses } from "./sync-status-extensions";
import type { Sql } from "./sql-pool";

/**
 * The cadence checks' reader (the design notes, `doctor-cadence.ts` in contracts): cadences with the
 * completion log their own due rule needs, recent settled occurrences of recurring actions, and each sync
 * provider's latest run. User-scoped and bounded; dates are local dates in each rule's own timezone. Status only: no
 * run summary, error text or subject is read. Writes nothing.
 */

const LIMIT = 500;
const COMPLETION_WINDOW_DAYS = 70;
const RECENT_OCCURRENCES = 10;

const OPEN_STATUSES = ["inbox", "planned", "active", "doing", "waiting", "blocked"] as const;

async function readCadences(sql: Sql, userId: string, now: Date): Promise<DoctorCadenceSlice["cadences"]> {
  const since = new Date(now.getTime() - COMPLETION_WINDOW_DAYS * 86_400_000);
  const rows = await sql<
    {
      id: string;
      title: string;
      timezone: string;
      interval_days: number;
      start_date: string;
      period_unit: string | null;
      period_length: number | null;
      target_occurrences: number | null;
      min_spacing_days: number | null;
      eligible_weekdays: number[] | null;
      last_local_date: string | null;
      recent_dates: string[] | null;
    }[]
  >`
    SELECT ac.id, ac.title, r.timezone, r.interval_days, r.start_date::text AS start_date, r.period_unit, r.period_length,
      r.target_occurrences, r.min_spacing_days, r.eligible_weekdays,
      (SELECT max(c.local_date)::text FROM action_cadence_completions c WHERE c.rule_id = r.id) AS last_local_date,
      (SELECT to_jsonb(array_agg(c.local_date::text ORDER BY c.local_date)) FROM action_cadence_completions c
        WHERE c.rule_id = r.id AND c.completed_at >= ${since}) AS recent_dates
    FROM action_recurrence_rules r
    JOIN actions ac ON ac.id = r.action_id
    JOIN projects p ON p.id = ac.project_id
    JOIN outcomes oc ON oc.id = p.outcome_id
    JOIN areas ar ON ar.id = oc.area_id
    WHERE ar.user_id = ${userId} AND p.status = 'active' AND r.completed_at IS NULL
      AND ac.scheduling_mode = 'cadence' AND ac.status IN ${sql([...OPEN_STATUSES])}
      AND (r.end_date IS NULL OR r.end_date >= (${now}::timestamptz AT TIME ZONE r.timezone)::date)
    ORDER BY ac.created_at DESC LIMIT ${LIMIT}`;
  return rows.map((row) => {
    const rule: CadenceDueRule = {
      intervalDays: row.interval_days,
      timezone: row.timezone,
      startDate: row.start_date,
      ...(row.last_local_date ? { lastCompletedLocalDate: row.last_local_date } : {}),
      ...(row.period_unit === "month"
        ? { period: { unit: "month" as const } }
        : row.period_unit === "days" && row.period_length
          ? { period: { unit: "days" as const, length: row.period_length } }
          : {}),
      ...(row.target_occurrences ? { targetOccurrences: row.target_occurrences } : {}),
      ...(row.min_spacing_days ? { minSpacingDays: row.min_spacing_days } : {}),
      ...(row.eligible_weekdays?.length ? { eligibleWeekdays: row.eligible_weekdays } : {}),
      completionLocalDates: row.recent_dates ?? []
    };
    return { id: row.id, title: row.title, rule };
  });
}

async function readRecurring(sql: Sql, userId: string, now: Date): Promise<DoctorCadenceSlice["recurring"]> {
  const rows = await sql<{ action_id: string; title: string; local_date: string; status: string }[]>`
    WITH mine AS (
      SELECT ac.id, ac.title FROM actions ac
      JOIN projects p ON p.id = ac.project_id
      JOIN outcomes oc ON oc.id = p.outcome_id
      JOIN areas ar ON ar.id = oc.area_id
      JOIN action_recurrence_rules r ON r.action_id = ac.id
      WHERE ar.user_id = ${userId} AND p.status = 'active' AND r.completed_at IS NULL
        AND ac.scheduling_mode = 'recurring' AND ac.status IN ${sql([...OPEN_STATUSES])}
        AND (r.end_date IS NULL OR r.end_date >= (${now}::timestamptz AT TIME ZONE r.timezone)::date)
      ORDER BY ac.created_at DESC LIMIT ${LIMIT}
    )
    SELECT m.id AS action_id, m.title, o.local_date::text AS local_date, o.status, o.window_starts_at
    FROM mine m
    JOIN LATERAL (
      SELECT local_date, status, window_starts_at FROM action_occurrences
      WHERE action_id = m.id AND status IN ('completed','missed')
      ORDER BY local_date DESC, window_starts_at DESC LIMIT ${RECENT_OCCURRENCES}
    ) o ON true
    ORDER BY m.id, o.local_date DESC, o.window_starts_at DESC`;
  const byAction = new Map<string, DoctorCadenceSlice["recurring"][number]>();
  for (const row of rows) {
    const entry = byAction.get(row.action_id) ?? { id: row.action_id, title: row.title, recent: [] };
    entry.recent.push({ localDate: row.local_date, status: row.status });
    byAction.set(row.action_id, entry);
  }
  return [...byAction.values()];
}

async function readSyncs(sql: Sql, userId: string): Promise<DoctorCadenceSlice["syncs"]> {
  const [rows, extensionStatuses] = await Promise.all([
    sql<{ provider: string; status: string; last_run_at: Date; last_success_at: Date | null }[]>`
      SELECT DISTINCT ON (r.provider) r.provider, r.status, r.started_at AS last_run_at,
        (SELECT max(COALESCE(s.finished_at, s.started_at)) FROM integration_sync_runs s
          WHERE s.user_id = r.user_id AND s.provider = r.provider AND s.status IN ('synced','needs_review')) AS last_success_at
      FROM integration_sync_runs r
      WHERE r.user_id = ${userId} AND r.provider IN ${sql(calendarSourceIds())}
      ORDER BY r.provider, r.started_at DESC LIMIT 10`,
    readExtensionSyncStatuses(sql)
  ]);
  const syncs: DoctorCadenceSlice["syncs"] = rows.map((row) => ({
    provider: row.provider,
    lastRunStatus: row.status,
    lastRunAt: row.last_run_at.toISOString(),
    lastSuccessAt: row.last_success_at ? row.last_success_at.toISOString() : null
  }));
  for (const status of extensionStatuses)
    syncs.push({
      provider: status.provider,
      lastRunStatus: isFailingSyncStatus(status) ? "failed" : "synced",
      lastRunAt: lastSyncRunAt(status),
      lastSuccessAt: status.lastSuccessAt
    });
  return syncs;
}

/** Reads the cadence slice for one user; the timezone each cadence's local dates use is its rule's own. */
export async function readCadenceSlice(sql: Sql, userId: string, now: Date): Promise<DoctorCadenceSlice> {
  const [cadences, recurring, syncs] = await Promise.all([
    readCadences(sql, userId, now),
    readRecurring(sql, userId, now),
    readSyncs(sql, userId)
  ]);
  return { cadences, recurring, syncs };
}
