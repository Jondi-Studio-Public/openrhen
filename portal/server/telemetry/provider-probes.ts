import { outboundProxyConfig } from "@/server/runtime-env";
import { resolveConnection, sourceLabel } from "@openrhen/contracts";
import { callCapability, connectionHostConfigured } from "@/integrations/connection-host-client";
import { proveCalendarSource } from "@/integrations/calendar-source-client";
import type { CallOutcome } from "./provider-call-recorder";

/**
 * The actual network check behind each provider's active probe, used only when
 * `getProviderStatus` finds no recent evidence of reachability to judge by. Every probe goes through
 * the outbound-proxy sidecar like every other call, never straight from the portal — the sidecar
 * still holds the only copy of every third-party credential.
 *
 * None of these throw: a probe answering "unreachable" is a normal result, not a fault, so every path
 * here resolves to a `CallOutcome` and lets the caller decide what that means.
 */

/**
 * No sidecar means nothing to probe: the integration is not set up, which is a state rather than a
 * failure, so it is flagged and never recorded as a failed probe.
 */
const SIDECAR_NOT_SET_UP: CallOutcome = {
  ok: false,
  notConfigured: true,
  detail: "The outbound-proxy sidecar is not set up."
};

/** OpenAI's model listing costs no tokens, so this is free reachability proof, not a real call. */
export async function probeOpenAI(): Promise<CallOutcome> {
  if (!connectionHostConfigured()) return SIDECAR_NOT_SET_UP;
  try {
    const response = await callCapability({
      connectionId: resolveConnection("model_provider", "probe").id,
      capability: "model_provider",
      op: "probe",
      body: {}
    });
    if (response.ok) return { ok: true };
    const payload = response.body as { error?: string } | null;
    return { ok: false, detail: payload?.error ?? `OpenAI probe returned ${response.status}.` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "Could not reach the OpenAI proxy." };
  }
}

// Google Routes/Geocoding get no synthetic probe here: they publish no free health endpoint, and a
// fixed-address geocode would spend a real request purely to answer a health question. See
// `google-travel-probe.ts` — Google's active check is a real travel-matrix refresh, run only when a
// located, upcoming commitment's estimate has actually gone stale, or skipped otherwise.

/** Reuses the sidecar's connectivity proof for a calendar source rather than inventing a second check. */
export async function probeCalendarSource(id: string): Promise<CallOutcome> {
  const config = outboundProxyConfig();
  if (!config) return SIDECAR_NOT_SET_UP;
  // A passive probe: it must not count as a real call, or it would become the evidence it stands in for.
  const result = await proveCalendarSource(id, { record: false });
  if (result.status === "connected") return { ok: true };
  if (result.status === "not_configured")
    return {
      ok: false,
      notConfigured: true,
      detail: `${sourceLabel(id)} is not configured: ${result.missing.join(", ")}.`
    };
  return { ok: false, detail: result.message };
}
