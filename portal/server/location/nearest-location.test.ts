import { describe, expect, it } from "vitest";
import { EARTH_RADIUS_KM } from "@openrhen/contracts";
import {
  LOCATION_MATCH_RADIUS_METERS,
  distanceMeters,
  matchNearestLocation,
  matchToleranceMeters,
  type LocationCandidate
} from "./nearest-location";

const home: LocationCandidate = { id: "home", name: "Home", latitude: -33.8688, longitude: 151.2093 };
/**
 * Metres per degree of latitude on the same sphere the matcher measures against, so a fixture placed
 * "600 m north" is exactly 600 m away and a test may assert a whole number rather than a range.
 */
const METRES_PER_DEGREE = (Math.PI * EARTH_RADIUS_KM * 1000) / 180;
const northOf = (base: LocationCandidate, metres: number, id: string): LocationCandidate => ({
  ...base,
  id,
  name: id,
  latitude: base.latitude + metres / METRES_PER_DEGREE
});
const reading = (candidate: LocationCandidate, accuracyMeters = 10, offsetMetres = 0) => ({
  latitude: candidate.latitude + offsetMetres / METRES_PER_DEGREE,
  longitude: candidate.longitude,
  accuracyMeters
});

describe("distanceMeters", () => {
  it("measures a short offset to within a metre", () => {
    expect(distanceMeters(home, northOf(home, 500, "far"))).toBeCloseTo(500, 0);
  });

  it("is zero at the same point", () => {
    expect(distanceMeters(home, home)).toBe(0);
  });
});

describe("matchToleranceMeters", () => {
  it("never narrows below the radius, however precise the device claims to be", () => {
    expect(matchToleranceMeters(3)).toBe(LOCATION_MATCH_RADIUS_METERS);
    expect(matchToleranceMeters(0)).toBe(LOCATION_MATCH_RADIUS_METERS);
  });

  it("widens to a sloppy reading's own accuracy", () => {
    expect(matchToleranceMeters(400)).toBe(400);
  });
});

describe("matchNearestLocation", () => {
  it("matches the one place inside the tolerance and reports the distance", () => {
    const match = matchNearestLocation(reading(home, 10, 40), [home, northOf(home, 5000, "beach")]);
    expect(match.kind).toBe("matched");
    if (match.kind !== "matched") return;
    expect(match.location.locationId).toBe("home");
    expect(match.location.distanceMeters).toBe(40);
    expect(match.toleranceMeters).toBe(LOCATION_MATCH_RADIUS_METERS);
  });

  it("calls two places inside the tolerance ambiguous rather than picking the nearer one", () => {
    const studio = northOf(home, 60, "studio");
    const match = matchNearestLocation(reading(home), [home, studio]);
    expect(match.kind).toBe("ambiguous");
    if (match.kind !== "ambiguous") return;
    // Nearest first, so an interface listing the candidates offers the likeliest one first.
    expect(match.candidates.map((candidate) => candidate.locationId)).toEqual(["home", "studio"]);
  });

  it("matches nothing when every place is beyond the tolerance, and names the nearest", () => {
    const match = matchNearestLocation(reading(home, 10, 900), [home, northOf(home, 5000, "beach")]);
    expect(match.kind).toBe("none");
    if (match.kind !== "none") return;
    expect(match.nearest?.locationId).toBe("home");
    expect(match.nearest?.distanceMeters).toBe(900);
  });

  it("matches nothing at all when no place has coordinates", () => {
    expect(matchNearestLocation(reading(home), [])).toEqual({
      kind: "none",
      toleranceMeters: LOCATION_MATCH_RADIUS_METERS,
      nearest: null
    });
  });

  it("lets a poor fix reach a place the fixed radius would have missed", () => {
    const distant = reading(home, 500, 300);
    expect(matchNearestLocation(distant, [home]).kind).toBe("matched");
    expect(matchNearestLocation({ ...distant, accuracyMeters: 10 }, [home]).kind).toBe("none");
  });

  it("turns a fix so vague that it covers several places into ambiguity, not a guess", () => {
    const places = [home, northOf(home, 900, "studio")];
    expect(matchNearestLocation(reading(home, 2000), places).kind).toBe("ambiguous");
  });

  it("counts a place exactly on the tolerance as inside it", () => {
    const match = matchNearestLocation(reading(home, 10, LOCATION_MATCH_RADIUS_METERS), [home]);
    expect(match.kind).toBe("matched");
  });
});
