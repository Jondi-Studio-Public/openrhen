import type { TransportMode } from "./context-model.js";

/**
 * A rough journey estimate from coordinates alone, for legs nobody has measured: the projection of a
 * day needs the time between two places you are not currently at, and the routing proxy only ever
 * measures from where you are. Straight-line distance at a flat speed per mode is deliberately crude
 * — it is a stand-in for a stored fallback, never a substitute for a measurement — so the constants
 * are exported and named rather than tuned.
 */
export const EARTH_RADIUS_KM = 6371;
/** Typical door-to-door speeds; car is low to absorb town streets and parking. */
export const TRAVEL_MODE_SPEED_KMH: Record<TransportMode, number> = { car: 40, bike: 15, walk: 5 };
/** Fixed minutes added per journey: finding keys, starting, parking. */
export const TRAVEL_MODE_OVERHEAD_MINUTES: Record<TransportMode, number> = { car: 5, bike: 0, walk: 0 };

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** Great-circle distance in kilometres. */
export function haversineKm(from: Coordinates, to: Coordinates): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(to.latitude - from.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Whole minutes for one journey by one mode. */
export function estimatedTravelMinutes(distanceKm: number, mode: TransportMode): number {
  return Math.round((distanceKm / TRAVEL_MODE_SPEED_KMH[mode]) * 60 + TRAVEL_MODE_OVERHEAD_MINUTES[mode]);
}

/**
 * The fastest of the available modes between two points, or undefined when no mode is available.
 * Ties go to the mode listed first in `modes`, so callers control preference by ordering.
 */
export function fastestEstimatedLeg(
  from: Coordinates,
  to: Coordinates,
  modes: readonly TransportMode[]
): { minutes: number; mode: TransportMode } | undefined {
  const distanceKm = haversineKm(from, to);
  let best: { minutes: number; mode: TransportMode } | undefined;
  for (const mode of modes) {
    const minutes = estimatedTravelMinutes(distanceKm, mode);
    if (!best || minutes < best.minutes) best = { minutes, mode };
  }
  return best;
}
