import { planMapFindingActionSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { FindingQuestionsError, decideFinding, reopenFinding } from "@/server/persistence/postgres/plan-map-store";
import { isUuid, parseBody, planMapContext } from "@/server/plan-map/route-support";

/** Accepts, dismisses or reopens one finding. Accepting changes nothing in the plan by itself. */
export const POST = withRoute(
  "/api/plan-map/findings/[id]",
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const body = await parseBody(request, planMapFindingActionSchema);
    if (body instanceof Response) return body;
    if (!isUuid(id)) return Response.json({ error: "No such finding." }, { status: 404 });
    const context = await planMapContext();
    if (context instanceof Response) return context;
    if (body.data.action === "reopen") {
      const reopened = await reopenFinding(context.sql, context.userId, id);
      if (reopened.ok) return Response.json({ finding: reopened.finding });
      return Response.json(
        { error: reopened.reason, code: reopened.code },
        { status: reopened.code === "not_found" ? 404 : 409 }
      );
    }
    let finding;
    try {
      finding = await decideFinding(context.sql, context.userId, id, body.data.action, new Date(), body.data.answers);
    } catch (error) {
      if (error instanceof FindingQuestionsError)
        return Response.json({ error: error.message, code: error.code }, { status: 409 });
      throw error;
    }
    return finding ? Response.json({ finding }) : Response.json({ error: "No such finding." }, { status: 404 });
  }
);
