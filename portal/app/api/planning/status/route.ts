import { withRoute } from "@/server/logging";
import { readPlanningStatus } from "@/server/persistence/postgres/state-read";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The freshness of the plan, and nothing else.
 *
 * The browser asks this on a short poll after a command and on its ordinary tick. `/api/state`
 * hydrates the whole planning document — every action, occurrence, deliverable and the engine result
 * itself — which is far too much to ask for repeatedly just to learn whether a recalculation has
 * finished. When the answer here changes, the browser fetches the full state once.
 *
 * Logged as a probe for the same reason the container healthcheck is: a poll every two seconds would
 * bury every real request under its own successes, while a failing poll still writes its line.
 */
export const GET = withRoute(
  "/api/planning/status",
  async (_request, _context, log) => {
    const connectionString = databaseUrl();
    if (!connectionString) {
      log.setError(new Error("DATABASE_URL is not set."));
      return Response.json({ error: "The planning status is unavailable." }, { status: 503 });
    }
    const status = await readPlanningStatus(sqlPool(connectionString));
    // Nothing about this answer survives a second, and a cached one would strand the poll on the
    // value it started with.
    return Response.json(status, { headers: { "cache-control": "no-store" } });
  },
  { probe: true }
);
