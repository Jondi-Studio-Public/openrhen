import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  connectionManifest,
  connectionRegistry,
  isAllowedPushEndpoint,
  pushSendRequestSchema
} from "@openrhen/contracts";
import { connectionStatuses, secretReadiness } from "./host/connection-host.js";
import { routeCapability } from "./host/capability-router.js";
import {
  fetchWithSignal,
  json,
  PLACEHOLDER_CREDENTIAL,
  maxBodyBytes,
  readBody,
  runUpstream,
  tooLarge,
  upstreamTimeoutMs
} from "./host/http.js";
import { resetAiRateLimitForTests, takeAiRateSlot, takeEmbeddingRateSlot } from "./host/rate.js";
import "./drop-ins.js";
import { registeredConnections } from "./host/connection-registry.js";
import { findProxyRoute } from "./host/route-registry.js";
import { sendWebPush, vapidConfigFromEnv } from "./web-push.js";

export interface ServiceConfig {
  token: string;
}

export { PLACEHOLDER_CREDENTIAL };

export { resetAiRateLimitForTests, takeAiRateSlot, takeEmbeddingRateSlot };

/** The providers `/ready` always reports, each the id of the connection whose secrets it reads. */
const CORE_READINESS_CONNECTIONS = ["openai", "google"] as const;

/**
 * Which upstream providers currently have real (non-empty, non-placeholder) credentials configured, from the
 * manifests' secret groups: the core pair, then each connection a drop-in registered, in registration order.
 */
export function providerReadiness(env: Record<string, string | undefined> = process.env): Record<string, boolean> {
  const ids = [...CORE_READINESS_CONNECTIONS, ...registeredConnections().map(({ manifest }) => manifest.id)];
  return Object.fromEntries(
    ids.map((id) => {
      const manifest = connectionManifest(id);
      return [id, manifest ? secretReadiness(manifest.secrets.anyOf, env).ready : false];
    })
  );
}

/** Secret names (from every manifest) whose value is still the compose placeholder - worth a startup warning, not a hard failure. */
export function placeholderCredentialWarnings(env: Record<string, string | undefined> = process.env): string[] {
  const names = new Set(connectionRegistry().flatMap((manifest) => manifest.secrets.anyOf.flat()));
  return [...names].filter((name) => env[name]?.trim() === PLACEHOLDER_CREDENTIAL);
}

export async function handleRequest(request: IncomingMessage, response: ServerResponse, config: ServiceConfig) {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  logWhenFinished(request, response, pathname);

  // One AbortController per request, aborted when the client disconnects before the response
  // finished — a tab closed, the portal's own timeout, a dead network. The same controller is also
  // what `runUpstream` and the streaming route below abort on a wall-clock timeout, so either cause
  // reaches the same place: the upstream fetch's signal.
  //
  // Deliberately keyed off `response`'s "close", not `request`'s: `IncomingMessage` fires "close" as
  // soon as its body has been fully read, which happens on every ordinary request the instant
  // `readBody` finishes — nothing to do with the client going away. `ServerResponse` fires "close"
  // once the underlying connection ends, which happens on both a normal finish and a premature
  // disconnect; `!response.writableEnded` (still true when `finally` below runs) is what tells them
  // apart.
  const controller = new AbortController();
  let requestFinished = false;
  const abortIfStillOpen = () => {
    if (!requestFinished && !response.writableEnded) controller.abort();
  };
  response.on("close", abortIfStillOpen);
  try {
    return await routeRequest(request, response, config, pathname, controller);
  } finally {
    requestFinished = true;
    response.off("close", abortIfStillOpen);
  }
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServiceConfig,
  pathname: string,
  controller: AbortController
) {
  if (request.method === "GET" && pathname === "/health") return json(response, 200, { status: "ok" });
  if (request.method === "GET" && pathname === "/ready")
    return json(response, 200, { ready: true, providers: providerReadiness() });
  // A token still holding compose.yaml's placeholder is public knowledge, so it authorises nothing.
  if (config.token.trim() === PLACEHOLDER_CREDENTIAL || !authorised(request.headers.authorization, config.token))
    return json(response, 401, { error: "A valid bearer token is required." });

  if (request.method === "GET" && pathname === "/connections")
    return json(response, 200, { connections: connectionStatuses() });
  if (pathname.startsWith("/capabilities/")) {
    await routeCapability(request, response, controller, pathname);
    return;
  }

  // Web Push lives here for the same reason as every other third-party credential: the VAPID
  // private key exists only in this process's environment.
  if (request.method === "GET" && pathname === "/push/vapid-public-key") {
    const config = vapidConfigFromEnv();
    if (!config) return json(response, 503, { error: "Web push is not configured." });
    return json(response, 200, { publicKey: config.publicKey });
  }

  if (request.method === "POST" && pathname === "/push/send") {
    const config = vapidConfigFromEnv();
    if (!config) return json(response, 503, { error: "Web push is not configured." });
    const body = await readBody(request, maxBodyBytes());
    if (body.error === "too_large") return tooLarge(response);
    if (body.error) return json(response, 400, { error: "The request body must be valid JSON." });
    const parsed = pushSendRequestSchema.safeParse(body.value);
    if (!parsed.success) return json(response, 400, { error: "The push send request failed validation." });
    // This route must never become an open outbound fetch: refused up front, ahead of the encrypt
    // step `sendWebPush` would otherwise spend doing work for an endpoint it will reject anyway.
    if (!isAllowedPushEndpoint(parsed.data.subscription.endpoint))
      return json(response, 400, { error: "The push endpoint's host is not on the allowlist." });
    try {
      const outcome = await runUpstream(response, controller, upstreamTimeoutMs(), () =>
        sendWebPush(parsed.data, config, fetchWithSignal(controller.signal))
      );
      if (!outcome.ok) return;
      return json(response, 200, outcome.value);
    } catch (error) {
      return json(response, 502, { error: error instanceof Error ? error.message : "The push send failed." });
    }
  }

  // Routes a drop-in registered (a native push transport), after authorisation like every route above.
  const dropInRoute = findProxyRoute(request.method, pathname);
  if (dropInRoute) return dropInRoute.handle({ request, response, controller });

  return json(response, 404, { error: "Route not found." });
}

/**
 * One line per request, written when the response is finished so the duration covers the third-party
 * call this proxy exists to make — the number that answers "which upstream was slow?".
 *
 * The path is the route only. No header, query string, or body reaches the line: this process holds
 * every third-party credential in the stack, so its log is the one that must never carry one.
 *
 * `/ready` and `/health` are the container healthcheck's targets every five seconds and stay silent
 * while they succeed. Suppressed under `NODE_ENV=test`, where the suite drives this handler directly.
 */
function logWhenFinished(request: IncomingMessage, response: ServerResponse, pathname: string) {
  if (process.env.NODE_ENV === "test") return;
  const startedAt = Date.now();
  response.on("finish", () => {
    const probe = pathname === "/ready" || pathname === "/health";
    if (probe && response.statusCode < 400) return;
    const level = response.statusCode >= 500 ? "error" : "info";
    const line = `${JSON.stringify({
      level,
      message: "Outbound integrations proxy request",
      method: request.method ?? "UNKNOWN",
      path: pathname,
      status: response.statusCode,
      durationMs: Date.now() - startedAt
    })}\n`;
    if (level === "error") process.stderr.write(line);
    else process.stdout.write(line);
  });
}

function authorised(header: string | undefined, configuredToken: string) {
  if (!configuredToken || !header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(configuredToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
