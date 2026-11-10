import type { DoctorRecordingSlice } from "@openrhen/contracts";
import { readLastPhonePingAt } from "@/server/location/location-observation-store";
import { locationPingToken } from "@/server/runtime-env";
import type { PoolSql, Sql } from "./sql-pool";

/**
 * The recorded-elsewhere family of the data health check: the nightly backup (a `backup` row in
 * `integration_sync_runs`, written by scripts/backup/scheduled.mjs), the phone's last location ping and the agent wakes that went dead in the last 24 h. Status and
 * times only: never a path, host or coordinate.
 */
export async function readRecordingSlice(sql: Sql, userId: string): Promise<DoctorRecordingSlice> {
  const [rows, lastPing, wakes, tokens, reported] = await Promise.all([
    sql<{ status: string; last_run_at: Date; last_success_at: Date | null; summary: unknown }[]>`
      SELECT r.status, r.started_at AS last_run_at, r.summary,
        (SELECT max(COALESCE(s.finished_at, s.started_at)) FROM integration_sync_runs s
          WHERE s.user_id = r.user_id AND s.provider = 'backup' AND s.status IN ('synced', 'needs_review')) AS last_success_at
      FROM integration_sync_runs r
      WHERE r.user_id = ${userId} AND r.provider = 'backup'
      ORDER BY r.started_at DESC LIMIT 1`,
    readLastPhonePingAt(sql as PoolSql, userId),
    sql<{ count: number; last_error: string | null }[]>`
      SELECT count(*)::int AS count,
        (SELECT w.last_error FROM agent_wakes w WHERE w.user_id = ${userId} AND w.status = 'dead'
          AND w.created_at > now() - interval '24 hours' ORDER BY w.created_at DESC LIMIT 1) AS last_error
      FROM agent_wakes
      WHERE user_id = ${userId} AND status = 'dead' AND created_at > now() - interval '24 hours'`,
    sql<{ name: string; expires_at: Date; last_used_at: Date | null }[]>`
      SELECT name, expires_at, last_used_at FROM agent_tokens WHERE user_id = ${userId} AND revoked_at IS NULL ORDER BY name`,
    sql<{ last: Date | null }[]>`
      SELECT max(ended_at) AS last FROM agent_sessions WHERE user_id = ${userId} AND source = 'reported'`
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
    phonePing: { configured: locationPingToken() !== undefined, lastPingAt: lastPing ? lastPing.toISOString() : null },
    agentTokens: tokens.map((token) => ({
      name: token.name,
      expiresAt: token.expires_at.toISOString(),
      lastUsedAt: token.last_used_at ? token.last_used_at.toISOString() : null
    })),
    agentTime: { lastReportedAt: reported[0]?.last ? reported[0].last.toISOString() : null },
    deadAgentWakes: { count: wakes[0]?.count ?? 0, lastError: wakes[0]?.last_error ?? null }
  };
}

/**
 * True when the run's summary jsonb has `key: true`. Older rows and failed runs lack the key. scripts/backup/record-run.mjs
 * passes the summary as a JSON string cast to jsonb, which postgres.js can store as a jsonb string rather than an object,
 * so a string is parsed first.
 */
function summaryFlag(summary: unknown, key: string): boolean {
  let value = summary;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  return typeof value === "object" && value !== null && (value as Record<string, unknown>)[key] === true;
}
