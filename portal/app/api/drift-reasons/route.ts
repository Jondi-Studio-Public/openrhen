import { withRoute } from "@/server/logging";
import { saveReason } from "@/server/drift/drift-reasons";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The owner's answer to "What pulled you off?" for a check-in they already answered as something else:
 * `{ "checkInId", "text", "requestId" }`. Answers `{ id, created }` and never the words. A retry of the same save reuses
 * the request id and is stored once; a different save for the same check-in is a new row and the latest wins. The
 * words are private: no token may write or read them, and they are never logged. Owner only.
 */
export const POST = withRoute("/api/drift-reasons", async (request: Request) => {
  const connectionString = databaseUrl();
  if (!connectionString)
    return Response.json(
      {
        error:
          "Saving a reason requires PostgreSQL. Set DATABASE_URL for the portal to a reachable PostgreSQL database, restart it, then try again."
      },
      { status: 503 }
    );
  const body = (await request.json().catch(() => null)) as {
    checkInId?: unknown;
    text?: unknown;
    requestId?: unknown;
  } | null;
  const result = await saveReason(sqlPool(connectionString), {
    checkInId: body?.checkInId,
    text: body?.text,
    requestId: body?.requestId
  });
  return result.ok
    ? Response.json({ id: result.id, created: result.created })
    : Response.json({ error: result.error }, { status: result.status });
});
