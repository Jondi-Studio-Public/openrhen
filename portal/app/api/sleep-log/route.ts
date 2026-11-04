import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readSleepLog } from "@/server/persistence/postgres/readers/sleep-log-read";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

const DEFAULT_SINCE_DAYS = 30;
const MAXIMUM_SINCE_DAYS = 90;

/**
 * The sleep log's own history read, separate from the narrow window `readPortalState` carries in
 * every poll response. `?days=` picks how far back to look (capped so a stray large value cannot
 * turn this into an unbounded table scan); omitted or invalid falls back to 30.
 */
export const GET = withRoute("/api/sleep-log", async (request) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "The sleep log requires PostgreSQL." }, { status: 503 });
  const requested = Number(new URL(request.url).searchParams.get("days"));
  const sinceDays =
    Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAXIMUM_SINCE_DAYS) : DEFAULT_SINCE_DAYS;
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  const sleepPlans = await readSleepLog(sql, userId, { sinceDays });
  return Response.json({ sleepPlans });
});
