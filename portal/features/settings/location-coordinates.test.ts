import { describe, expect, it } from "vitest";
import {
  LOCATION_COORDINATES_REQUIRED,
  hasCoordinates,
  locationCoordinatesProblem,
  locationsMissingCoordinates
} from "@/features/settings/location-coordinates";

const place = (overrides: Record<string, unknown> = {}) => ({
  id: "harbor-mart",
  name: "Harbor Mart",
  kind: "location",
  status: "active",
  ...overrides
});

describe("hasCoordinates", () => {
  it("accepts a whole pair, including the zeroes that a truthiness test would drop", () => {
    expect(hasCoordinates({ latitude: -36.1, longitude: 146.9 })).toBe(true);
    expect(hasCoordinates({ latitude: 0, longitude: 0 })).toBe(true);
  });

  it("refuses half a pair, a missing pair, and anything that is not a finite number", () => {
    expect(hasCoordinates({ latitude: -36.1 })).toBe(false);
    expect(hasCoordinates({ longitude: 146.9 })).toBe(false);
    expect(hasCoordinates({})).toBe(false);
    expect(hasCoordinates({ latitude: null, longitude: null })).toBe(false);
    expect(hasCoordinates({ latitude: Number.NaN, longitude: 146.9 })).toBe(false);
  });
});

describe("locationsMissingCoordinates", () => {
  it("names only the active locations that have nowhere to be", () => {
    const missing = locationsMissingCoordinates([
      place({ id: "home", name: "Home", latitude: -36.1, longitude: 146.9 }),
      place({ id: "harbor-mart", name: "Harbor Mart" }),
      place({ id: "campus", name: "Campus", longitude: 146.9 }),
      place({ id: "desk", name: "Desk", kind: "capability" }),
      place({ id: "sam", name: "Sam", kind: "contact" })
    ]);
    expect(missing.map((entry) => entry.id)).toEqual(["harbor-mart", "campus"]);
  });

  it("leaves archived places out, because nothing travels to them", () => {
    expect(locationsMissingCoordinates([place({ status: "archived" })])).toEqual([]);
  });

  it("finds nothing when every place is placed", () => {
    expect(locationsMissingCoordinates([place({ latitude: 0, longitude: 0 })])).toEqual([]);
  });
});

describe("locationCoordinatesProblem", () => {
  it("refuses a new location that does not say where it is", () => {
    expect(locationCoordinatesProblem({ kind: "location" }, true)).toBe(LOCATION_COORDINATES_REQUIRED);
    expect(locationCoordinatesProblem({ kind: "location", latitude: -36.1 }, true)).toBe(LOCATION_COORDINATES_REQUIRED);
  });

  it("allows a new location that does", () => {
    expect(locationCoordinatesProblem({ kind: "location", latitude: -36.1, longitude: 146.9 }, true)).toBeNull();
  });

  it("never blocks an existing location, so a coordinate-less row can still be repaired", () => {
    expect(locationCoordinatesProblem({ kind: "location" }, false)).toBeNull();
  });

  it("says nothing about capabilities or contacts, which have nowhere to be", () => {
    expect(locationCoordinatesProblem({ kind: "capability" }, true)).toBeNull();
    expect(locationCoordinatesProblem({ kind: "contact" }, true)).toBeNull();
  });
});
