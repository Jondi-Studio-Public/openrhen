import { withRoute } from "@/server/logging";
import { DRIFT_REPORT_DEFAULT_DAYS, DRIFT_REPORT_MAX_DAYS, readDriftReport } from "@/server/drift/drift-report";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

const DAY_MS = 86_400_000;

function instant(value: string | null): Date | null | "invalid" {
  if (value === null || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "invalid" : parsed;
}

/**
 * The moments the person drifted off the plan, as episodes: one per drift however many signals saw it. Read-only; no
 * switch. `?days=` (default 30, at most 90) looks back from now; `?from=` and `?to=` (ISO times) pick a window of at
 * most 90 days instead; `?legacyBefore=` skips sessions created before that time, where a missing sanction only means
 * the column did not exist yet.
 */
export const GET = withRoute("/api/drift-report", async (request) => {
  const connectionString = databaseUrl();
  if (!connectionString)
    return Response.json(
      {
        error:
          "The drift report requires PostgreSQL. Set DATABASE_URL for the portal to a reachable PostgreSQL database, restart it, then call GET /api/drift-report again."
      },
      { status: 503 }
    );
  const params = new URL(request.url).searchParams;
  const now = new Date();
  const from = instant(params.get("from"));
  const to = instant(params.get("to"));
  const legacyBefore = instant(params.get("legacyBefore"));
  if (from === "invalid" || to === "invalid" || legacyBefore === "invalid")
    return Response.json(
      {
        error:
          "from, to and legacyBefore must be ISO 8601 times such as 2026-01-05T09:00:00Z. Fix the value and call GET /api/drift-report again."
      },
      { status: 400 }
    );
  const requestedDays = Number(params.get("days"));
  const days =
    Number.isFinite(requestedDays) && requestedDays > 0
      ? Math.min(requestedDays, DRIFT_REPORT_MAX_DAYS)
      : DRIFT_REPORT_DEFAULT_DAYS;
  const end = to ?? now;
  const start = from ?? new Date(end.getTime() - days * DAY_MS);
  if (start.getTime() >= end.getTime() || end.getTime() - start.getTime() > DRIFT_REPORT_MAX_DAYS * DAY_MS)
    return Response.json(
      {
        error: `The window must end after it starts and span at most ${DRIFT_REPORT_MAX_DAYS} days. Change from and to, or use days, and call GET /api/drift-report again.`
      },
      { status: 400 }
    );
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  return Response.json(await readDriftReport(sql, userId, { from: start, to: end, legacyBefore, now }));
});
