import { planLinkInputSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { createManualLink } from "@/server/persistence/postgres/plan-map-store";
import { parseBody, planMapContext } from "@/server/plan-map/route-support";

/** Links two plan items by hand: a confirmed link, proposer `owner`. */
export const POST = withRoute("/api/plan-map/links", async (request) => {
  const body = await parseBody(request, planLinkInputSchema);
  if (body instanceof Response) return body;
  const context = await planMapContext();
  if (context instanceof Response) return context;
  const result = await createManualLink(context.sql, context.userId, body.data);
  if (result.ok) return Response.json({ link: result.link });
  const status = result.code === "invalid_ends" ? 400 : result.code === "missing_end" ? 404 : 409;
  return Response.json({ error: result.reason, code: result.code }, { status });
});
