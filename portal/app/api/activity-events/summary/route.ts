import { withRoute } from "@/server/logging";
import { readActivitySummary } from "@/server/persistence/postgres/activity-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/** Counts and the last event per source, each source's content gate and retention, and recent imports. The owner's own read. */
export const GET = withRoute("/api/activity-events/summary", async () => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "The activity store requires PostgreSQL." }, { status: 503 });
  return Response.json(await readActivitySummary(sqlPool(connectionString)), {
    headers: { "cache-control": "no-store" }
  });
});
