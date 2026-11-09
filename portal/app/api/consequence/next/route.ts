import { z } from "zod";
import { withRoute } from "@/server/logging";
import { readNextConsequenceGroup } from "@/server/persistence/postgres/consequence-commands";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The next group of items to rank, or the one still waiting for an answer: `{ group }`, with `group: null` when
 * nothing can be asked now (fewer than two comparable items, or every pair was asked in the last 30 days). `?pool=project|action`
 * limits it to one pool. Handing a group out records it as issued (so it can be answered exactly once); that is
 * bookkeeping only and repeating the read returns the same group until it is answered. An agent never receives a group
 * holding a private item. Depends on who asks, so no cache may keep it.
 */
const HEADERS = {
  "cache-control": "private, no-store",
  vary: "Cookie, Authorization, X-OpenRhen-Token, X-OpenRhen-Agent"
};
const poolSchema = z.enum(["project", "action"]);

export const GET = withRoute("/api/consequence/next", async (request) => {
  const raw = new URL(request.url).searchParams.get("pool");
  const pool = raw === null || raw === "" ? undefined : poolSchema.safeParse(raw);
  if (pool && !pool.success)
    return Response.json(
      { error: 'pool must be "project" or "action" (or left out for either).' },
      { status: 400, headers: HEADERS }
    );
  const connectionString = databaseUrl();
  if (!connectionString)
    return Response.json(
      { error: "Ranking requires PostgreSQL, and the portal has no database right now." },
      { status: 503, headers: HEADERS }
    );
  const group = await readNextConsequenceGroup(sqlPool(connectionString), pool?.success ? { pool: pool.data } : {});
  return Response.json({ group }, { headers: HEADERS });
});
