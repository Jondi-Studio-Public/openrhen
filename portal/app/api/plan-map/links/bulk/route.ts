import { planMapBulkConfirmSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { bulkConfirm } from "@/server/persistence/postgres/plan-map-store";
import { parseBody, planMapContext } from "@/server/plan-map/route-support";

/** Confirms every still-suggested link from one proposer of one kind, and names them so Undo can reopen them. */
export const POST = withRoute("/api/plan-map/links/bulk", async (request) => {
  const body = await parseBody(request, planMapBulkConfirmSchema);
  if (body instanceof Response) return body;
  const context = await planMapContext();
  if (context instanceof Response) return context;
  const ids = await bulkConfirm(context.sql, context.userId, body.data.proposer, body.data.kind);
  return Response.json({ confirmed: ids.length, ids });
});
