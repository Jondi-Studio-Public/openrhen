import { planForecastResponseSchema, type PlanForecastResponse } from "@openrhen/contracts";
import { localDayKey } from "@/features/today/today-view";
import { diffDayPlans, type PlanChangeSummary } from "@/features/planning/plan-diff";
import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool, type Sql } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unavailable(): PlanChangeSummary {
  return {
    available: false,
    moved: [],
    dropped: [],
    added: [],
    sleepShiftMinutes: 0,
    beforeNightPlannedStartAt: null,
    newlyDisplaced: []
  };
}

async function loadRun(sql: Sql, userId: string, atOrBefore: Date | null): Promise<PlanForecastResponse | undefined> {
  const rows = atOrBefore
    ? await sql<{ result: unknown }[]>`
        SELECT result FROM planning_runs
        WHERE user_id=${userId} AND calculated_at <= ${atOrBefore}
        ORDER BY calculated_at DESC LIMIT 1
      `
    : await sql<{ result: unknown }[]>`
        SELECT result FROM planning_runs
        WHERE user_id=${userId} AND superseded_at IS NULL
        ORDER BY calculated_at DESC LIMIT 1
      `;
  const parsed = rows[0] ? planForecastResponseSchema.safeParse(rows[0].result) : null;
  return parsed?.success ? parsed.data : undefined;
}

/**
 * "What changed" around a disruption: the current planning run diffed against the newest run that
 * was already current when the disruption's `landed_at` hit, restricted to that local day.
 *
 * Read-only and deliberately un-strict: a missing disruption, a disruption never marked landed, a
 * pruned before-run (superseded rows are retained 7 days / 50 per user), or a stored result that no
 * longer parses against the contract all degrade to `{available:false}` rather than a 500 — absence
 * of history is an ordinary answer here, not a fault.
 */
export const GET = withRoute("/api/planning/changes", async (request) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json(unavailable(), { status: 503 });
  const disruptionId = new URL(request.url).searchParams.get("disruptionId");
  // The id column is a uuid, so a malformed value would fail at the Postgres type level before the
  // missing-row degradation below could answer; "not even an id" is absence too, not a fault.
  if (!disruptionId || !UUID_SHAPE.test(disruptionId))
    return Response.json(unavailable(), { status: 200, headers: { "cache-control": "no-store" } });

  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);

  const [commitmentRows, userRows] = await Promise.all([
    sql<{ landed_at: Date | null }[]>`
      SELECT landed_at FROM commitments WHERE id=${disruptionId} AND user_id=${userId}
    `,
    sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id=${userId}`
  ]);
  const landedAt = commitmentRows[0]?.landed_at ?? null;
  const timezone = userRows[0]?.timezone;
  if (!landedAt || !timezone)
    return Response.json(unavailable(), { status: 200, headers: { "cache-control": "no-store" } });

  const [before, after] = await Promise.all([loadRun(sql, userId, landedAt), loadRun(sql, userId, null)]);
  const dayKey = localDayKey(landedAt, timezone);
  const summary = diffDayPlans(before, after, { dayKey, timezone });
  return Response.json(summary, { headers: { "cache-control": "no-store" } });
});
