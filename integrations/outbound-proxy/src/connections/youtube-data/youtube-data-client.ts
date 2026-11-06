import type { CapabilityFailure, VideoDurationsRequest, VideoDurationsResponse } from "@openrhen/contracts";

/**
 * YouTube Data API v3 `videos.list` for video lengths: up to 50 ids per call, one quota unit. The key goes to Google
 * in the `x-goog-api-key` header only, never in the URL, and no text from a failure (Google's or a thrown error's)
 * is passed on, so a message that echoes the key cannot leave this file.
 */

const ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";

const MAX_DURATION_S = 7 * 86_400;

/** Seconds in an ISO-8601 duration (`PT4M13S`, `P1DT2H`); null for zero (a live or upcoming video), anything unreadable, or more than 7 days (one absurd value must not fail the batch). */
export function parseIsoDuration(text: string): number | null {
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text);
  if (!match) return null;
  const [, weeks, days, hours, minutes, seconds] = match;
  const total =
    Number(weeks ?? 0) * 604_800 +
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  return Number.isFinite(total) && total > 0 && total <= MAX_DURATION_S ? Math.round(total) : null;
}

export type DurationsResult =
  | ({ ok: true } & VideoDurationsResponse)
  | { ok: false; status: number; reason: NonNullable<CapabilityFailure["reason"]>; error: string };

const fail = (status: number, reason: NonNullable<CapabilityFailure["reason"]>, error: string): DurationsResult => ({
  ok: false,
  status,
  reason,
  error
});

/** The day's quota is gone: nothing more can be asked until midnight Pacific time. */
const DAILY_QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded"]);
/** A burst limit: a short pause is enough, and the day is not used up. */
const BURST_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

interface GoogleError {
  error?: { code?: number; message?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] };
}

export async function fetchVideoDurations(
  { apiKey, ids }: VideoDurationsRequest,
  fetcher: typeof fetch,
  signal?: AbortSignal
): Promise<DurationsResult> {
  const url = `${ENDPOINT}?${new URLSearchParams({ part: "contentDetails", id: ids.join(",") })}`;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { "x-goog-api-key": apiKey, accept: "application/json" },
      redirect: "error",
      ...(signal ? { signal } : {})
    });
  } catch {
    // The thrown message is dropped on purpose: it can quote request headers, which carry the key.
    if (signal?.aborted) throw new Error("The YouTube Data API call was cancelled.");
    return fail(502, "unreachable", "Could not reach the YouTube Data API.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return fail(502, "unreachable", "The YouTube Data API answered something unreadable.");
  }
  if (!response.ok) {
    const error = (body as GoogleError | null)?.error;
    const reasons = [...(error?.errors ?? []), ...(error?.details ?? [])].map((entry) => entry.reason ?? "");
    if (
      reasons.some((reason) => BURST_LIMIT_REASONS.has(reason)) &&
      !reasons.some((reason) => DAILY_QUOTA_REASONS.has(reason))
    )
      return fail(429, "rate_limited", "The YouTube Data API asked for a short pause. Try again in a minute.");
    if (response.status === 403 && reasons.some((reason) => DAILY_QUOTA_REASONS.has(reason)))
      return fail(429, "quota_exceeded", "The YouTube Data API's daily quota is used up. Lengths resume tomorrow.");
    if (
      reasons.includes("API_KEY_INVALID") ||
      reasons.includes("keyInvalid") ||
      (response.status === 400 && /api key/i.test(error?.message ?? ""))
    )
      return fail(401, "invalid_credentials", "Google does not accept that YouTube API key.");
    if (response.status === 403)
      return fail(
        403,
        "forbidden",
        "Google refused the key. Check that the YouTube Data API v3 is enabled for it and that it is not restricted away from this use."
      );
    return fail(502, "unreachable", `The YouTube Data API answered with status ${response.status}.`);
  }
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return fail(502, "unreachable", "The YouTube Data API answered something unexpected.");
  const found = new Map<string, number | null>();
  for (const item of items as { id?: unknown; contentDetails?: { duration?: unknown } }[]) {
    if (typeof item?.id !== "string") continue;
    const duration = item.contentDetails?.duration;
    found.set(item.id, typeof duration === "string" ? parseIsoDuration(duration) : null);
  }
  return {
    ok: true,
    videos: ids.map((id) =>
      found.has(id)
        ? { id, durationS: found.get(id) ?? null, unavailable: false }
        : { id, durationS: null, unavailable: true }
    )
  };
}
