import { createAgentTokenSchema } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { AgentTokenError, createAgentToken, listAgentTokens } from "@/server/agent-token-store";
import { withRoute } from "@/server/logging";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Agent tokens are the owner's to issue and list. A request that
 * carries an agent identity (a token, or a self-declared name) is refused here, and the route wrapper already
 * refuses every database token. Under OPENRHEN_OWNER_AUTH=require the wrapper also wants an owner credential;
 * before that a caller that sends no identity counts as the owner, so this stops agents that name themselves.
 */
const ownerOnly = () =>
  requestAgent() === null ? null : Response.json({ error: "Agent tokens are managed by the owner." }, { status: 403 });

/** Issues a token. The raw token is in this response and nowhere else. */
export const POST = withRoute("/api/agent-tokens", async (request, _context, log) => {
  const refused = ownerOnly();
  if (refused) return refused;
  const parsed = createAgentTokenSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Token validation failed.", issues: parsed.error.issues }, { status: 400 });
  log.setCommandType("create_agent_token");
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Agent tokens require PostgreSQL." }, { status: 503 });
  try {
    const { token, summary } = await createAgentToken(sqlPool(connectionString), parsed.data);
    return Response.json({ token, agentToken: summary }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AgentTokenError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
});

/** Every token with its scopes, expiry and last use. Never a secret or a hash. */
export const GET = withRoute("/api/agent-tokens", async () => {
  const refused = ownerOnly();
  if (refused) return refused;
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Agent tokens require PostgreSQL." }, { status: 503 });
  return Response.json({ tokens: await listAgentTokens(sqlPool(connectionString)) });
});
