import { withRoute } from "@/server/logging";
import { listPlanMap } from "@/server/persistence/postgres/plan-map-store";
import { planMapContext } from "@/server/plan-map/route-support";

/** The stored plan map: subjects, links, findings and add-on switches. Advisory; read-only. */
export const GET = withRoute("/api/plan-map", async () => {
  const context = await planMapContext();
  if (context instanceof Response) return context;
  const map = await listPlanMap(context.sql, context.userId);
  return Response.json(map, { headers: { "cache-control": "no-store" } });
});
