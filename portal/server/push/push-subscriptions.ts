import { DEFAULT_TIMEZONE } from "@openrhen/contracts";
import type { PushSubscriptionWire } from "@openrhen/contracts";
import type { PoolSql, Sql } from "@/server/persistence/postgres/sql-pool";
import { queueDeviceAddedAnnouncement } from "./push-device-announcement";

/**
 * `push_subscriptions` reads and writes.
 * One row per browser registration, upserted by `endpoint` — a phone re-subscribing (a new service
 * worker, a cleared site) simply replaces its own row rather than accumulating dead ones.
 */

export interface StoredPushSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  vapidPublicKey: string;
  label: string | null;
}

/** How many browsers may be registered at once (security review W3). */
export const MAX_PUSH_SUBSCRIPTIONS = 5;

/** Upserts by `endpoint` and returns the row's id. */
export async function upsertPushSubscription(
  sql: Sql,
  userId: string,
  subscription: PushSubscriptionWire,
  vapidPublicKey: string,
  label: string | undefined
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, vapid_public_key, label)
    VALUES (${userId}, ${subscription.endpoint}, ${subscription.keys.p256dh}, ${subscription.keys.auth}, ${vapidPublicKey}, ${label ?? null})
    ON CONFLICT (endpoint) DO UPDATE SET
      p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, vapid_public_key=EXCLUDED.vapid_public_key,
      label=COALESCE(EXCLUDED.label, push_subscriptions.label), failure_count=0
    RETURNING id
  `;
  return rows[0]!.id;
}

export type AddPushSubscriptionOutcome = "refreshed" | "added" | "cap_reached";

/**
 * `POST /api/push/subscriptions` (security review W3). Under one transaction, serialised per user on
 * the `users` row so two simultaneous adds cannot both slip under the cap:
 *  - an endpoint already registered is refreshed (a service-worker renewal); never counts against the
 *    cap, never announces;
 *  - a new endpoint is refused as `cap_reached` at `MAX_PUSH_SUBSCRIPTIONS`, and otherwise is inserted
 *    and announced to the devices that already existed (queued in the same transaction, so it cannot be
 *    lost). Who may call this at all is owner sign-in's job (`OPENRHEN_OWNER_AUTH`), not this function's.
 */
export async function addPushSubscription(
  sql: PoolSql,
  userId: string,
  subscription: PushSubscriptionWire,
  vapidPublicKey: string,
  label: string | undefined,
  options: { now?: Date } = {}
): Promise<AddPushSubscriptionOutcome> {
  return sql.begin(async (tx) => {
    const owner = await tx<
      { timezone: string; locale: string }[]
    >`SELECT timezone, locale FROM users WHERE id=${userId} FOR UPDATE`;
    const existing = await tx`SELECT 1 FROM push_subscriptions WHERE endpoint=${subscription.endpoint}`;
    if (existing.length) {
      await upsertPushSubscription(tx, userId, subscription, vapidPublicKey, label);
      return "refreshed" as const;
    }
    const counted = await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM push_subscriptions WHERE user_id=${userId}
    `;
    const count = counted[0]?.count ?? 0;
    if (count >= MAX_PUSH_SUBSCRIPTIONS) return "cap_reached" as const;
    const id = await upsertPushSubscription(tx, userId, subscription, vapidPublicKey, label);
    if (count > 0)
      await queueDeviceAddedAnnouncement(tx, {
        userId,
        newSubscriptionId: id,
        label,
        timeZone: owner[0]?.timezone ?? DEFAULT_TIMEZONE,
        locale: owner[0]?.locale,
        now: options.now ?? new Date()
      });
    return "added" as const;
  }) as Promise<AddPushSubscriptionOutcome>;
}

export async function deletePushSubscriptionByEndpoint(sql: Sql, userId: string, endpoint: string): Promise<void> {
  await sql`DELETE FROM push_subscriptions WHERE user_id=${userId} AND endpoint=${endpoint}`;
}

export async function listPushSubscriptions(
  sql: Sql,
  userId: string
): Promise<
  (StoredPushSubscription & { createdAt: string; lastSuccessAt: string | null; lastFailureAt: string | null })[]
> {
  const rows = await sql<
    {
      id: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      vapid_public_key: string;
      label: string | null;
      created_at: Date;
      last_success_at: Date | null;
      last_failure_at: Date | null;
    }[]
  >`
    SELECT id, endpoint, p256dh, auth, vapid_public_key, label, created_at, last_success_at, last_failure_at
    FROM push_subscriptions WHERE user_id=${userId} ORDER BY created_at
  `;
  return rows.map((row) => ({
    id: row.id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    vapidPublicKey: row.vapid_public_key,
    label: row.label,
    createdAt: row.created_at.toISOString(),
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    lastFailureAt: row.last_failure_at?.toISOString() ?? null
  }));
}

/** Every subscription whose `vapid_public_key` matches the proxy's current key — a mismatched one is
 * dead after a key rotation and is never sent to (the drain deletes it instead). */
export async function listPushSubscriptionsForCurrentKey(
  sql: Sql,
  userId: string,
  vapidPublicKey: string
): Promise<StoredPushSubscription[]> {
  const rows = await sql<
    { id: string; endpoint: string; p256dh: string; auth: string; vapid_public_key: string; label: string | null }[]
  >`
    SELECT id, endpoint, p256dh, auth, vapid_public_key, label FROM push_subscriptions
    WHERE user_id=${userId} AND vapid_public_key=${vapidPublicKey}
  `;
  return rows.map((row) => ({
    id: row.id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    vapidPublicKey: row.vapid_public_key,
    label: row.label
  }));
}

/** Every subscription whose key does not match — deleted outright on a drain pass (design "Drain" §2). */
export async function deleteMismatchedKeySubscriptions(
  sql: Sql,
  userId: string,
  vapidPublicKey: string
): Promise<void> {
  await sql`DELETE FROM push_subscriptions WHERE user_id=${userId} AND vapid_public_key<>${vapidPublicKey}`;
}

export async function recordPushSuccess(sql: Sql, id: string): Promise<void> {
  await sql`UPDATE push_subscriptions SET last_success_at=now(), failure_count=0 WHERE id=${id}`;
}

export async function recordPushFailure(sql: Sql, id: string): Promise<void> {
  await sql`UPDATE push_subscriptions SET last_failure_at=now(), failure_count=failure_count+1 WHERE id=${id}`;
}

/** Deletes only when `id` belongs to `userId`; returns whether a row was actually removed, so the
 * route can 404 rather than silently no-op on another user's (or a nonexistent) id. */
export async function deletePushSubscriptionById(sql: Sql, userId: string, id: string): Promise<boolean> {
  const deleted = await sql`DELETE FROM push_subscriptions WHERE id=${id} AND user_id=${userId} RETURNING id`;
  return deleted.length > 0;
}
