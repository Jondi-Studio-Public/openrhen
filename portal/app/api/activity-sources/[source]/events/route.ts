import { withRoute } from "@/server/logging";
import { ActivityInputError, purgeActivitySource } from "@/server/persistence/postgres/activity-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/** Deletes every event held for one source, and that source's import records. The owner's own action; cannot be undone. */
export const DELETE = withRoute(
  "/api/activity-sources/[source]/events",
  async (_request: Request, { params }: { params: Promise<{ source: string }> }) => {
    const { source } = await params;
    const connectionString = databaseUrl();
    if (!connectionString) return Response.json({ error: "The activity store requires PostgreSQL." }, { status: 503 });
    try {
      return Response.json(await purgeActivitySource(sqlPool(connectionString), source));
    } catch (error) {
      if (error instanceof ActivityInputError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }
);
