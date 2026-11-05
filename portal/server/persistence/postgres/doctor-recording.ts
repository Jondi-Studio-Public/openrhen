import type { DoctorRecordingSlice } from "@openrhen/contracts";
import { readLastPhonePingAt } from "@/server/location/location-observation-store";
import { locationPingToken } from "@/server/runtime-env";
import type { PoolSql, Sql } from "./sql-pool";

/**
 * The recorded-elsewhere family of the data health check: the nightly backup (a `backup` row in
 * `integration_sync_runs`, written by scripts/backup/scheduled.mjs) and the phone's last location ping. Status and
 * times only: never a path, host or coordinate.
 */
export async function readRecordingSlice(sql: Sql, userId: string): Promise<DoctorRecordingSlice> {
  const [rows, lastPing] = await Promise.all([
    sql<{ status: string; last_run_at: Date; last_success_at: Date | null; summary: unknown }[]>`
      SELECT r.status, r.started_at AS last_run_at, r.summary,
        (SELECT max(COALESCE(s.finished_at, s.started_at)) FROM integration_sync_runs s
          WHERE s.user_id = r.user_id AND s.provider = 'backup' AND s.status IN ('synced', 'needs_review')) AS last_success_at
      FROM integration_sync_runs r
      WHERE r.user_id = ${userId} AND r.provider = 'backup'
      ORDER BY r.started_at DESC LIMIT 1`,
    readLastPhonePingAt(sql as PoolSql, userId)
  ]);
  const row = rows[0];
  return {
    backup: row
      ? {
          status: row.status,
          lastRunAt: row.last_run_at.toISOString(),
          lastSuccessAt: row.last_success_at ? row.last_success_at.toISOString() : null,
          ...(summaryFlag(row.summary, "localOnly") ? { localOnly: true } : {}),
          ...(summaryFlag(row.summary, "restoreSkipped") ? { restoreSkipped: true } : {})
        }
      : null,
    phonePing: { configured: locationPingToken() !== undefined, lastPingAt: lastPing ? lastPing.toISOString() : null }
  };
}

/** True when the run's summary jsonb has `key: true`. Older rows and failed runs lack the key. */
function summaryFlag(summary: unknown, key: string): boolean {
  return typeof summary === "object" && summary !== null && (summary as Record<string, unknown>)[key] === true;
}
