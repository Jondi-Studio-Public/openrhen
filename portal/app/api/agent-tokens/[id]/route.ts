import { requestAgent } from "@/server/agent-actor";
import { AgentTokenError, revokeAgentToken, setAgentTokenDirectWrites } from "@/server/agent-token-store";
import { withRoute } from "@/server/logging";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Revokes a token; it stops working on the very next request. Owner only, like issuing one. */
export const DELETE = withRoute<{ params: Promise<{ id: string }> }>(
  "/api/agent-tokens/[id]",
  async (_request, context, log) => {
    if (requestAgent() !== null)
      return Response.json({ error: "Agent tokens are managed by the owner." }, { status: 403 });
    const { id } = await context.params;
    if (!UUID.test(id)) return Response.json({ error: "That token does not exist." }, { status: 404 });
    log.setCommandType("revoke_agent_token");
    const connectionString = databaseUrl();
    if (!connectionString) return Response.json({ error: "Agent tokens require PostgreSQL." }, { status: 503 });
    try {
      return Response.json({ agentToken: await revokeAgentToken(sqlPool(connectionString), id) });
    } catch (error) {
      if (error instanceof AgentTokenError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }
);

/**
 * Turns direct writes on or off for a live token: `{ directWrites }`, a map of entity class to `off`, `shadow` or
 * `on` that replaces the old one. Owner only, so an approved agent cannot widen itself.
 */
export const PATCH = withRoute<{ params: Promise<{ id: string }> }>(
  "/api/agent-tokens/[id]",
  async (request, context, log) => {
    if (requestAgent() !== null)
      return Response.json({ error: "Agent tokens are managed by the owner." }, { status: 403 });
    const { id } = await context.params;
    if (!UUID.test(id)) return Response.json({ error: "That token does not exist." }, { status: 404 });
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object" || Array.isArray(body) || !("directWrites" in body))
      return Response.json({ error: "Send { directWrites } as a JSON object." }, { status: 400 });
    log.setCommandType("update_agent_token");
    const connectionString = databaseUrl();
    if (!connectionString) return Response.json({ error: "Agent tokens require PostgreSQL." }, { status: 503 });
    try {
      return Response.json({
        agentToken: await setAgentTokenDirectWrites(sqlPool(connectionString), id, body.directWrites)
      });
    } catch (error) {
      if (error instanceof AgentTokenError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }
);
