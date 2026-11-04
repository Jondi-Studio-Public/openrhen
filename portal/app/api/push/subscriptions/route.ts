import { isAllowedPushEndpoint, pushSubscribeRequestSchema, pushUnsubscribeRequestSchema } from "@openrhen/contracts";
import { redact, withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import {
  addPushSubscription,
  deletePushSubscriptionByEndpoint,
  listPushSubscriptions,
  MAX_PUSH_SUBSCRIPTIONS
} from "@/server/push/push-subscriptions";

/**
 * `GET`/`POST`/`DELETE /api/push/subscriptions`:
 * lists, upserts or removes one browser's Web Push registration, keyed by its own `endpoint`. A new
 * endpoint is capped at five and is announced to the devices already registered (security review W3,
 * `addPushSubscription`). The
 * Notifications page's device list is the GET; `endpoint` never leaves this response as anything more
 * than a device row's id, so the page never has to hold or compare a raw endpoint URL itself.
 */
export const GET = withRoute("/api/push/subscriptions", async (_request, _context, log) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ available: false, subscriptions: [] });
  try {
    const sql = sqlPool(connectionString);
    const userId = await ensureUser(sql);
    const subscriptions = await listPushSubscriptions(sql, userId);
    return Response.json({
      available: true,
      subscriptions: subscriptions.map((row) => ({
        id: row.id,
        label: row.label,
        createdAt: row.createdAt,
        lastSuccessAt: row.lastSuccessAt,
        lastFailureAt: row.lastFailureAt
      }))
    });
  } catch (error) {
    log.setError(error);
    return Response.json({ available: false, subscriptions: [] });
  }
});

export const POST = withRoute("/api/push/subscriptions", async (request, _context, log) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Push requires PostgreSQL." }, { status: 503 });
  const parsed = pushSubscribeRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: "The subscribe request failed validation.", issues: parsed.error.issues },
      {
        status: 400
      }
    );
  if (!isAllowedPushEndpoint(parsed.data.subscription.endpoint))
    return Response.json({ error: "The push endpoint's host is not on the allowlist." }, { status: 400 });

  const sql = sqlPool(connectionString);
  try {
    const userId = await ensureUser(sql);
    // Security review W3: a new device is capped and announced to the existing devices; a refresh of an
    // endpoint already registered is neither.
    const outcome = await addPushSubscription(
      sql,
      userId,
      parsed.data.subscription,
      parsed.data.vapidPublicKey,
      parsed.data.label
    );
    if (outcome === "cap_reached")
      return Response.json(
        {
          error: `This portal already has ${MAX_PUSH_SUBSCRIPTIONS} notification devices. Remove one under Settings > Notifications first.`
        },
        { status: 409 }
      );
    return Response.json({ ok: true });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : "The subscription could not be saved." },
      { status: 500 }
    );
  }
});

export const DELETE = withRoute("/api/push/subscriptions", async (request, _context, log) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Push requires PostgreSQL." }, { status: 503 });
  const parsed = pushUnsubscribeRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "The unsubscribe request failed validation." }, { status: 400 });

  const sql = sqlPool(connectionString);
  try {
    const userId = await ensureUser(sql);
    await deletePushSubscriptionByEndpoint(sql, userId, parsed.data.endpoint);
    return Response.json({ ok: true });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : "The subscription could not be removed." },
      { status: 500 }
    );
  }
});
