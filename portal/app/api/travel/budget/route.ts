import { redact, withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { getStateStore } from "@/server/persistence/state-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import { readTravelLookupsRemaining } from "@/server/travel/travel-spend";
import type { PortalState } from "@/state/portal-state";

/**
 * "N of 100 lookups left today" for the Situation panel (the travel time model design note,
 * "Spending the budget (T5)"). Read-only and side-effect free, so `GET` fits, unlike Manual Measure —
 * a plain page load or prefetch can safely trigger it. The panel already reads everything else about
 * the situation off the whole-state fetch it is handed as a prop; the budget count is the one thing
 * that moves independently of a save (the worker's own scheduled ticks spend it too), so it is its
 * own small route rather than one more field threaded onto every state read.
 */
export const GET = withRoute("/api/travel/budget", async (_request, _context, log) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Travel lookups require PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);

  const state = (await getStateStore()
    .get()
    .catch(() => null)) as PortalState | null;
  if (!state) return Response.json({ error: "Portal state is unavailable." }, { status: 503 });

  try {
    const userId = await ensureUser(sql);
    return Response.json(await readTravelLookupsRemaining(sql, userId, state.settings.timezone));
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : "The lookup budget could not be read." },
      { status: 502 }
    );
  }
});
