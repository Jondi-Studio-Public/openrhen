import { createHash } from "node:crypto";
import type { LeaveByPushPayload } from "@openrhen/contracts";
import { cancelClosedCheckInWaitingPushes, stampCheckInPrompted } from "@openrhen/database";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";
import { fetchVapidPublicKey, sendPushViaProxy } from "./push-proxy-client";
import {
  deleteMismatchedKeySubscriptions,
  deletePushSubscriptionById,
  listPushSubscriptionsForCurrentKey,
  recordPushFailure,
  recordPushSuccess
} from "./push-subscriptions";
import { DEVICE_ADDED_DEDUPE_PREFIX } from "./push-device-announcement";

/**
 * `POST /api/integrations/push/drain`: claims pending
 * `push_outbox` rows and sends each to every subscription current for the proxy's own VAPID key.
 * Safe to call from anywhere, including a cron ping with no auth of its own — it only ever sends
 * rows something else already decided to queue.
 */

export const CLAIM_BATCH_SIZE = 20;
export const RETRY_DELAY_MS = 30_000;
export const MAX_ATTEMPTS = 3;
/**
 * How long a claimed row is hidden from other drains. The claim pushes `next_attempt_at` this far
 * out inside the claim transaction (there is no `sending` status and no migration), so a drain that
 * overlaps a slow one skips the rows it is still sending. If the drain dies mid-send the row is
 * picked up again once the lease lapses, bounded by `expires_at`.
 */
export const CLAIM_LEASE_MS = 5 * 60_000;
/**
 * A batch of dead endpoints can take far longer than the lease (20 rows x 30 s per send), so the
 * drain stops starting sends once this budget is spent and releases what it did not reach. Budget
 * plus one in-flight send (the outbound request timeout, 30 s) stays inside `CLAIM_LEASE_MS`, so a
 * row is never re-claimed while this drain is still working on it. The send timeout comes from
 * `outboundRequestTimeoutMs(env)` and is configurable, so `SEND_BUDGET_MS` plus that timeout must
 * stay under `CLAIM_LEASE_MS`.
 */
export const SEND_BUDGET_MS = 4 * 60_000;
export const NO_SUBSCRIPTION_RETRY_MS = 60_000;
/** `last_error` written on pending rows when the push service cannot be reached or has no VAPID key. */
export const PUSH_SERVICE_UNAVAILABLE = "push_service_unavailable";
export const PUSH_TTL_SECONDS_DEFAULT = 900;

export interface DrainResult {
  claimed: number;
  sent: number;
  /** Rows held back (still pending, retried every minute) because no subscription exists yet. */
  deferredNoSubscription: number;
  expired: number;
}

/** RFC 8030's `Topic` header: a 32-character hash of the notification tag, so a newer prompt replaces the older one. */
export function topicFor(tag: string): string {
  return createHash("sha256").update(tag).digest("hex").slice(0, 32);
}

/**
 * The subscriptions one outbox row goes to: all of them, except that a "new device added" row skips
 * the device it announces (the new device must not be told about itself, and an unwelcome one gets
 * no hint that the owner has been alerted).
 */
export function subscriptionsForRow<T extends { id: string }>(dedupeKey: string, subscriptions: T[]): T[] {
  if (!dedupeKey.startsWith(DEVICE_ADDED_DEDUPE_PREFIX)) return subscriptions;
  const newId = dedupeKey.slice(DEVICE_ADDED_DEDUPE_PREFIX.length);
  return subscriptions.filter((subscription) => subscription.id !== newId);
}

/** Hands a claimed-but-unsent row back: refunds the attempt and ends the lease so the next drain takes it. */
export async function releaseClaim(sql: PoolSql, id: string): Promise<void> {
  await sql`UPDATE push_outbox SET attempts=attempts-1, next_attempt_at=now() WHERE id=${id}`;
}

export async function runPushDrain(
  sql: PoolSql,
  userId: string,
  options: { sendBudgetMs?: number } = {}
): Promise<DrainResult> {
  const deadline = Date.now() + (options.sendBudgetMs ?? SEND_BUDGET_MS);
  const expiredResult = await sql`
    UPDATE push_outbox SET status='expired' WHERE user_id=${userId} AND channel='webpush' AND status='pending' AND expires_at < now()
  `;

  // A check-in answered or closed meanwhile is not worth a late prompt (the answer paths cancel too; this catches the rest).
  await cancelClosedCheckInWaitingPushes(sql, userId);

  const vapidPublicKey = await fetchVapidPublicKey();
  const result: DrainResult = { claimed: 0, sent: 0, deferredNoSubscription: 0, expired: expiredResult.count };
  if (!vapidPublicKey) {
    // Nothing can be sent, so say why on the rows instead of letting them silently expire.
    await sql`
      UPDATE push_outbox SET last_error=${PUSH_SERVICE_UNAVAILABLE}
      WHERE user_id=${userId} AND channel='webpush' AND status='pending'
        AND last_error IS DISTINCT FROM ${PUSH_SERVICE_UNAVAILABLE}
    `;
    return result;
  }

  await deleteMismatchedKeySubscriptions(sql, userId, vapidPublicKey);
  const subscriptions = await listPushSubscriptionsForCurrentKey(sql, userId, vapidPublicKey);

  const claimed = await sql.begin(async (tx) => {
    const rows = await tx<
      {
        id: string;
        dedupe_key: string;
        kind: string;
        payload: LeaveByPushPayload;
        expires_at: Date;
        attempts: number;
      }[]
    >`
      SELECT id, dedupe_key, kind, payload, expires_at, attempts FROM push_outbox
      WHERE user_id=${userId} AND channel='webpush' AND status='pending' AND next_attempt_at <= now()
      ORDER BY created_at LIMIT ${CLAIM_BATCH_SIZE} FOR UPDATE SKIP LOCKED
    `;
    if (rows.length) {
      await tx`
        UPDATE push_outbox SET attempts=attempts+1,
          next_attempt_at=now() + (${CLAIM_LEASE_MS} * INTERVAL '1 millisecond')
        WHERE id IN ${tx(rows.map((r) => r.id))}
      `;
    }
    return rows;
  });
  result.claimed = claimed.length;

  // Set when a proxy call throws (down, timed out, refused): every row not yet decided is handed back
  // at once instead of sitting out the claim lease with an attempt spent and nothing sent.
  let proxyFailed = false;
  for (const row of claimed) {
    if (proxyFailed || Date.now() >= deadline) {
      await releaseClaim(sql, row.id);
      continue;
    }
    const targets = subscriptionsForRow(row.dedupe_key, subscriptions);
    if (!targets.length) {
      // Not cancelled: a cancelled row keeps its dedupe key forever, so a phone that re-subscribes
      // minutes later (for instance after a VAPID rotation) could never receive it. Keep it pending,
      // without spending an attempt, until a subscription appears or `expires_at` passes.
      await sql`
        UPDATE push_outbox SET attempts=attempts-1, last_error='no_subscriptions',
          next_attempt_at=now() + (${NO_SUBSCRIPTION_RETRY_MS} * INTERVAL '1 millisecond')
        WHERE id=${row.id}
      `;
      result.deferredNoSubscription += 1;
      continue;
    }

    const ttlSeconds = Math.max(
      1,
      Math.round((row.expires_at.getTime() - Date.now()) / 1000) || PUSH_TTL_SECONDS_DEFAULT
    );
    const topic = topicFor(row.payload.tag);
    let delivered = false;
    let lastError: string | undefined;

    let outOfTime = false;
    for (const subscription of targets) {
      if (Date.now() >= deadline) {
        outOfTime = true;
        break;
      }
      let outcome: Awaited<ReturnType<typeof sendPushViaProxy>>;
      try {
        outcome = await sendPushViaProxy({
          subscription: {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth }
          },
          payload: JSON.stringify(row.payload),
          ttlSeconds,
          urgency: "high",
          topic
        });
      } catch {
        proxyFailed = true;
        break;
      }
      if (outcome.outcome === "delivered") {
        delivered = true;
        await recordPushSuccess(sql, subscription.id);
      } else if (outcome.outcome === "gone") {
        await deletePushSubscriptionById(sql, userId, subscription.id);
      } else {
        await recordPushFailure(sql, subscription.id);
        lastError = `${outcome.outcome}${outcome.httpStatus ? ` (${outcome.httpStatus})` : ""}`;
      }
    }

    if (delivered) {
      await sql`UPDATE push_outbox SET status='sent', sent_at=now() WHERE id=${row.id}`;
      // Sent, not queued, is what makes a check-in prompted: its timeout starts counting from here.
      if (row.kind === "check_in_waiting" && row.payload.checkInId)
        await stampCheckInPrompted(sql, userId, row.payload.checkInId);
      result.sent += 1;
    } else if (outOfTime || proxyFailed) {
      // Not a failure of the endpoint: the budget ran out, or the proxy itself was unreachable.
      await releaseClaim(sql, row.id);
    } else if (row.attempts + 1 >= MAX_ATTEMPTS) {
      await sql`UPDATE push_outbox SET status='failed', last_error=${lastError ?? "no delivery"} WHERE id=${row.id}`;
    } else {
      await sql`
        UPDATE push_outbox SET next_attempt_at=now() + (${RETRY_DELAY_MS} * INTERVAL '1 millisecond'),
          last_error=${lastError ?? "no delivery"}
        WHERE id=${row.id}
      `;
    }
  }

  return result;
}
