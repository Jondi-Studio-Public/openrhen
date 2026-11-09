import { withRoute } from "@/server/logging";
import { setWorkLabel } from "@/server/drift/work-labels";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The owner's one-tap answer on whether an area counts as work: `{ "label": "work" | "not_work" | "unset",
 * "requestId": "<new for each tap>" }`. It is the owner's own record and wins over the model's label; `unset` takes
 * the answer back so the model's label shows again. The request id makes a retried tap one row. Answers the label as
 * it now reads. Owner only: no agent token may write it.
 */
export const PUT = withRoute(
  "/api/work-labels/[areaId]",
  async (request: Request, { params }: { params: Promise<{ areaId: string }> }) => {
    const connectionString = databaseUrl();
    if (!connectionString)
      return Response.json(
        {
          error:
            "Work labels require PostgreSQL. Set DATABASE_URL for the portal to a reachable PostgreSQL database, restart it, then try again."
        },
        { status: 503 }
      );
    const body = (await request.json().catch(() => null)) as { label?: unknown; requestId?: unknown } | null;
    const { areaId } = await params;
    const result = await setWorkLabel(sqlPool(connectionString), {
      areaId,
      label: body?.label,
      requestId: body?.requestId
    });
    return result.ok ? Response.json(result.label) : Response.json({ error: result.error }, { status: result.status });
  }
);
