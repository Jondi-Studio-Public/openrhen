import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readProjectRecordedMinutes } from "@/server/persistence/postgres/readers/area-time-read";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import { AREA_BALANCE_WINDOW_DAYS } from "@/features/review/area-balance";

/** Recorded time per project over Review's area-balance window; Review folds it into areas. */
export const GET = withRoute("/api/review/area-time", async () => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Area balance requires PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  const now = new Date();
  const since = new Date(now.getTime() - AREA_BALANCE_WINDOW_DAYS * 86_400_000);
  const projects = await readProjectRecordedMinutes(sql, userId, since, now);
  return Response.json({ since: since.toISOString(), projects });
});
