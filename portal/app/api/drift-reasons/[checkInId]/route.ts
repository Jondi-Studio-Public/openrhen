import { withRoute } from "@/server/logging";
import { deleteReason } from "@/server/drift/drift-reasons";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Deletes the reason saved for a check-in, every earlier save of it, and every tag on it. Answers `{ removed }`, the
 * number of rows that went (0 when there was none). Owner only: no token may delete it.
 */
export const DELETE = withRoute(
  "/api/drift-reasons/[checkInId]",
  async (_request: Request, { params }: { params: Promise<{ checkInId: string }> }) => {
    const connectionString = databaseUrl();
    if (!connectionString)
      return Response.json(
        {
          error:
            "Deleting a reason requires PostgreSQL. Set DATABASE_URL for the portal to a reachable PostgreSQL database, restart it, then try again."
        },
        { status: 503 }
      );
    const { checkInId } = await params;
    const result = await deleteReason(sqlPool(connectionString), checkInId);
    return result.ok
      ? Response.json({ removed: result.removed })
      : Response.json({ error: result.error }, { status: result.status });
  }
);
