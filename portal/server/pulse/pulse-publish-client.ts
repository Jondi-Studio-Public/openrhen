import {
  publicPulseV1Schema,
  resolveConnection,
  pulsePublishConfigResultSchema,
  pulsePublishResultSchema,
  type PublicPulseV1,
  type PulsePublishConfigResult,
  type PulsePublishResult
} from "@openrhen/contracts";
import { callCapability, ConnectionHostNotConfiguredError } from "@/integrations/connection-host-client";

/**
 * The portal's side of publishing the pulse:
 * `PULSE_PUBLISH_URL`/`PULSE_PUBLISH_SECRET` live only in the outbound proxy, so both the config
 * check and the publish call go through it, the same way `push-proxy-client.ts` and
 * `travel-proxy-client.ts` reach their own third-party credentials. The connection is whichever
 * one the registry says provides `status_publish`.
 */
export class PulseProxyUnavailableError extends Error {
  constructor(message = "The pulse tracker is not configured.") {
    super(message);
  }
}

async function call<T>(
  op: "config" | "publish",
  body: unknown,
  parse: (value: unknown) => T,
  env: Record<string, string | undefined>,
  fetcher: typeof fetch
): Promise<{ status: number; value: T | null; error?: string }> {
  let response;
  try {
    response = await callCapability({
      connectionId: resolveConnection("status_publish", op).id,
      capability: "status_publish",
      op,
      body,
      env,
      fetcher
    });
  } catch (error) {
    if (error instanceof ConnectionHostNotConfiguredError) throw new PulseProxyUnavailableError();
    throw error;
  }
  if (!response.ok)
    return {
      status: response.status,
      value: null,
      error: response.failure?.error ?? `The pulse tracker returned ${response.status}.`
    };
  return { status: response.status, value: parse(response.body) };
}

/** `GET /pulse/config`. `{ configured: false, host: null }` when the proxy itself is unreachable —
    the Settings page reads this the same way whether the proxy has no tracker set or is simply down. */
export async function fetchPulsePublishConfig(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch
): Promise<PulsePublishConfigResult> {
  try {
    const result = await call<PulsePublishConfigResult>(
      "config",
      {},
      (value) => pulsePublishConfigResultSchema.parse(value),
      env,
      fetcher
    );
    return result.value ?? { configured: false, host: null };
  } catch (error) {
    if (error instanceof PulseProxyUnavailableError) return { configured: false, host: null };
    throw error;
  }
}

/** `POST /pulse/publish`. A proxy the portal itself cannot reach (unconfigured `OUTBOUND_PROXY_URL`,
    or a network failure to it) is reported as `failed` rather than thrown, so the publisher's retry
    logic treats it the same as a tracker the proxy itself could not reach. */
export async function publishPulseViaProxy(
  pulse: PublicPulseV1,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch
): Promise<PulsePublishResult & { error?: string }> {
  // Validated once more here, defensively, the same belt-and-braces every other proxy client in this
  // codebase applies to its own upstream call — the proxy validates again regardless.
  const parsed = publicPulseV1Schema.safeParse(pulse);
  if (!parsed.success) return { outcome: "rejected" };
  try {
    const result = await call<PulsePublishResult>(
      "publish",
      parsed.data,
      (value) => pulsePublishResultSchema.parse(value),
      env,
      fetcher
    );
    if (result.error)
      return { outcome: "failed", ...(result.status ? { httpStatus: result.status } : {}), error: result.error };
    return result.value ?? { outcome: "failed" };
  } catch (error) {
    if (error instanceof PulseProxyUnavailableError) return { outcome: "failed", error: error.message };
    throw error;
  }
}
