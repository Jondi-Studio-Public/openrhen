import { notFoundResponse } from "@/server/not-found-response";
import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { markCheckInShown } from "@/server/persistence/postgres/readers/check-in-read";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `POST /api/check-ins/{id}/shown`, no body: a surface (the app's sheet, a posted local notification) reports it
 * actually showed this check-in. It stamps `prompted_at` once, so the timeout counts from when the owner could see the
 * question, not from when a background refresh read it (`GET /api/client/view` reads with `stamp: false`). The timeout
 * rule is unchanged: it still runs from `prompted_at ?? created_at`. Idempotent: a repeat answers `stamped: false` with
 * the first time. Owner only, never an agent token, and not `owner-admin`, so a paired phone's limited credential may
 * call it. 404 for an id that is not this owner's check-in. Answers `CheckInShown`
 * (`platform/contracts/src/client-view.ts`).
 */
export const POST = withRoute(
  "/api/check-ins/[id]/shown",
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    if (!UUID.test(id)) return notFoundResponse("check-in", id);
    const connectionString = databaseUrl();
    if (!connectionString) return Response.json({ error: "Check-ins require PostgreSQL." }, { status: 503 });
    const sql = sqlPool(connectionString);
    const result = await markCheckInShown(sql, await ensureUser(sql), id);
    return result ? Response.json(result) : notFoundResponse("check-in", id);
  }
);
