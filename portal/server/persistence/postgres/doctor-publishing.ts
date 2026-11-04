import { calendarSinkConnection, type DoctorPublishingSlice } from "@openrhen/contracts";
import "@/server/drop-ins";
import { pushTransports } from "@/server/push/push-transports";
import type { Sql } from "./sql-pool";

/**
 * The publishing and delivery slice of the data health check: the calendar provider publication rows, push delivery and the
 * pulse publish. Status only (counts, states, times, row ids); `last_error`, endpoints and device tokens are
 * never selected. Every query is user-scoped and bounded.
 */
const LIMIT = 200;

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export async function readPublishingSlice(sql: Sql, userId: string, now: Date): Promise<DoctorPublishingSlice> {
  const [sinkRows, push, otherDevices, pulse] = await Promise.all([
    sql<
      {
        status: string;
        n: number;
        permanent: number;
        max_attempts: number;
        since: Date | null;
      }[]
    >`
      SELECT status, count(*)::int AS n,
             count(*) FILTER (WHERE next_attempt_at IS NULL)::int AS permanent,
             COALESCE(max(attempts), 0)::int AS max_attempts,
             min(updated_at) AS since
      FROM calendar_publications
      WHERE user_id=${userId}
        AND (status='failed'
             OR (status='remote_missing'
                 AND COALESCE((last_pushed_snapshot->>'endsAt')::timestamptz, ${now}) >= ${now}))
      GROUP BY status`,
    sql<
      {
        id: string;
        failure_count: number;
        last_success_at: Date | null;
        last_failure_at: Date;
        created_at: Date;
      }[]
    >`
      SELECT id, failure_count, last_success_at, last_failure_at, created_at
      FROM push_subscriptions
      WHERE user_id=${userId} AND failure_count > 0 AND last_failure_at IS NOT NULL
        AND (last_success_at IS NULL OR last_failure_at > last_success_at)
      ORDER BY last_failure_at DESC LIMIT ${LIMIT}`,
    Promise.all(pushTransports().map((transport) => transport.failingDevices(sql, userId, LIMIT))),
    sql<{ outcome: string; last_published_at: Date | null }[]>`
      SELECT ps.last_publish_outcome AS outcome, ps.last_published_at
      FROM pulse_state ps
      JOIN user_preferences up ON up.user_id = ps.user_id
      WHERE ps.user_id=${userId} AND up.pulse_publish_enabled = true
        AND ps.last_publish_outcome IS NOT NULL AND ps.last_publish_outcome <> 'delivered'`
  ]);

  const failed = sinkRows.find((row) => row.status === "failed");
  const missing = sinkRows.find((row) => row.status === "remote_missing");
  const pulseRow = pulse[0];
  const toDevice = (row: (typeof push)[number]) => ({
    id: row.id,
    kind: "web_push",
    label: "browser",
    handleKind: "push_subscription",
    failureCount: row.failure_count,
    lastSuccessAt: iso(row.last_success_at),
    lastFailureAt: row.last_failure_at.toISOString(),
    createdAt: row.created_at.toISOString()
  });

  const sink = calendarSinkConnection();
  return {
    calendarSink:
      sink && (failed || missing)
        ? {
            id: sink.id,
            label: sink.label,
            failed: failed?.n ?? 0,
            failedPermanent: failed?.permanent ?? 0,
            remoteMissing: missing?.n ?? 0,
            maxAttempts: failed?.max_attempts ?? 0,
            failingSince: iso(failed?.since ?? null),
            missingSince: iso(missing?.since ?? null)
          }
        : null,
    pushDevices: [...push.map(toDevice), ...otherDevices.flat()],
    pulse: pulseRow
      ? {
          outcome: pulseRow.outcome,
          lastPublishedAt: iso(pulseRow.last_published_at)
        }
      : null
  };
}
