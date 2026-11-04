import { DEFAULT_LOCALE, resolveLocale, type LeaveByPushPayload } from "@openrhen/contracts";
import type { Sql } from "@/server/persistence/postgres/sql-pool";

/**
 * The "new device" announcement (security review W3). Adding a Web Push device queues one `push_outbox`
 * row in the same transaction as the insert; the ordinary drain sends it, to every subscription except
 * the new one (`subscriptionsForRow` in `push-drain.ts` reads the id back out of the dedupe key).
 *
 * No migration: the row uses the existing `test` kind (the one kind the scheduler's "already sent"
 * check ignores) and tells itself apart by its `device_added:<subscription id>` dedupe key.
 */

/** Long enough for a phone that is switched off or out of signal to see it when it comes back. */
export const DEVICE_ADDED_TTL_MS = 60 * 60_000;
const LABEL_MAX_CHARS = 40;
export const DEVICE_ADDED_DEDUPE_PREFIX = "device_added:";

/** The device's self-reported label, made safe to show inside a sentence: no control characters, one line, short. */
export function announcedLabel(label: string | null | undefined): string {
  const clean = (label ?? "")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "Unnamed device";
  return clean.length > LABEL_MAX_CHARS ? `${clean.slice(0, LABEL_MAX_CHARS - 1)}…` : clean;
}

export function deviceAddedPayload(
  label: string | null | undefined,
  now: Date,
  timeZone: string,
  dedupeKey: string,
  locale = DEFAULT_LOCALE
): LeaveByPushPayload {
  const when = new Intl.DateTimeFormat(locale, {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit"
  }).format(now);
  return {
    title: "New notification device",
    body: `New device added for OpenRhen notifications: ${announcedLabel(label)}, ${when}. Not yours? Remove it in Settings > Notifications.`,
    tag: dedupeKey,
    url: "/settings/notifications",
    renotify: true
  };
}

export async function queueDeviceAddedAnnouncement(
  sql: Sql,
  input: {
    userId: string;
    newSubscriptionId: string;
    label: string | null | undefined;
    timeZone: string;
    locale?: string | undefined;
    now: Date;
  }
): Promise<void> {
  const dedupeKey = `${DEVICE_ADDED_DEDUPE_PREFIX}${input.newSubscriptionId}`;
  const payload = deviceAddedPayload(input.label, input.now, input.timeZone, dedupeKey, resolveLocale(input.locale));
  const expiresAt = new Date(input.now.getTime() + DEVICE_ADDED_TTL_MS);
  await sql`
    INSERT INTO push_outbox (user_id, dedupe_key, kind, payload, status, expires_at)
    VALUES (${input.userId}, ${dedupeKey}, 'test', ${sql.json(payload as never)}, 'pending', ${expiresAt})
    ON CONFLICT DO NOTHING
  `;
}
