import { AGENT_SESSION_SCHEMA_VERSION, ingestAgentSessionsSchema, sessionsFromTheFuture } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { ingestAgentSessions, readAgentTime } from "@/server/agent-session-store";
import { withRoute } from "@/server/logging";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Agent time. POST takes the session records an external client reports, under the
 * agent token's own name and idempotent on the client's session id; `withRoute` has already checked the
 * `write:agent-session` scope. GET is the owner's: the last days' total for the Review line.
 */
export const POST = withRoute("/api/agent-sessions", async (request, _context, log) => {
  const agent = requestAgent();
  if (agent === null)
    return Response.json(
      { error: "Agent sessions are reported by an agent; send its token in X-OpenRhen-Token." },
      { status: 403 }
    );
  const body = await request.json().catch(() => null);
  const parsed = ingestAgentSessionsSchema.safeParse(body);
  if (!parsed.success) {
    const versionIssue =
      body !== null &&
      typeof body === "object" &&
      (body as { schemaVersion?: unknown }).schemaVersion !== AGENT_SESSION_SCHEMA_VERSION;
    return Response.json(
      {
        error: versionIssue ? `schemaVersion must be ${AGENT_SESSION_SCHEMA_VERSION}.` : "Session validation failed.",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      },
      { status: 400 }
    );
  }
  const future = sessionsFromTheFuture(parsed.data.sessions, new Date());
  if (future.length > 0)
    return Response.json(
      {
        error: "Session validation failed.",
        issues: future.map((index) => ({ path: `sessions.${index}.endedAt`, message: "endedAt is in the future." }))
      },
      { status: 400 }
    );
  log.setCommandType("ingest_agent_sessions");
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Agent time requires PostgreSQL." }, { status: 503 });
  return Response.json(await ingestAgentSessions(sqlPool(connectionString), agent, parsed.data.sessions));
});

export const GET = withRoute("/api/agent-sessions", async (request) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Agent time requires PostgreSQL." }, { status: 503 });
  const asked = Number(new URL(request.url).searchParams.get("days") ?? 7);
  const days = Number.isInteger(asked) && asked >= 1 && asked <= 90 ? asked : 7;
  return Response.json(await readAgentTime(sqlPool(connectionString), days));
});
