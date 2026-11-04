import { redact, withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import "@/server/drop-ins";
import { runPushDrain } from "@/server/push/push-drain";
import { pushTransports } from "@/server/push/push-transports";

/**
 * `POST /api/integrations/push/drain`: claims
 * pending `push_outbox` rows and sends each. Safe to call from anywhere — it only ever sends rows
 * something else already decided to queue — so it needs no auth of its own beyond what fronts every
 * portal route; the worker's leave-by tick posts here after every `runLeaveByTick`.
 */
export const POST = withRoute("/api/integrations/push/drain", async (_request, _context, log) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Push requires PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);
  try {
    const userId = await ensureUser(sql);
    const result = await runPushDrain(sql, userId);
    // Every other registered transport (a native app) runs after Web Push and must never fail the Web Push
    // drain that already ran, so its own error is reported beside the Web Push result, not instead of it.
    const others: Record<string, unknown> = {};
    for (const transport of pushTransports())
      others[transport.id] = await transport.drain(sql, userId).catch((error: unknown) => {
        log.setError(error);
        return { error: error instanceof Error ? redact(error.message) : `The ${transport.id} drain failed.` };
      });
    return Response.json({ ...result, ...others });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : "The push drain failed." },
      { status: 500 }
    );
  }
});
