import {
  capabilityFailureSchema,
  capabilityPath,
  type CapabilityFailure,
  type CapabilityId,
  type OpId
} from "@openrhen/contracts";
import { outboundRequestTimeoutMs } from "@/server/runtime-env";

/**
 * The portal's one way into the connection host (the outbound-proxy sidecar): every op is a `POST`
 * with a JSON body to `/capabilities/<capability>/<connection>/<op>`. The URL and token come from
 * `env` exactly as the per-provider clients read them. This records no telemetry; the callers that
 * know the provider and operation names do.
 */
function proxyConfig(env: Record<string, string | undefined>) {
  const url = env.OUTBOUND_PROXY_URL?.trim();
  const token = env.OUTBOUND_PROXY_TOKEN?.trim();
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

/** Whether the sidecar is set up in `env`; callers that skip telemetry for an unset sidecar ask first. */
export function connectionHostConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return proxyConfig(env) !== null;
}

/** The sidecar is not set up here (`OUTBOUND_PROXY_URL` or `OUTBOUND_PROXY_TOKEN` is empty). */
export class ConnectionHostNotConfiguredError extends Error {
  constructor() {
    super("The outbound-proxy sidecar is not set up.");
    this.name = "ConnectionHostNotConfiguredError";
  }
}

export interface CapabilityCall {
  connectionId: string;
  capability: CapabilityId;
  op: OpId;
  body: unknown;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
}

/** The host's answer. `body` is the parsed JSON (or null when unreadable); `failure` is set on a non-2xx answer. */
export interface CapabilityResponse {
  ok: boolean;
  status: number;
  body: unknown;
  failure?: CapabilityFailure | undefined;
}

/** Keeps the sidecar's message even when its `reason` is one this build does not know. */
function parseFailure(body: unknown): CapabilityFailure | undefined {
  const parsed = capabilityFailureSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" ? { error } : undefined;
}

/**
 * Calls one op. Throws `ConnectionHostNotConfiguredError` without a request when the sidecar is not
 * set up, and lets a network error or timeout propagate: how each is reported belongs to the caller.
 */
export async function callCapability({
  connectionId,
  capability,
  op,
  body,
  timeoutMs,
  env = process.env,
  fetcher = fetch
}: CapabilityCall): Promise<CapabilityResponse> {
  const response = await postCapability({
    connectionId,
    capability,
    op,
    body,
    env,
    fetcher,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
  const parsed = (await response.json().catch(() => null)) as unknown;
  return {
    ok: response.ok,
    status: response.status,
    body: parsed,
    ...(response.ok ? {} : { failure: parseFailure(parsed) })
  };
}

/**
 * Calls a streaming op and returns the raw `Response`, body unread: the caller reads the bytes (and
 * enforces its own idle deadline) and decides what a non-2xx answer means. `timeoutMs` bounds the
 * wait for the response to start, as `callCapability`'s does for the whole call. Throws like
 * `callCapability` when the sidecar is not set up.
 */
export async function streamCapability(call: CapabilityCall): Promise<Response> {
  return postCapability(call);
}

async function postCapability({
  connectionId,
  capability,
  op,
  body,
  timeoutMs,
  env = process.env,
  fetcher = fetch
}: CapabilityCall): Promise<Response> {
  const config = proxyConfig(env);
  if (!config) throw new ConnectionHostNotConfiguredError();
  return fetcher(`${config.url}${capabilityPath(capability, connectionId, op)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs ?? outboundRequestTimeoutMs(env))
  });
}
