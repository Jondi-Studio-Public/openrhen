import { redact, withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import { deletePushSubscriptionById } from "@/server/push/push-subscriptions";

/**
 * `DELETE /api/push/subscriptions/[id]`: removes one
 * listed device by its row id, for the Notifications page's remove button on a device other than the
 * one calling — the page never holds another device's raw endpoint, only the id its own GET returned.
 * The current device's own "Turn off" still unsubscribes by `endpoint`, through
 * `DELETE /api/push/subscriptions` — that is the one the browser can prove it owns, since it is what
 * the service worker's own registration holds.
 *
 * The delete is scoped to the caller's own `user_id`, resolved the same way as the sibling list and
 * subscribe routes (`ensureUser`); an id that exists but belongs to another user (or does not exist
 * at all) 404s rather than silently deleting someone else's subscription.
 */
export const DELETE = withRoute(
  "/api/push/subscriptions/[id]",
  async (_request: Request, { params }: { params: Promise<{ id: string }> }, log) => {
    const connectionString = databaseUrl();
    if (!connectionString) return Response.json({ error: "Push requires PostgreSQL." }, { status: 503 });
    const { id } = await params;
    const sql = sqlPool(connectionString);
    try {
      const userId = await ensureUser(sql);
      const removed = await deletePushSubscriptionById(sql, userId, id);
      if (!removed) return Response.json({ error: "No such device." }, { status: 404 });
      return Response.json({ ok: true });
    } catch (error) {
      log.setError(error);
      return Response.json(
        { error: error instanceof Error ? redact(error.message) : "The device could not be removed." },
        { status: 500 }
      );
    }
  }
);
