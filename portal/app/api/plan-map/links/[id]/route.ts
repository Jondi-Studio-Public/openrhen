import { planMapLinkActionSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { decideLink } from "@/server/persistence/postgres/plan-map-store";
import { isUuid, parseBody, planMapContext } from "@/server/plan-map/route-support";

/** Confirms, rejects, removes or reopens one stored link. */
export const POST = withRoute(
  "/api/plan-map/links/[id]",
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const body = await parseBody(request, planMapLinkActionSchema);
    if (body instanceof Response) return body;
    if (!isUuid(id)) return Response.json({ error: "No such link.", code: "not_found" }, { status: 404 });
    const context = await planMapContext();
    if (context instanceof Response) return context;
    const result = await decideLink(context.sql, context.userId, id, body.data.action);
    if (result.ok) return Response.json({ link: result.link });
    return Response.json(
      { error: result.reason, code: result.code },
      { status: result.code === "not_found" ? 404 : 409 }
    );
  }
);
