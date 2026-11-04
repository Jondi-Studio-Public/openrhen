import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { parseChangeFeedQuery, readChangeFeed } from "@/server/persistence/postgres/change-feed";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The audit trail and change feed in one read: `write_rows`
 * newest first, who made each write, and whether its before-image is still stored. Covers writes to
 * plan input only, which is all `write_rows` records. Read-only.
 */
export const GET = withRoute("/api/changes", async (request) => {
  const parsed = parseChangeFeedQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "The change feed requires PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  return Response.json(await readChangeFeed(sql, userId, parsed.query));
});
