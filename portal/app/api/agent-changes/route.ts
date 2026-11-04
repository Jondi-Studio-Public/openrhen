import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import {
  AGENT_CHANGES_DEFAULT_LIMIT,
  AGENT_CHANGES_MAX_LIMIT,
  listAgentChangesPage,
  parseCursor
} from "@/server/persistence/postgres/agent-changes";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The writes agents made, whatever carried them (the CLI with an agent token, stdio MCP, remote `/mcp`), newest
 * first, read from the write ledger (`writes` by actor). Each
 * row has `writeId` (the ledger write behind it, which `GET /api/agent-changes/[writeId]` explains), and the status the ledger gives it (applied, undone, or superseded when nothing
 * was kept to put it back with). `?limit` (1 to 100, default 20) and `?before=<at>|<id>` page back; the answer's
 * `nextCursor` is the next `before`, or null at the end. The owner's: `withRoute` refuses a database agent token
 * (the route is an owner read in `platform/contracts/src/agent-routes.ts`), and any other agent identity is refused
 * here. Undo and redo are `POST /api/agent-changes/[id]/undo`.
 */
export const GET = withRoute("/api/agent-changes", async (request) => {
  if (requestAgent() !== null) return Response.json({ error: "Agent changes are for the owner." }, { status: 403 });
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Agent changes require PostgreSQL." }, { status: 503 });
  const params = new URL(request.url).searchParams;
  const asked = Number(params.get("limit") ?? AGENT_CHANGES_DEFAULT_LIMIT);
  const limit =
    Number.isInteger(asked) && asked >= 1 && asked <= AGENT_CHANGES_MAX_LIMIT ? asked : AGENT_CHANGES_DEFAULT_LIMIT;
  const raw = params.get("before");
  const before = raw === null || raw === "" ? undefined : parseCursor(raw);
  if (before === null)
    return Response.json({ error: "before must be the nextCursor of an earlier page." }, { status: 400 });
  const page = await listAgentChangesPage(sqlPool(connectionString), { limit, ...(before ? { before } : {}) });
  return Response.json(page);
});
