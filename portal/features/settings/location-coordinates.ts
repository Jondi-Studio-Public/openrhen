/**
 * A place the system cannot point at cannot have its travel measured: the geocode lookup and every
 * live estimate key off a real latitude and longitude, and without them a location falls back to a
 * guessed number that never changes with the traffic or the direction you are coming from.
 *
 * So a new location has to say where it actually is. Places that predate the rule are only listed
 * for repair rather than blocked, because refusing to edit them would trap the very rows that need
 * fixing, and the stored field stays optional so those rows still parse.
 */

export const LOCATION_COORDINATES_REQUIRED =
  "Set the actual location (find the address or enter coordinates) — travel can't be measured without it.";

/** Structural on purpose: the client holds a draft of unknowns and the server holds parsed numbers. */
export interface CoordinateBearing {
  latitude?: number | null | undefined;
  longitude?: number | null | undefined;
}

export interface LocationCandidate extends CoordinateBearing {
  id: string;
  name: string;
  kind: string;
  status?: string | undefined;
}

/** Both or neither. Half a pair names no point on earth, so half a pair is no location at all. */
export function hasCoordinates(entry: CoordinateBearing): boolean {
  return (
    typeof entry.latitude === "number" &&
    Number.isFinite(entry.latitude) &&
    typeof entry.longitude === "number" &&
    Number.isFinite(entry.longitude)
  );
}

/**
 * The audit. Archived places are left out deliberately — nothing travels to them, so listing them
 * would only be a chore that never ends.
 */
export function locationsMissingCoordinates<T extends LocationCandidate>(definitions: readonly T[]): T[] {
  return definitions.filter(
    (entry) => entry.kind === "location" && entry.status !== "archived" && !hasCoordinates(entry)
  );
}

/**
 * The one rule both the editor and the command handler ask. `creating` is the whole distinction:
 * an existing coordinate-less location stays editable so it can be given coordinates at all.
 */
export function locationCoordinatesProblem(
  entry: CoordinateBearing & { kind?: unknown },
  creating: boolean
): string | null {
  if (!creating || entry.kind !== "location" || hasCoordinates(entry)) return null;
  return LOCATION_COORDINATES_REQUIRED;
}
