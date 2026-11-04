/**
 * Every runtime setting the portal reads comes from the process environment, in one place.
 *
 * The portal used to run on the Cloudflare Workers runtime, where the same values arrived as Worker
 * bindings via `cloudflare:workers` — the database as a Hyperdrive binding, everything else as plain
 * vars. It now runs on plain Node, so all of it is `process.env`: `compose.yaml` sets these on the
 * portal service and nothing is baked into the image.
 */

export interface RuntimeEnv {
  /**
   * `process.env` carries more than the portal names here, and callers that take a plain
   * `Record<string, string | undefined>` (the extractors, the proxy clients) accept this type.
   */
  [key: string]: string | undefined;
  /** PostgreSQL connection string. The portal has no fallback store; without this it cannot serve. */
  DATABASE_URL?: string;
  /** Base URL of the outbound-proxy sidecar, which holds the third-party API keys. */
  OUTBOUND_PROXY_URL?: string;
  OUTBOUND_PROXY_TOKEN?: string;
  PLAN_FORECAST_SERVICE_URL?: string;
  PLAN_FORECAST_SERVICE_TOKEN?: string;
  PLAN_FORECAST_REQUEST_TIMEOUT_MS?: string;
  /**
   * Ceiling for a single outbound HTTPS call made through the sidecar — travel, the calendar provider, an OpenAI
   * extraction, a reachability probe. These used to have no `AbortController` at all, so a stalled
   * sidecar or a hung third party held the request (and the person's browser) open indefinitely.
   */
  OUTBOUND_REQUEST_TIMEOUT_MS?: string;
  /**
   * Idle deadline for the deliverable chat's streamed reply: aborts only when the sidecar goes silent
   * for this long between SSE bytes, resetting on every chunk. Kept separate from
   * `OUTBOUND_REQUEST_TIMEOUT_MS` because a legitimate reply can run far longer than a normal
   * request/response call as long as tokens keep arriving.
   */
  CHAT_STREAM_IDLE_TIMEOUT_MS?: string;
  /** Folder the photo check-in blobs live in, on a volume that is backed up. Unset disables photo upload. */
  PHOTO_STORE_DIR?: string;
  /** Shared secret the phone presents to `POST /api/location/ping`. Unset disables that endpoint. */
  LOCATION_PING_TOKEN?: string;
  /**
   * Comma-separated `host[:port]` values the portal answers to, matched against the Host header on
   * every request (DNS-rebinding defence). Unset means only loopback, `portal:8787` and the `PORTAL_PUBLIC_URL` host are accepted.
   */
  PORTAL_ALLOWED_HOSTS?: string;
  /**
   * JSON array of `{ name, sha256, writes }`: the agents that may present `X-OpenRhen-Token`, each with
   * the sha256 of its token and the routes it may write (the design notes, phase 2).
   * Hashes only. Unset means no agent has a token.
   */
  OPENRHEN_AGENT_TOKENS?: string;
  /** `off` (default) or `require`: with `require`, a self-declared agent name without a token is refused. */
  OPENRHEN_AGENT_AUTH?: string;
}

const DEFAULT_OUTBOUND_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CHAT_STREAM_IDLE_TIMEOUT_MS = 60_000;

export function runtimeEnv(): RuntimeEnv {
  return process.env as RuntimeEnv;
}

/**
 * The connection string, or `undefined` when the portal has not been given a database. Callers say
 * what they were trying to do, so the reader gets a message about the feature rather than about
 * configuration plumbing.
 */
export function databaseUrl(): string | undefined {
  return runtimeEnv().DATABASE_URL?.trim() || undefined;
}

/**
 * The token the phone must present to move the location assertion, or `undefined` when none is
 * configured. Unlike every other portal route this one is meant to be reached from outside the
 * house, so an absent token closes the endpoint rather than opening it: the portal has no auth of
 * its own, and an unauthenticated way to say where somebody is would be a way for anyone to say it.
 */
export function locationPingToken(): string | undefined {
  return runtimeEnv().LOCATION_PING_TOKEN?.trim() || undefined;
}

/** Where photo check-in blobs are kept, or `undefined` when no folder is configured (upload then refuses). */
export function photoStoreDir(): string | undefined {
  return runtimeEnv().PHOTO_STORE_DIR?.trim() || undefined;
}

/** The sidecar's URL and token, or `null` when either is missing and outbound calls cannot be made. */
export function outboundProxyConfig(): { url: string; token: string } | null {
  const env = runtimeEnv();
  const url = env.OUTBOUND_PROXY_URL?.trim();
  const token = env.OUTBOUND_PROXY_TOKEN?.trim();
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

/** The timeout (ms) for a single outbound sidecar call, from `OUTBOUND_REQUEST_TIMEOUT_MS` or the default. */
export function outboundRequestTimeoutMs(env: Record<string, string | undefined> = runtimeEnv()): number {
  return positiveInteger(env.OUTBOUND_REQUEST_TIMEOUT_MS, DEFAULT_OUTBOUND_REQUEST_TIMEOUT_MS);
}

/** The idle deadline (ms) for the deliverable chat stream, from `CHAT_STREAM_IDLE_TIMEOUT_MS` or the default. */
export function chatStreamIdleTimeoutMs(env: Record<string, string | undefined> = runtimeEnv()): number {
  return positiveInteger(env.CHAT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_CHAT_STREAM_IDLE_TIMEOUT_MS);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
