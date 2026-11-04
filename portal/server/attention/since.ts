import { ATTENTION_WINDOW_DAYS, attentionIso, offsetDateTimeMessage } from "@openrhen/contracts";

const DAY_MS = 86_400_000;

export type SinceRead = { ok: true; since?: string } | { ok: false; error: string };

/**
 * The `since` query value: absent is fine; anything that is not an ISO date-time with an offset is refused with the
 * contracts' text, which shows the value sent, the accepted form with an example and what to do with a relative date.
 */
export function parseAttentionSince(raw: string | null): SinceRead {
  if (raw === null) return { ok: true };
  const since = attentionIso(raw);
  return since === undefined ? { ok: false, error: offsetDateTimeMessage(raw) } : { ok: true, since };
}

export type SinceMoved = "future" | "older_than_window";

/** `since` clamped to the last 7 days and to `now`; says which way it moved. */
export function clampAttentionSince(since: string | undefined, now: Date): { since?: string; moved?: SinceMoved } {
  if (since === undefined) return {};
  const sentMs = Date.parse(since);
  const floorMs = now.getTime() - ATTENTION_WINDOW_DAYS * DAY_MS;
  if (sentMs > now.getTime()) return { since: now.toISOString(), moved: "future" };
  if (sentMs < floorMs) return { since: new Date(floorMs).toISOString(), moved: "older_than_window" };
  return { since: new Date(sentMs).toISOString() };
}

/** Said in the answer when `since` was moved. Names only tools the contract serves. */
export const SINCE_NOTE: Readonly<Record<SinceMoved, string>> = {
  future: "since was in the future and was moved to now.",
  older_than_window:
    "since was older than 7 days and was moved to the start of the 7 day window; outcomes before it are in " +
    "rhen_proposals and rhen_changes."
};
