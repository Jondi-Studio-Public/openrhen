/**
 * The portal's own liveness route, the same one its container healthcheck uses: 200 only when the portal
 * is listening and can reach Postgres. It is open to unauthenticated callers, so no token is sent.
 */
export const PORTAL_READY_PATH = "/api/health/database";

export const PORTAL_WAIT_TIMEOUT_DEFAULT_MS = 120_000;
const PORTAL_WAIT_POLL_MS = 1_000;
const PORTAL_WAIT_LOG_EVERY_MS = 10_000;
const PORTAL_WAIT_REQUEST_TIMEOUT_MS = 5_000;

export interface WaitForPortalOptions {
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean }>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Writes one log line (a JSON object). Only the base URL's origin, never a header or token, is logged. */
  log?: (line: Record<string, unknown>) => void;
  timeoutMs?: number;
  isStopping?: () => boolean;
}

/**
 * Waits for the portal to answer its health route so the worker's first portal calls do not fail with
 * "fetch failed" while the portal is still starting (compose starts the worker as soon as the engine
 * service is healthy and migrations are done, not when the portal listens). Bounded: after `timeoutMs`
 * it returns "timeout" and the caller starts its loops anyway, as before. Logs at info level, at most
 * one line per ten seconds. Resolves to "ready", "timeout" or "stopped".
 */
export async function waitForPortal(
  portalUrl: string,
  options: WaitForPortalOptions = {}
): Promise<"ready" | "timeout" | "stopped"> {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init as RequestInit) as Promise<{ ok: boolean }>);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line) => process.stdout.write(`${JSON.stringify(line)}\n`));
  const timeoutMs = options.timeoutMs ?? PORTAL_WAIT_TIMEOUT_DEFAULT_MS;
  const url = `${portalUrl.replace(/\/+$/, "")}${PORTAL_READY_PATH}`;
  const host = safeOrigin(portalUrl);
  const startedAt = now();
  let lastLoggedAt = -Infinity;
  for (;;) {
    if (options.isStopping?.()) return "stopped";
    try {
      const response = await doFetch(url, { signal: AbortSignal.timeout(PORTAL_WAIT_REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const waitedMs = now() - startedAt;
        if (waitedMs > 0 && lastLoggedAt > -Infinity)
          log({ level: "info", message: "Portal is answering, starting portal-calling loops", portal: host, waitedMs });
        return "ready";
      }
    } catch {
      // Not listening yet; keep waiting.
    }
    const waitedMs = now() - startedAt;
    if (waitedMs >= timeoutMs) {
      log({
        level: "warn",
        message: "Portal did not answer in time, starting portal-calling loops anyway",
        portal: host,
        waitedMs
      });
      return "timeout";
    }
    if (now() - lastLoggedAt >= PORTAL_WAIT_LOG_EVERY_MS) {
      lastLoggedAt = now();
      log({
        level: "info",
        message: "Waiting for the portal to answer before starting portal-calling loops",
        portal: host,
        waitedMs
      });
    }
    await sleep(Math.min(PORTAL_WAIT_POLL_MS, Math.max(1, timeoutMs - waitedMs)));
  }
}

/** Scheme, host and port only: a configured URL could carry credentials or a path that should not be logged. */
function safeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "invalid-url";
  }
}
