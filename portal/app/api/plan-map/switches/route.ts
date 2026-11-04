import { planMapSwitchInputSchema } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { setSwitch } from "@/server/persistence/postgres/plan-map-store";
import { parseBody, planMapContext } from "@/server/plan-map/route-support";

/**
 * Sets one add-on's mode. The only place a switch changes, and only on a person's request: a request that
 * carries an agent identity is refused (`admin:switches` is never grantable). Until agent tokens land
 * (PR 3) a headerless caller still counts as the owner.
 */
export const PUT = withRoute("/api/plan-map/switches", async (request) => {
  if (requestAgent() !== null)
    return Response.json(
      {
        error:
          "Only the owner can change an add-on switch; an agent cannot. The person changes it in Settings > Add-ons and sign-in."
      },
      { status: 403 }
    );
  const body = await parseBody(request, planMapSwitchInputSchema);
  if (body instanceof Response) return body;
  const context = await planMapContext();
  if (context instanceof Response) return context;
  await setSwitch(context.sql, context.userId, body.data.addon, body.data.mode);
  return Response.json({ addon: body.data.addon, mode: body.data.mode });
});
