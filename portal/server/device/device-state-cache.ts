import type { PortalState } from "@/state/portal-state";

/**
 * A short-lived in-memory cache of the hydrated `PortalState` the device routes read, so a battery
 * device polling every ~30s (plus the occasional retry) doesn't pay for the full ~25-query state
 * hydration (`NormalizedPostgresStateStore.get()`, via `getStateStore().get()`) on every single poll.
 * The `ETag`/`If-None-Match` pair on `GET /api/device/now` already makes a *response* cheap when
 * nothing changed, but the hydration still ran in full every time just to compute that ETag — this
 * cache is what actually skips the work.
 *
 * Keyed by user rather than a single slot, matching the shape a multi-tenant deployment would need —
 * though today's app is single-tenant/no-auth, so there is exactly one entry in practice. Getting a
 * real `userId` here would cost its own query (`ensureUser`), which would partly defeat the point, so
 * a fixed key stands in for "the app's one user" rather than the true tenant key.
 *
 * `POST /api/device/action` must never read from this cache — it does a genuine read-modify-write
 * against the current row and needs the true latest state — and must clear the cache after a
 * successful write (`clearCachedDeviceState`) so the very next poll reflects it rather than serving
 * the pre-action snapshot for up to `TTL_MS` longer.
 *
 * Single-process only: a second Node process (a second container, a horizontally scaled deploy) would
 * keep its own cache and could serve state up to `TTL_MS` stale after a write made through the other
 * process. Fine for the current single-instance deployment; a multi-process one would need an explicit
 * invalidation channel (pub/sub, a shared cache) instead of this in-memory `Map`.
 */
const TTL_MS = 7_000;
const SINGLE_TENANT_KEY = "device-now";

interface CacheEntry {
  state: PortalState;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** The cached state, or `null` if there is none or it has aged past `TTL_MS`. */
export function getCachedDeviceState(): PortalState | null {
  const entry = cache.get(SINGLE_TENANT_KEY);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.state;
}

export function setCachedDeviceState(state: PortalState): void {
  cache.set(SINGLE_TENANT_KEY, { state, expiresAt: Date.now() + TTL_MS });
}

/** Called after any write a device action makes, so the next poll can't read stale pre-action state. */
export function clearCachedDeviceState(): void {
  cache.delete(SINGLE_TENANT_KEY);
}
