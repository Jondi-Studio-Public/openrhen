import { AGENT_PROPOSAL_STATUSES, proposeAgentChangeSchema, type AgentProposalStatus } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { PROPOSALS_UNAVAILABLE, proposalErrorResponse } from "@/server/agent-proposals/errors";
import {
  listAgentProposals,
  PROPOSAL_LIST_DEFAULT_LIMIT,
  PROPOSAL_LIST_MAX_LIMIT,
  proposeAgentChange
} from "@/server/agent-proposals/store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { withRoute } from "@/server/logging";
import { databaseUrl } from "@/server/runtime-env";

/**
 * An agent proposes a write; the person confirms it in the Inbox (the design notes
 * section 2). The proposal needs a named agent: the stored `agent` is what the change log attributes
 * the confirmed write to. The line the person reads is built from the payload, never taken from the agent.
 */
export const POST = withRoute("/api/agent-proposals", async (request, _context, log) => {
  const parsed = proposeAgentChangeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Proposal validation failed.", issues: parsed.error.issues }, { status: 400 });
  log.setCommandType("propose_agent_change");
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: PROPOSALS_UNAVAILABLE }, { status: 503 });
  try {
    // The agent's own line is dropped: the store writes the one the person reads from the payload.
    const { summary: _agentSummary, ...input } = parsed.data;
    const { proposal, outcome } = await proposeAgentChange(sqlPool(connectionString), requestAgent(), input);
    return Response.json({ proposal, outcome }, { status: outcome === "created" ? 201 : 200 });
  } catch (error) {
    return proposalErrorResponse(error);
  }
});

/**
 * Newest first. An agent sees only its own proposals and how they were decided; the person sees every
 * agent's, and may filter by `agent` and `status`.
 */
export const GET = withRoute("/api/agent-proposals", async (request) => {
  const params = new URL(request.url).searchParams;
  const status = params.get("status");
  if (status !== null && !(AGENT_PROPOSAL_STATUSES as readonly string[]).includes(status))
    return Response.json({ error: `status must be one of ${AGENT_PROPOSAL_STATUSES.join(", ")}.` }, { status: 400 });
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? PROPOSAL_LIST_DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > PROPOSAL_LIST_MAX_LIMIT)
    return Response.json(
      { error: `limit must be a whole number from 1 to ${PROPOSAL_LIST_MAX_LIMIT}.` },
      { status: 400 }
    );
  const agentParam = params.get("agent");
  if (agentParam !== null && !/^[a-z0-9_-]{1,32}$/.test(agentParam))
    return Response.json({ error: "agent must be an agent name." }, { status: 400 });
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: PROPOSALS_UNAVAILABLE }, { status: 503 });
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  const proposals = await listAgentProposals(sql, userId, {
    status: (status ?? undefined) as AgentProposalStatus | undefined,
    agent: requestAgent() ?? agentParam ?? undefined,
    limit
  });
  return Response.json({ proposals });
});
