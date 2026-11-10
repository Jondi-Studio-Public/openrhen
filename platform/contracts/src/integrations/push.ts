import { z } from "zod";

/**
 * The wire shape between the portal and the outbound proxy for Web Push. The proxy holds the VAPID keys; the portal only ever forwards a
 * subscription and a payload, the same separation `travel.ts` and the calendar clients already draw
 * around every third-party credential.
 */

/** The four push services this route will ever send to — anything else is refused as a 400. */
export const PUSH_HOST_ALLOWLIST = [
  "web.push.apple.com",
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com"
] as const;

/** `*.notify.windows.com` is matched by suffix, not listed literally, since the subdomain varies per subscription. */
export const PUSH_HOST_SUFFIX_ALLOWLIST = [".notify.windows.com"] as const;

export function isAllowedPushHost(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    (PUSH_HOST_ALLOWLIST as readonly string[]).includes(lower) ||
    PUSH_HOST_SUFFIX_ALLOWLIST.some((suffix) => lower.endsWith(suffix))
  );
}

/** Validates an endpoint URL is https and its host is on the allowlist. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && isAllowedPushHost(url.hostname);
  } catch {
    return false;
  }
}

export const pushSubscriptionKeysSchema = z.object({
  p256dh: z.string().min(1),
  auth: z.string().min(1)
});

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: pushSubscriptionKeysSchema
});
export type PushSubscriptionWire = z.infer<typeof pushSubscriptionSchema>;

/** `POST /push/send` on the proxy. */
export const pushSendRequestSchema = z.object({
  subscription: pushSubscriptionSchema,
  /** The plaintext notification payload, JSON-encoded, at most 3,000 bytes once encrypted. */
  payload: z.string().min(1).max(3000),
  ttlSeconds: z.number().int().positive().max(2_592_000),
  urgency: z.enum(["high", "normal"]),
  /** A 32-character hash of the notification `tag`, so a newer prompt replaces the older one. */
  topic: z.string().min(1).max(32).optional()
});
export type PushSendRequest = z.infer<typeof pushSendRequestSchema>;

export const pushSendOutcomeSchema = z.enum(["delivered", "gone", "rejected", "failed"]);
export type PushSendOutcome = z.infer<typeof pushSendOutcomeSchema>;

export const pushSendResultSchema = z.object({
  outcome: pushSendOutcomeSchema,
  httpStatus: z.number().int().optional()
});
export type PushSendResult = z.infer<typeof pushSendResultSchema>;

/** `GET /push/vapid-public-key` on the proxy. */
export const pushVapidPublicKeyResultSchema = z.object({ publicKey: z.string().min(1) });
export type PushVapidPublicKeyResult = z.infer<typeof pushVapidPublicKeyResultSchema>;

/** The self-contained payload every leave-by push carries. */
export const leaveByPushPayloadSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(500),
  tag: z.string().min(1).max(200),
  url: z.string().min(1),
  /** `true` for the at-leave-by and leave-earlier prompts, so a newer one replaces an older one
   * already showing (`tag` is always set) instead of the OS staying silent about the replacement
   * Absent/false for the lead reminder. */
  renotify: z.boolean().optional(),
  /** Set on a "check-in waiting" push: the check-in it asks about, so a channel can open or answer it. */
  checkInId: z.string().uuid().optional()
});
export type LeaveByPushPayload = z.infer<typeof leaveByPushPayloadSchema>;

/** `POST /api/push/subscriptions` on the portal. */
export const pushSubscribeRequestSchema = z.object({
  subscription: pushSubscriptionSchema,
  vapidPublicKey: z.string().min(1),
  /** From the subscribing browser's user agent, e.g. "iPhone" — shown on the Notifications page. */
  label: z.string().min(1).max(80).optional()
});
export type PushSubscribeRequest = z.infer<typeof pushSubscribeRequestSchema>;

export const pushUnsubscribeRequestSchema = z.object({ endpoint: z.string().url() });
export type PushUnsubscribeRequest = z.infer<typeof pushUnsubscribeRequestSchema>;
