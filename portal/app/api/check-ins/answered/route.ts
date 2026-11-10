import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { parseAnsweredCheckInsQuery, readAnsweredCheckIns } from "@/server/persistence/postgres/readers/check-in-read";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Answered check-ins, oldest answer first, each with its id, version, words and tags: how a reader holding a token
 * finds what to tag with `tag_check_in`. Read-only; it never stamps `prompted_at` or touches the pulse.
 * `?after=<next>&limit=1..200&untagged=1&with-words=1`.
 */
export const GET = withRoute("/api/check-ins/answered", async (request) => {
  const parsed = parseAnsweredCheckInsQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Check-ins require PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  return Response.json(await readAnsweredCheckIns(sql, userId, parsed.query));
});
