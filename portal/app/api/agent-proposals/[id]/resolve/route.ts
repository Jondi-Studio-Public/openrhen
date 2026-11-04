import { resolveAgentProposalSchema } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { PROPOSALS_UNAVAILABLE, proposalErrorResponse } from "@/server/agent-proposals/errors";
import { resolveAgentProposal } from "@/server/agent-proposals/store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { withRoute } from "@/server/logging";
import { databaseUrl } from "@/server/runtime-env";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The owner confirms or rejects one proposal. Refused for any request that carries an agent identity.
 * "Agents cannot confirm" is guaranteed when OPENRHEN_OWNER_AUTH=require (the design notes
 * section 3): the wrapper then wants an owner credential here. Before that, a caller with no identity is the owner.
 */
export const POST = withRoute<{ params: Promise<{ id: string }> }>(
  "/api/agent-proposals/[id]/resolve",
  async (request, context, log) => {
    const { id } = await context.params;
    if (!UUID.test(id)) return Response.json({ error: "That proposal does not exist." }, { status: 404 });
    const parsed = resolveAgentProposalSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return Response.json({ error: "Resolution validation failed.", issues: parsed.error.issues }, { status: 400 });
    log.setCommandType(`${parsed.data.decision}_agent_proposal`);
    const connectionString = databaseUrl();
    if (!connectionString) return Response.json({ error: PROPOSALS_UNAVAILABLE }, { status: 503 });
    try {
      return Response.json({
        proposal: await resolveAgentProposal(sqlPool(connectionString), requestAgent(), id, parsed.data)
      });
    } catch (error) {
      return proposalErrorResponse(error);
    }
  }
);
