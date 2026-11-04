import { haversineKm, type Coordinates } from "@openrhen/contracts";

/**
 * Turning a coordinate reading into "which saved place is this?".
 *
 * The answer is deliberately three-valued. One place inside the tolerance is a match; two or more is
 * ambiguous and nothing may be concluded from it; none means the person is somewhere the system has
 * never been told about. Collapsing ambiguity into "the nearest one" is how a portal ends up
 * confidently asserting the wrong room of a house whose study and kitchen were saved separately.
 */

/**
 * How far a reading may sit from a saved place and still be taken as being there. Generous on
 * purpose: a saved place is a single point but the place itself is a building and its car park, and
 * a consumer GPS fix indoors drifts further than the width of the building it is inside.
 */
export const LOCATION_MATCH_RADIUS_METERS = 150;

export interface LocationCandidate extends Coordinates {
  id: string;
  name: string;
}

export interface NearbyLocation {
  locationId: string;
  locationName: string;
  /** Whole metres, rounded: nothing downstream is more precise than the fix that produced it. */
  distanceMeters: number;
}

export type LocationMatch =
  | { kind: "matched"; toleranceMeters: number; location: NearbyLocation }
  | { kind: "ambiguous"; toleranceMeters: number; candidates: NearbyLocation[] }
  | { kind: "none"; toleranceMeters: number; nearest: NearbyLocation | null };

/**
 * A reading may not be treated as more precise than the device claims it is, so a sloppy fix widens
 * the tolerance rather than being judged against the fixed radius. It is never narrowed below the
 * radius: a phone reporting three-metre accuracy is still standing in a building, not on a point.
 *
 * Nothing caps how far accuracy may widen this. A fix so vague that it covers several saved places
 * lands on `ambiguous` by itself. One so vague that it covers exactly one place is still a match
 * here, but `observation-policy.ts` refuses to let a fix coarser than `MAX_ASSERTING_ACCURACY_METERS`
 * refresh the assertion or count towards sustained presence.
 */
export function matchToleranceMeters(accuracyMeters: number): number {
  return Math.max(LOCATION_MATCH_RADIUS_METERS, accuracyMeters);
}

export function distanceMeters(from: Coordinates, to: Coordinates): number {
  return haversineKm(from, to) * 1000;
}

/**
 * Matches one reading against the places that have coordinates. Candidates without coordinates are
 * the caller's problem to filter — a place with no point cannot be near anything.
 */
export function matchNearestLocation(
  observation: Coordinates & { accuracyMeters: number },
  candidates: readonly LocationCandidate[]
): LocationMatch {
  const toleranceMeters = matchToleranceMeters(observation.accuracyMeters);
  const ranked = candidates
    .map((candidate) => ({
      locationId: candidate.id,
      locationName: candidate.name,
      distanceMeters: Math.round(distanceMeters(observation, candidate))
    }))
    .sort((left, right) => left.distanceMeters - right.distanceMeters);
  const within = ranked.filter((entry) => entry.distanceMeters <= toleranceMeters);
  if (within.length === 1) return { kind: "matched", toleranceMeters, location: within[0]! };
  if (within.length > 1) return { kind: "ambiguous", toleranceMeters, candidates: within };
  return { kind: "none", toleranceMeters, nearest: ranked[0] ?? null };
}
