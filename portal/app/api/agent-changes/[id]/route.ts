import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { readAgentChangeDetail } from "@/server/persistence/postgres/agent-change-detail";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "no-store" };

/**
 * One agent write explained: what changed (before to after per field), the basis and quoted words the agent gave,
 * and the plan effect. `id` is a `writes.id` (the list's `writeId`). The owner's, read-only: `withRoute` refuses a
 * database agent token (an owner read in `platform/contracts/src/agent-routes.ts`) and any other agent identity is
 * refused here.
 */
export const GET = withRoute(
  "/api/agent-changes/[id]",
  async (_request, context: { params: Promise<{ id: string }> }) => {
    if (requestAgent() !== null)
      return Response.json({ error: "Agent changes are for the owner." }, { status: 403, headers: NO_STORE });
    const { id } = await context.params;
    if (!UUID_SHAPE.test(id))
      return Response.json({ error: "id must be a write id." }, { status: 400, headers: NO_STORE });
    const connectionString = databaseUrl();
    if (!connectionString)
      return Response.json({ error: "Agent changes require PostgreSQL." }, { status: 503, headers: NO_STORE });
    const sql = sqlPool(connectionString);
    const detail = await readAgentChangeDetail(sql, await ensureUser(sql), id);
    if (!detail) return Response.json({ error: "No such change." }, { status: 404, headers: NO_STORE });
    return Response.json(detail, { headers: NO_STORE });
  }
);
