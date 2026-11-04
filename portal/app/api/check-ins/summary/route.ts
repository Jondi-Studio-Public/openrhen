import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readCheckInSummary } from "@/server/persistence/postgres/readers/check-in-read";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/** The bare tally Review shows: how often a check-in actually got answered, and what it said. */
export const GET = withRoute("/api/check-ins/summary", async () => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Check-ins require PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  const summary = await readCheckInSummary(sql, userId);
  return Response.json({ summary });
});
