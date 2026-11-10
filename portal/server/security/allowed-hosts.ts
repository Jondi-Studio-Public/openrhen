/**
 * The lowercased Host values the portal accepts (`PORTAL_ALLOWED_HOSTS`, comma-separated
 * `host[:port]`), or `undefined` when no allowlist is configured.
 *
 * Reads `process.env` itself rather than going through `runtime-env`: `withRoute` runs ahead of every
 * handler, and the many route tests that replace `runtime-env` with a partial mock must not have to
 * know about this setting.
 */
export function portalAllowedHosts(): string[] | undefined {
  const hosts = (process.env.PORTAL_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return hosts.length ? hosts : undefined;
}

/** Loopback names accepted on any port when no allowlist is set. */
const DEFAULT_LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The compose service name other containers use to reach the portal. */
const DEFAULT_SERVICE_HOST = "portal:8787";

function hostname(host: string): string {
  // "[::1]:8787" -> "[::1]"; "localhost:8787" -> "localhost"; "localhost" -> "localhost".
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    // Anything after the bracket other than ":port" makes it a different (unlisted) name.
    return end === -1 || !/^(:\d*)?$/.test(host.slice(end + 1)) ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

/** `PORTAL_PUBLIC_URL` as set (trimmed), or undefined. */
export function portalPublicUrl(): string | undefined {
  return process.env.PORTAL_PUBLIC_URL?.trim() || undefined;
}

function publicUrlHost(): string | undefined {
  const raw = portalPublicUrl();
  if (!raw) return undefined;
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Whether a request's Host header is acceptable (DNS-rebinding defence, which `Origin`/`Host` matching
 * cannot provide: a rebound page's Origin and Host agree).
 *
 * With `PORTAL_ALLOWED_HOSTS` set, only those values pass. Unset, the default is closed rather than
 * open: loopback names on any port, the compose service name, and the host of `PORTAL_PUBLIC_URL`.
 * A request with no Host header at all passes only in the default mode: every browser sends one, and
 * a rebound page always carries its own name in it.
 */
export function portalHostAllowed(rawHost: string | null | undefined): boolean {
  const host = rawHost?.trim().toLowerCase();
  const configured = portalAllowedHosts();
  if (configured) return Boolean(host) && configured.includes(host as string);
  if (!host) return true;
  if (DEFAULT_LOOPBACK_HOSTNAMES.has(hostname(host))) return true;
  return host === DEFAULT_SERVICE_HOST || host === publicUrlHost();
}
