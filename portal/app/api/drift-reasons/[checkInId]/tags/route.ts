import { withRoute } from "@/server/logging";
import { nameOnlyError } from "@/server/drift/name-only-error";
import { setReasonTags } from "@/server/drift/reason-tags";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The owner's own tags for one reason: `{ "tags": ["a phrase", ...], "requestId": "<new for each change>" }`, free
 * text, at most 6 phrases of 40 characters (an empty list means "no tags"), or `{ "reset": true, "requestId": ... }`,
 * which takes the answer back so the model's tags show again. Stored as a new row; the model's rows and the words are
 * never edited. A retry reuses the request id and is stored once. Answers the reason as it now reads. Owner only: no
 * token may write it, and the answer carries the owner's own words.
 */
export const PUT = withRoute(
  "/api/drift-reasons/[checkInId]/tags",
  async (request: Request, { params }: { params: Promise<{ checkInId: string }> }) => {
    const connectionString = databaseUrl();
    if (!connectionString)
      return Response.json(
        {
          error:
            "Changing tags requires PostgreSQL. Set DATABASE_URL for the portal to a reachable PostgreSQL database, restart it, then try again."
        },
        { status: 503 }
      );
    const body = (await request.json().catch(() => null)) as {
      tags?: unknown;
      reset?: unknown;
      requestId?: unknown;
    } | null;
    const { checkInId } = await params;
    const result = await setReasonTags(sqlPool(connectionString), {
      checkInId,
      tags: body?.tags,
      reset: body?.reset,
      requestId: body?.requestId
    }).catch((error: unknown) => {
      throw nameOnlyError(error);
    });
    return result.ok
      ? Response.json(result.reason, { headers: { "cache-control": "no-store" } })
      : Response.json({ error: result.error }, { status: result.status });
  }
);
