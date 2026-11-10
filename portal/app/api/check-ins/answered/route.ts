import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readAnsweredCheckIns } from "@/server/persistence/postgres/readers/check-in-read";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Answered check-ins with their ids, newest answer first, so a reader can find one to tag
 * (`tag_check_in`) or quote. `since` and `before` are ISO 8601 instants on the answer time (page back by passing the
 * last `answeredAt` as `before`); `limit` defaults to 20 and is capped at 100.
 */
export const GET = withRoute("/api/check-ins/answered", async (request) => {
  const params = new URL(request.url).searchParams;
  const instant = (name: string): Date | null | "bad" => {
    const raw = params.get(name);
    if (raw === null || raw === "") return null;
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? "bad" : at;
  };
  const since = instant("since");
  const before = instant("before");
  if (since === "bad" || before === "bad")
    return Response.json({ error: "since and before must be ISO 8601 times." }, { status: 400 });
  const rawLimit = params.get("limit");
  const limit = rawLimit === null || rawLimit === "" ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    return Response.json({ error: "limit must be a whole number of 1 or more (at most 100)." }, { status: 400 });
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Check-ins require PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  const checkIns = await readAnsweredCheckIns(sql, userId, {
    ...(since ? { since } : {}),
    ...(before ? { before } : {}),
    ...(limit !== undefined ? { limit } : {})
  });
  return Response.json({ checkIns });
});
