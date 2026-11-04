import { CLOSE_TYPES, CLOSED_TABS, type ClosedTab, type CloseType } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import {
  CLOSED_DEFAULT_LIMIT,
  CLOSED_MAX_LIMIT,
  parseClosedCursor,
  readClosed
} from "@/server/persistence/postgres/readers/closed";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

const NO_STORE = { "cache-control": "private, no-store" };

/**
 * Review > Closed: the rows archived or cancelled, newest first, with who closed them, why, how many closed with
 * them and the closed ancestor that blocks a restore. `?tab=archived|cancelled` (default archived), `?type=` one of the
 * eight closable types, `?limit` (1 to 100, default 50), `?before=` the previous page's `nextCursor`. The owner's:
 * the route is an owner read in `platform/contracts/src/agent-routes.ts`, and any agent identity is refused here too.
 */
export const GET = withRoute("/api/closed", async (request) => {
  if (requestAgent() !== null) return Response.json({ error: "The closed list is for the owner." }, { status: 403 });
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "The closed list requires PostgreSQL." }, { status: 503 });
  const params = new URL(request.url).searchParams;
  const tab = params.get("tab") ?? "archived";
  if (!(CLOSED_TABS as readonly string[]).includes(tab))
    return Response.json({ error: `tab must be one of: ${CLOSED_TABS.join(", ")}.` }, { status: 400 });
  const type = params.get("type");
  if (type !== null && type !== "" && !(CLOSE_TYPES as readonly string[]).includes(type))
    return Response.json({ error: `type must be one of: ${CLOSE_TYPES.join(", ")}.` }, { status: 400 });
  const before = params.get("before");
  if (before !== null && before !== "" && parseClosedCursor(before) === null)
    return Response.json({ error: "before must be the nextCursor of an earlier page." }, { status: 400 });
  const asked = Number(params.get("limit") ?? CLOSED_DEFAULT_LIMIT);
  const limit = Number.isInteger(asked) && asked >= 1 && asked <= CLOSED_MAX_LIMIT ? asked : CLOSED_DEFAULT_LIMIT;
  const sql = sqlPool(connectionString);
  const page = await readClosed(sql, await ensureUser(sql), {
    tab: tab as ClosedTab,
    ...(type ? { type: type as CloseType } : {}),
    limit,
    ...(before ? { before } : {})
  });
  return Response.json(page, { headers: NO_STORE });
});
