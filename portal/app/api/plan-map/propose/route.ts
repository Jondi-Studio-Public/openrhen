import { redact, withRoute } from "@/server/logging";
import { runPlanMapProposers } from "@/server/persistence/postgres/plan-map-proposers";
import { planMapContext } from "@/server/plan-map/route-support";

/**
 * Runs the plan-map rule proposers now. The daily sweep runs them
 * too; this is the manual trigger. Advisory: it only writes suggested links and shadow-log notes, and does
 * nothing while the `proposers` switch is off.
 */
export const POST = withRoute("/api/plan-map/propose", async (_request, _context, log) => {
  const context = await planMapContext();
  if (context instanceof Response) return context;
  try {
    return Response.json({ status: "ok", ...(await runPlanMapProposers(context.sql, context.userId)) });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : "The plan map proposers failed." },
      { status: 502 }
    );
  }
});
