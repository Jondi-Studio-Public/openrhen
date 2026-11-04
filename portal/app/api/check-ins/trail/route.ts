import { notFoundResponse } from "@/server/not-found-response";
import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readCheckInTrail } from "@/server/persistence/postgres/readers/check-in-read";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The run of unanswered check-ins behind a session, for the Now page's reconciliation ladder — see
 * The session reconciliation design note. Scoped to `sessionId` and `userId` together
 * (`readCheckInTrail` looks the session up by both), so a session id that does not belong to the
 * requesting user reads back as "not found," never another user's trail.
 */
export const GET = withRoute("/api/check-ins/trail", async (request) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Check-ins require PostgreSQL." }, { status: 503 });
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!sessionId) return Response.json({ error: "sessionId is required." }, { status: 400 });
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  const trail = await readCheckInTrail(sql, userId, sessionId);
  if (!trail) return notFoundResponse("session", sessionId);
  return Response.json(trail);
});
