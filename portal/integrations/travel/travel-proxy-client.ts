import {
  geocodeResultSchema,
  resolveConnection,
  travelMatrixResultSchema,
  type GeocodeResult,
  type TravelMatrixRequest,
  type TravelMatrixResult
} from "@openrhen/contracts";
import { recordProviderCall } from "@/server/telemetry/provider-call-recorder";
import { callCapability, ConnectionHostNotConfiguredError } from "@/integrations/connection-host-client";

/**
 * Travel lookups go through the same sidecar as the calendar sources, for the same reason: GOOGLE_MAPS_API_KEY
 * lives only in that process. The portal is the container exposed on the LAN, so it holds no
 * third-party credentials at all. The connection is whichever one the registry says provides the
 * capability.
 */
async function post<T>(
  capability: "travel_time" | "geocoding",
  op: "matrix" | "geocode",
  body: unknown,
  parse: (value: unknown) => T,
  env: Record<string, string | undefined>,
  fetcher: typeof fetch
): Promise<T> {
  let result;
  try {
    result = await callCapability({
      connectionId: resolveConnection(capability, op).id,
      capability,
      op,
      body,
      env,
      fetcher
    });
  } catch (error) {
    if (error instanceof ConnectionHostNotConfiguredError)
      throw new Error("The integrations sidecar is not configured: OUTBOUND_PROXY_URL, OUTBOUND_PROXY_TOKEN.");
    throw error;
  }
  if (!result.ok) throw new Error(result.failure?.error ?? `The travel service returned ${result.status}.`);
  return parse(result.body);
}

export function fetchTravelMatrix(
  request: TravelMatrixRequest,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch
): Promise<TravelMatrixResult> {
  return recordProviderCall("google", "travel_matrix", () =>
    post("travel_time", "matrix", request, (value) => travelMatrixResultSchema.parse(value), env, fetcher)
  );
}

export function geocodeQuery(
  query: string,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch
): Promise<GeocodeResult> {
  return recordProviderCall("google", "geocode", () =>
    post("geocoding", "geocode", { query }, (value) => geocodeResultSchema.parse(value), env, fetcher)
  );
}
