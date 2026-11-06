import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readWatchHistoryReview, WatchHistoryInputError } from "@/server/persistence/postgres/watch-history-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Review's watch-history counts: watches per local day and local hour (the person's configured time zone) for
 * `from`..`to` (local dates, default the last 30 days) and a ranged time estimate. The owner's own read.
 */
export const GET = withRoute("/api/review/watch-history", async (request, _context, log) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Watch history requires PostgreSQL." }, { status: 503 });
  const params = new URL(request.url).searchParams;
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  try {
    return Response.json(
      await readWatchHistoryReview(sql, userId, {
        from: params.get("from") ?? undefined,
        to: params.get("to") ?? undefined
      }),
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof WatchHistoryInputError) return Response.json({ error: error.message }, { status: 400 });
    log.setError(error);
    throw error;
  }
});
