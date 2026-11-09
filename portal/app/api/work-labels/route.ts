import { withRoute } from "@/server/logging";
import { readWorkLabels } from "@/server/drift/work-labels";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Which areas count as work, for the owner: `{ modelConfigured, labels: [{ areaId, value, origin, at }] }`. `value` is
 * `work`, `not_work` or `unknown`; `origin` is `corrected` (the owner's own answer), `inferred` (the local model's) or
 * null. An area with no entry is unknown. Owner only: an agent token cannot read it.
 */
export const GET = withRoute("/api/work-labels", async () => {
  const connectionString = databaseUrl();
  if (!connectionString)
    return Response.json(
      {
        error:
          "Work labels require PostgreSQL. Set DATABASE_URL for the portal to a reachable PostgreSQL database, restart it, then call GET /api/work-labels again."
      },
      { status: 503 }
    );
  return Response.json(await readWorkLabels(sqlPool(connectionString)));
});
