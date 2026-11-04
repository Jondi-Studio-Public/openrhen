import { createHmac } from "node:crypto";
import { publicPulseV1Schema, type PublicPulseV1 } from "@openrhen/contracts";

// The schema's own inferred type, not `PublicPulseV1`, for whatever this module accepts from a
// `safeParse` result: `exactOptionalPropertyTypes` makes zod's `.optional()` output (which allows an
// explicit `undefined`) a stricter subtype than the hand-authored interface, so accepting either the
// interface or this shape here — rather than only the interface — is what keeps `parsed.data` (a
// validated wire body) assignable without a cast.
type PulsePublishBody = ReturnType<(typeof publicPulseV1Schema)["parse"]>;

/**
 * `POST /pulse/publish`'s implementation: the
 * tracker URL and signing secret live only in this process's environment, never the database or a
 * backup, and never reach the portal (the same separation as every other third-party credential
 * here). The body is validated against `publicPulseV1Schema` — the schema *from contracts* — before
 * anything is sent, so a caller cannot smuggle extra fields to the tracker through this route.
 */

export interface PulsePublishEnvConfig {
  url: string;
  secret: string;
  /** The tracker's own host, for display only ("Sending to <host>") — never the full URL, which may
      carry a path or query the person did not type. */
  host: string;
}

/** `PULSE_PUBLISH_URL`/`PULSE_PUBLISH_SECRET`. `undefined` when either is missing, blank, or the URL
    is not https (Decision "Publish": "`PULSE_PUBLISH_URL` must be https"). */
export function pulsePublishConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): PulsePublishEnvConfig | undefined {
  const url = env.PULSE_PUBLISH_URL?.trim();
  const secret = env.PULSE_PUBLISH_SECRET?.trim();
  if (!url || !secret) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  return { url, secret, host: parsed.host };
}

/**
 * The Stripe-style signature header value: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret,
 * "<t>.<body>")>` (Decision "Publish", Q4 — "the Stripe-style `t=` stops replay"). `body` is the exact
 * bytes sent, so a receiver hashes the same string it reads off the wire.
 */
export function signPulsePayload(secret: string, body: string, now: Date = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  const signed = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${signed}`;
}

/** The signature header receivers should read. */
export const PULSE_SIGNATURE_HEADER = "pulse-signature";
/**
 * The header receivers verified before the neutral name existed. It carries the same value and is sent beside the
 * new one so an existing receiver keeps verifying until it reads `pulse-signature`; delete it once none depends on it.
 */
export const LEGACY_PULSE_SIGNATURE_HEADER = "priorities-signature";

export type PulsePublishOutcome = "delivered" | "rejected" | "failed";

const PUBLISH_TIMEOUT_MS = 10_000;

/**
 * Signs and sends one `PublicPulseV1` object to the configured tracker. The caller (the route) has
 * already validated the body against `publicPulseV1Schema`; this function validates again
 * defensively, the same belt-and-braces the push route applies to its own allowlist check.
 */
export async function publishPulse(
  pulse: PublicPulseV1 | PulsePublishBody,
  config: PulsePublishEnvConfig,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<{ outcome: PulsePublishOutcome; httpStatus?: number }> {
  const parsed = publicPulseV1Schema.safeParse(pulse);
  if (!parsed.success) return { outcome: "rejected" };
  const body = JSON.stringify(parsed.data);
  const signature = signPulsePayload(config.secret, body, now);
  let response: Response;
  try {
    response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PULSE_SIGNATURE_HEADER]: signature,
        [LEGACY_PULSE_SIGNATURE_HEADER]: signature
      },
      body,
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS)
    });
  } catch {
    return { outcome: "failed" };
  }
  if (response.status >= 200 && response.status < 300) return { outcome: "delivered", httpStatus: response.status };
  if (response.status >= 400 && response.status < 500) return { outcome: "rejected", httpStatus: response.status };
  return { outcome: "failed", httpStatus: response.status };
}
