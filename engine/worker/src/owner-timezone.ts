import { resolveTimezone } from "@openrhen/contracts";

type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * The owner's timezone, read from the database at most once per `ttlMs`, so a change made in Settings
 * reaches the worker's daily triggers within a minute. The stored value wins, then `APP_TIMEZONE`, then
 * the default (`resolveTimezone`). A failed read logs one line and keeps the last good value, or the
 * env/default fallback if there has been none. The returned function never throws.
 */
export function createOwnerTimezone(
  read: () => Promise<string | null>,
  env: EnvLike,
  ttlMs = 60_000
): () => Promise<string> {
  let value: string | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  return async () => {
    if (value !== null && Date.now() - readAt < ttlMs) return value;
    try {
      value = resolveTimezone((await read())?.trim() ?? null, env);
      readAt = Date.now();
      return value;
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          level: "error",
          message: "Reading the owner timezone failed; using the last known value",
          error: error instanceof Error ? error.message : "Unknown error"
        })}\n`
      );
      // Retry on the next call rather than caching the failure for a full ttl.
      readAt = Number.NEGATIVE_INFINITY;
      return value ?? resolveTimezone(null, env);
    }
  };
}
