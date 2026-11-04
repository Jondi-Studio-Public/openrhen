import { DEFAULT_TIMEZONE } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import { buildPulsePreview, readPulseDeliveryStatus } from "@/server/pulse/pulse-publisher";

/**
 * `GET /api/pulse/preview`: exactly the
 * object the next publish would send — one seq ahead, nothing written — plus the last delivery,
 * for Settings → Pulse. `pulse: null` when the recorder has never evaluated this user yet.
 */
export const GET = withRoute("/api/pulse/preview", async (_request, _context, log) => {
  const connectionString = databaseUrl();
  if (!connectionString)
    return Response.json({ pulse: null, lastPublishedAt: null, lastPublishOutcome: null, lastPublishError: null });
  try {
    const sql = sqlPool(connectionString);
    const userId = await ensureUser(sql);
    const userRows = await sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id=${userId}`;
    const timeZone = userRows[0]?.timezone ?? DEFAULT_TIMEZONE;
    const pulse = await buildPulsePreview(sql, userId, new Date(), timeZone);
    const delivery = await readPulseDeliveryStatus(sql, userId);
    return Response.json({ pulse: pulse ?? null, ...delivery });
  } catch (error) {
    log.setError(error);
    return Response.json({ pulse: null, lastPublishedAt: null, lastPublishOutcome: null, lastPublishError: null });
  }
});
