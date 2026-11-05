import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readCurrentCheckIn } from "@/server/persistence/postgres/readers/check-in-read";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { photoPromptDue } from "@/server/persistence/postgres/photo-checkin-store";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The one check-in worth showing right now, if any — polled from the portal's existing status tick
 * (`portal-provider.tsx`'s `checkPlanFreshness`) rather than a loop of its own. Deliberately outside
 * `readPortalState`: unlike the narrow sleep-plan window that hot path already carries, this table has
 * no bearing on planning at all, so it gets its own cheap, separately-cacheable read.
 */
export const GET = withRoute("/api/check-ins/current", async (request) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Check-ins require PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  // `?peek=1` (agent `status`) reads without marking the question shown; the portal and device surfaces stamp.
  const peek = new URL(request.url).searchParams.get("peek") === "1";
  const checkIn = await readCurrentCheckIn(sql, userId, { stamp: !peek });
  // Rides on the check-in itself so the portal's one poll carries it: the hourly photo is asked for
  // alongside an open check-in, never on a clock of its own.
  const photoRequested = checkIn ? await photoPromptDue(sql, userId, new Date()) : false;
  return Response.json({ checkIn: checkIn ? { ...checkIn, photoRequested } : null });
});
