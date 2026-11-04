import { withRoute } from "@/server/logging";
import {
  getProviderStatus,
  KNOWN_PROVIDERS,
  pruneOldProviderTelemetry,
  type ProviderName,
  type ReachabilityCheck
} from "@/server/telemetry/provider-call-recorder";
import { calendarSourceConnections } from "@openrhen/contracts";
import { probeCalendarSource, probeOpenAI } from "@/server/telemetry/provider-probes";
import { checkGoogleReachability } from "@/server/telemetry/google-travel-probe";

const checks: Partial<Record<ProviderName, ReachabilityCheck>> = {
  openai: { kind: "probe", run: probeOpenAI },
  // Google gets no synthetic probe: its active check is a real travel-matrix refresh (or a
  // "nothing to refresh" skip), already recorded by the call it makes — see google-travel-probe.ts.
  google: { kind: "self_recording", run: checkGoogleReachability },
  // Every calendar source is probed through the connection host's passive proof.
  ...Object.fromEntries(
    calendarSourceConnections().map((manifest) => [
      manifest.telemetryName ?? manifest.id,
      { kind: "probe", run: () => probeCalendarSource(manifest.id) }
    ])
  )
};

function isKnownProvider(value: string): value is ProviderName {
  return (KNOWN_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Reachability and latency status for every provider the Connections page shows a card for, or just
 * one via `?provider=`. Reads the recorded telemetry passively and probes live only when nothing
 * recent settles the question — see `getProviderStatus` — so this route is safe to call on every page
 * load and on every "check now" click alike; the rate limit lives in the recorder, not here.
 *
 * Also prunes `provider_call_telemetry` past its retention window before reading, so a page opened
 * moments after the worker's hourly `pruneExpiredProviderTelemetry` run still sees a bounded table.
 * The worker owns retention; this call is a belt-and-braces duplicate of the same query, once
 * per request rather than once per provider.
 *
 * `POST`, not `GET`: a "check now" click can dispatch a live probe or, for Google, trigger a real
 * travel-matrix refresh that bills the provider — a side effect a prefetching browser or crawler can
 * trigger just by following a link. `GET`/`HEAD`/`OPTIONS` are also the only methods `withRoute`'s CSRF
 * guard exempts (see `crossSiteRefusal` in `server/logging.ts`), which made this the one mutating route
 * left outside it. `POST` closes both problems at once.
 */
export const POST = withRoute("/api/connections/status", async (request) => {
  const url = new URL(request.url);
  const requested = url.searchParams.get("provider");
  if (requested && !isKnownProvider(requested)) {
    return Response.json({ error: `Unknown provider: ${requested}.` }, { status: 400 });
  }
  await pruneOldProviderTelemetry();
  const providers = requested && isKnownProvider(requested) ? [requested] : KNOWN_PROVIDERS;
  const statuses = await Promise.all(
    providers.map((provider) => {
      const check = Object.hasOwn(checks, provider) ? checks[provider] : undefined;
      // A telemetry name with no check is a wiring gap: say so instead of dropping the provider.
      if (!check) throw new Error(`No reachability check for provider ${provider}.`);
      return getProviderStatus(provider, check);
    })
  );
  return Response.json({ providers: statuses });
});

export const GET = withRoute("/api/connections/status", async (request: Request) => {
  void request;
  return Response.json({ error: "Use POST." }, { status: 405, headers: { Allow: "POST" } });
});
