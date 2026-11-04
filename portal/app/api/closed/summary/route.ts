import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readClosedSummary } from "@/server/persistence/postgres/readers/closed";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The badge on Now and Today: how many rows an agent closed (plainly: not owner-confirmed, not an undo of a create)
 * in the last 24 hours and are still closed, and when the latest was. The owner's, like the list it links to.
 */
export const GET = withRoute("/api/closed/summary", async () => {
  if (requestAgent() !== null) return Response.json({ error: "The closed list is for the owner." }, { status: 403 });
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "The closed list requires PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);
  const summary = await readClosedSummary(sql, await ensureUser(sql), new Date());
  return Response.json(summary, { headers: { "cache-control": "private, no-store" } });
});
