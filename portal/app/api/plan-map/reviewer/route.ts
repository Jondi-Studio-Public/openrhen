import { previewReviewerDigest } from "@openrhen/database";
import { withRoute } from "@/server/logging";
import { planMapContext } from "@/server/plan-map/route-support";

/**
 * What the weekly reviewer's digest would say right now.
 * Read-only: it logs and sends nothing, so the owner can read the digest before turning the switch on.
 */
export const GET = withRoute("/api/plan-map/reviewer", async () => {
  const context = await planMapContext();
  if (context instanceof Response) return context;
  const digest = await previewReviewerDigest(context.sql, context.userId);
  return Response.json({ digest }, { headers: { "cache-control": "no-store" } });
});
