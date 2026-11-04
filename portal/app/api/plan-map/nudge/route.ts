import { readNudgeSummary } from "@openrhen/database";
import { withRoute } from "@/server/logging";
import { planMapContext } from "@/server/plan-map/route-support";

const DAY_MS = 86_400_000;

/**
 * The weekly nudge comparison: per cap, what the shadow pass
 * would have moved, whether it then got done, and whether anything due would have slipped. Read-only;
 * nothing here changes the ranking.
 */
export const GET = withRoute("/api/plan-map/nudge", async () => {
  const context = await planMapContext();
  if (context instanceof Response) return context;
  const since = new Date(Date.now() - 7 * DAY_MS);
  const caps = await readNudgeSummary(context.sql, context.userId, since);
  return Response.json({ since: since.toISOString(), caps }, { headers: { "cache-control": "no-store" } });
});
