import type {
  GeocodeResult,
  GeographicPoint,
  TransportMode,
  TravelMatrixRequest,
  TravelMatrixResult
} from "@openrhen/contracts";

const ROUTES_ENDPOINT = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";

/** Routes calls one mode at a time, so each mode is a separate matrix over the same destinations. */
const travelModes: Record<TransportMode, string> = { car: "DRIVE", bike: "BICYCLE", walk: "WALK" };

export function googleMapsKeyFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const key = env.GOOGLE_MAPS_API_KEY?.trim();
  return key ? key : undefined;
}

interface MatrixElement {
  originIndex?: number;
  destinationIndex?: number;
  duration?: string;
  condition?: string;
  status?: { code?: number };
}

/**
 * The quickest way to each destination, across only the modes asked for.
 *
 * Destinations the provider cannot route to are reported separately rather than dropped, because a
 * silently missing place is indistinguishable from one you simply cannot reach — and the second is a
 * planning decision while the first is a bug.
 */
export async function computeTravelMatrix(
  request: TravelMatrixRequest,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<TravelMatrixResult> {
  const best = new Map<string, { minutes: number; mode: TransportMode }>();
  const measurements: { locationId: string; mode: TransportMode; minutes: number }[] = [];
  const attempted = new Set<string>();

  for (const mode of request.modes) {
    // Traffic-aware routing is only meaningful for driving; bike and walk times do not move with
    // traffic, so they are never asked for it even when a departure time is given.
    const trafficAware = mode === "car" && request.departureAt !== undefined;
    const response = await fetchImpl(ROUTES_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": apiKey,
        // Routes requires an explicit field mask; asking for everything is refused.
        "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition"
      },
      body: JSON.stringify({
        origins: [{ waypoint: { location: { latLng: point(request.origin) } } }],
        destinations: request.destinations.map((destination) => ({
          waypoint: { location: { latLng: point(destination) } }
        })),
        travelMode: travelModes[mode],
        ...(trafficAware ? { routingPreference: "TRAFFIC_AWARE", departureTime: request.departureAt } : {})
      })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // The key itself must never reach a log or an error surfaced to the browser.
      throw new Error(
        `Routes request for ${mode} failed with ${response.status}: ${redact(detail, apiKey).slice(0, 300)}`
      );
    }
    const elements = (await response.json()) as MatrixElement[];
    for (const element of Array.isArray(elements) ? elements : []) {
      const destination = request.destinations[element.destinationIndex ?? -1];
      if (!destination) continue;
      attempted.add(destination.locationId);
      if (element.condition !== "ROUTE_EXISTS" || !element.duration) continue;
      const minutes = Math.round(seconds(element.duration) / 60);
      measurements.push({ locationId: destination.locationId, mode, minutes });
      const current = best.get(destination.locationId);
      if (!current || minutes < current.minutes) best.set(destination.locationId, { minutes, mode });
    }
  }

  return {
    estimates: [...best].map(([locationId, entry]) => ({ locationId, ...entry })),
    measurements,
    unroutable: [...attempted].filter((locationId) => !best.has(locationId)).sort()
  };
}

/** Turns a place the person typed into coordinates, so nobody has to enter latitude by hand. */
export async function geocodePlace(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<GeocodeResult> {
  const url = new URL(GEOCODE_ENDPOINT);
  url.searchParams.set("address", query);
  url.searchParams.set("key", apiKey);
  const response = await fetchImpl(url.toString(), { method: "GET" });
  if (!response.ok) throw new Error(`Geocoding failed with ${response.status}.`);
  const body = (await response.json()) as {
    status?: string;
    error_message?: string;
    results?: { formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } } }[];
  };
  // Geocoding answers 200 with a status field, so a refusal looks like success unless it is read.
  // Its own message names the cause — usually that the key is restricted away from this API — which
  // is far more use than the bare status code.
  if (body.status === "REQUEST_DENIED") {
    throw new Error(
      `Geocoding was refused: ${body.error_message ?? "the key is not authorised for the Geocoding API."} Enable Geocoding for this key, or set the coordinates by hand.`
    );
  }
  if (body.status && body.status !== "OK" && body.status !== "ZERO_RESULTS")
    throw new Error(`Geocoding returned ${body.status}.`);
  const matches = (body.results ?? [])
    .map((result) => ({
      label: result.formatted_address ?? query,
      latitude: result.geometry?.location?.lat,
      longitude: result.geometry?.location?.lng
    }))
    .filter(
      (match): match is { label: string; latitude: number; longitude: number } =>
        typeof match.latitude === "number" && typeof match.longitude === "number"
    )
    .slice(0, 5);
  return { matches };
}

const point = (value: GeographicPoint) => ({ latitude: value.latitude, longitude: value.longitude });
/** Durations arrive as a protobuf duration string such as "832s". */
const seconds = (duration: string) => Number(duration.replace(/s$/, "")) || 0;
const redact = (text: string, apiKey: string) => (apiKey ? text.split(apiKey).join("[key]") : text);
