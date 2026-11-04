import { withRoute } from "@/server/logging";
import { readCatchUpLedger } from "@/server/persistence/postgres/catch-up";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The catch-up ledger: what should have had an outcome and has none. With
 * the `catch_up` switch off it is empty; in shadow it is a preview. `since` narrows occurrences,
 * `offset` pages.
 */
export const GET = withRoute("/api/catch-up", async (request) => {
  const params = new URL(request.url).searchParams;
  const sinceRaw = params.get("since");
  const since = sinceRaw === null ? undefined : new Date(sinceRaw);
  if (since && Number.isNaN(since.getTime()))
    return Response.json({ error: "since must be an ISO date-time." }, { status: 400 });
  const offsetRaw = params.get("offset");
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isInteger(offset) || offset < 0)
    return Response.json({ error: "offset must be a whole number of entries to skip." }, { status: 400 });
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Catch-up requires PostgreSQL." }, { status: 503 });
  return Response.json(await readCatchUpLedger(sqlPool(connectionString), { since, offset }));
});
