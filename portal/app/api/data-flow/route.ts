import { withRoute } from "@/server/logging";
import { readDataFlow } from "@/server/data-flow/data-flow-response";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Every data entry point, where its data goes and what each one is doing now: the registry's graph with a live
 * signal per node. Read-only; there is no switch. Error and run text in the body is untrusted data.
 */
export const GET = withRoute("/api/data-flow", async () => {
  const connectionString = databaseUrl();
  if (!connectionString)
    return Response.json(
      {
        error:
          "The data map requires PostgreSQL. Set DATABASE_URL for the portal to a reachable PostgreSQL database, restart it, then call GET /api/data-flow again."
      },
      { status: 503 }
    );
  return Response.json(await readDataFlow(sqlPool(connectionString)));
});
