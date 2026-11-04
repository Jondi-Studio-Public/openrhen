/**
 * Failed-token throttle: one address may present this many unrecognised tokens in a window before it is
 * answered 429 until the window ends. In memory, so a restart clears it; the tokens are 32 random bytes, so
 * this limits noise and database load, not the odds of a guess.
 */
export const THROTTLE_MAX_FAILURES = 10;
export const THROTTLE_WINDOW_MS = 60_000;
const MAX_TRACKED = 1000;

export interface FailureThrottle {
  /** Seconds the address must wait, or 0 when it may try. */
  retryAfter(address: string, now?: number): number;
  fail(address: string, now?: number): void;
}

export function createFailureThrottle(limit = THROTTLE_MAX_FAILURES, windowMs = THROTTLE_WINDOW_MS): FailureThrottle {
  const windows = new Map<string, { start: number; failures: number }>();
  const live = (address: string, now: number) => {
    const entry = windows.get(address);
    if (!entry) return undefined;
    if (now - entry.start >= windowMs) {
      windows.delete(address);
      return undefined;
    }
    return entry;
  };
  return {
    retryAfter(address, now = Date.now()) {
      const entry = live(address, now);
      return entry && entry.failures >= limit ? Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)) : 0;
    },
    fail(address, now = Date.now()) {
      const entry = live(address, now);
      if (entry) entry.failures += 1;
      else {
        if (windows.size >= MAX_TRACKED) for (const key of windows.keys()) live(key, now);
        // Still full of live windows: drop the oldest rather than grow without bound.
        if (windows.size >= MAX_TRACKED) windows.delete(windows.keys().next().value as string);
        windows.set(address, { start: now, failures: 1 });
      }
    }
  };
}

/**
 * The address a request came from. The portal sits behind Caddy, which appends the connecting address to
 * `X-Forwarded-For`; the last entry is the one the nearest proxy wrote, so a client cannot choose it. With no
 * proxy header every caller shares one bucket, which is the safe direction.
 */
export function remoteAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const last = forwarded?.split(",").at(-1)?.trim();
  return last ? last.slice(0, 64) : "direct";
}

/** The one throttle for every secret the portal checks: agent tokens, owner tokens, browser sessions and the recovery token. */
export const sharedFailureThrottle: FailureThrottle = createFailureThrottle();
