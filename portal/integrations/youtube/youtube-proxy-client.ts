import { resolveConnection, videoDurationsResponseSchema, type VideoDurationsResponse } from "@openrhen/contracts";
import { callCapability, ConnectionHostNotConfiguredError } from "@/integrations/connection-host-client";
import type { Sql } from "@/server/persistence/postgres/sql-pool";
import { readSecret } from "@/server/secrets/read-secret";

/**
 * The one place a saved YouTube key is read and used: the proxy-call helper. It decrypts the key, puts it in the body
 * of one `video_metadata.durations` call to the outbound proxy (which sends it to Google in a header), and returns
 * only the outcome. The key is never returned, logged or kept; this is the only file allowed to import `readSecret`
 * (`scripts/repository/secret-reader-rule.mjs`).
 */

export type VideoLengthsOutcome =
  | { kind: "ok"; videos: VideoDurationsResponse["videos"] }
  | { kind: "no_key" }
  | { kind: "key_unreadable" }
  | { kind: "bad_key" }
  | { kind: "quota" }
  | { kind: "rate_limited" }
  | { kind: "unreachable" }
  | { kind: "not_ready" };

export interface VideoLengthsDeps {
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
}

export async function fetchVideoLengths(
  sql: Sql,
  userId: string,
  ids: readonly string[],
  deps: VideoLengthsDeps = {}
): Promise<VideoLengthsOutcome> {
  const key = await readSecret(sql, userId, "youtube_data_api_key", deps.env);
  if (key.kind === "unset") return { kind: "no_key" };
  if (key.kind === "unreadable") return { kind: "key_unreadable" };
  let result;
  try {
    result = await callCapability({
      connectionId: resolveConnection("video_metadata", "durations").id,
      capability: "video_metadata",
      op: "durations",
      body: { apiKey: key.value, ids },
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.fetcher ? { fetcher: deps.fetcher } : {})
    });
  } catch (error) {
    if (error instanceof ConnectionHostNotConfiguredError) return { kind: "not_ready" };
    // The thrown error is dropped on purpose; only the fact that the proxy could not be reached is kept.
    return { kind: "unreachable" };
  }
  if (!result.ok) {
    // The proxy itself refused us (its bearer token is the compose placeholder or does not match): not Google's answer.
    if (result.status === 401 && !result.failure?.reason) return { kind: "not_ready" };
    switch (result.failure?.reason) {
      case "quota_exceeded":
        return { kind: "quota" };
      case "rate_limited":
        return { kind: "rate_limited" };
      case "invalid_credentials":
      case "forbidden":
        return { kind: "bad_key" };
      case "not_ready":
      case "unknown_connection":
        return { kind: "not_ready" };
      default:
        return { kind: "unreachable" };
    }
  }
  const parsed = videoDurationsResponseSchema.safeParse(result.body);
  return parsed.success ? { kind: "ok", videos: parsed.data.videos } : { kind: "unreachable" };
}
