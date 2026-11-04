import {
  pushSendResultSchema,
  pushVapidPublicKeyResultSchema,
  type PushSendRequest,
  type PushSendResult,
  type PushVapidPublicKeyResult
} from "@openrhen/contracts";
import { outboundRequestTimeoutMs } from "@/server/runtime-env";

/**
 * The portal's side of Web Push send:
 * the VAPID keys live only in the outbound proxy, so every send and the public-key fetch go through
 * it, the same way travel and the calendar provider calls do (`travel-proxy-client.ts`).
 */
function proxyConfig(env: Record<string, string | undefined> = process.env) {
  const url = env.OUTBOUND_PROXY_URL?.trim();
  const token = env.OUTBOUND_PROXY_TOKEN?.trim();
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

export class PushProxyUnavailableError extends Error {
  constructor(message = "The push service is not configured.") {
    super(message);
  }
}

export async function callPushProxy<T>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  parse: (value: unknown) => T,
  env: Record<string, string | undefined>,
  fetcher: typeof fetch
): Promise<{ status: number; value: T | null; error?: string }> {
  const config = proxyConfig(env);
  if (!config) throw new PushProxyUnavailableError();
  const response = await fetcher(`${config.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(outboundRequestTimeoutMs(env))
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `The push service returned ${response.status}.`;
    return { status: response.status, value: null, error };
  }
  return { status: response.status, value: parse(payload) };
}

/** `GET /push/vapid-public-key`. Returns `null` when the proxy has no keys configured (503). */
export async function fetchVapidPublicKey(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch
): Promise<string | null> {
  try {
    const result = await callPushProxy<PushVapidPublicKeyResult>(
      "GET",
      "/push/vapid-public-key",
      undefined,
      (value) => pushVapidPublicKeyResultSchema.parse(value),
      env,
      fetcher
    );
    return result.value?.publicKey ?? null;
  } catch (error) {
    if (error instanceof PushProxyUnavailableError) return null;
    throw error;
  }
}

/** `POST /push/send`. */
export async function sendPushViaProxy(
  request: PushSendRequest,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch
): Promise<PushSendResult> {
  const result = await callPushProxy<PushSendResult>(
    "POST",
    "/push/send",
    request,
    // A 2xx whose body we cannot read means the proxy took the send: report it delivered rather than
    // throw, because a throw makes the drain retry and the owner would be pushed twice.
    (value) => {
      const parsed = pushSendResultSchema.safeParse(value);
      return parsed.success ? parsed.data : { outcome: "delivered" };
    },
    env,
    fetcher
  );
  return result.value ?? { outcome: "failed" };
}
