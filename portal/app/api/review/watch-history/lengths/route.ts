import { withRoute } from "@/server/logging";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { fetchMissingVideoLengths } from "@/server/persistence/postgres/video-lengths-store";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Looks up the length of watched videos that have none, with the person's saved YouTube key through the outbound
 * proxy: up to 1,000 videos a call (the panel repeats it while `remaining` falls). Stops cleanly with a plain
 * message on no key, a bad key, the day's quota or no network, and resumes on the next call. Owner-only; the key
 * is never in the request or the answer.
 */
export const POST = withRoute("/api/review/watch-history/lengths", async (_request, _context, log) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Watch history requires PostgreSQL." }, { status: 503 });
  try {
    log.setCommandType("fetch_video_lengths");
    return Response.json(await fetchMissingVideoLengths(sqlPool(connectionString)), {
      headers: { "cache-control": "no-store" }
    });
  } catch (error) {
    log.setError(error);
    throw error;
  }
});
