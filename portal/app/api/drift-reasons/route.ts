import { withRoute } from "@/server/logging";
import { nameOnlyError } from "@/server/drift/name-only-error";
import { saveReason } from "@/server/drift/drift-reasons";
import { readReasonTags } from "@/server/drift/reason-tags";
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
  }).catch((error: unknown) => {
    throw nameOnlyError(error);
  });
  return result.ok
    ? Response.json({ id: result.id, created: result.created })
    : Response.json({ error: result.error }, { status: result.status });
});

/**
 * The owner's recent reasons with the tags that stand for each, for the correction card on Review:
 * `{ modelConfigured, reasons: [{ checkInId, text, savedAt, tags, origin, stale }] }`, newest first, the last 14 days,
 * at most 200. The words are private, so the answer is never cached. Owner only: no token may read it.
 */
export const GET = withRoute("/api/drift-reasons", async () => {
  const connectionString = databaseUrl();
  if (!connectionString)
    return Response.json(
      {
        error:
          "Reasons require PostgreSQL. Set DATABASE_URL for the portal to a reachable PostgreSQL database, restart it, then call GET /api/drift-reasons again."
      },
      { status: 503 }
    );
  const answer = await readReasonTags(sqlPool(connectionString)).catch((error: unknown) => {
    throw nameOnlyError(error);
  });
  return Response.json(answer, { headers: { "cache-control": "no-store" } });
});
