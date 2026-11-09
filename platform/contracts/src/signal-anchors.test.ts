import { describe, expect, it } from "vitest";
import {
  distanceMetres,
  distanceToCellEdgeMetres,
  geohashBounds,
  geohashEncode,
  isDaylight,
  resolveAnchor,
  solarElevationDeg,
  type KnownPlace
} from "./signal-anchors.js";

describe("geohash", () => {
  it("encodes the reference point", () => {
    expect(geohashEncode(57.64911, 10.40744, 7)).toBe("u4pruyd");
    expect(geohashEncode(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
  });

  it("bounds contain the point and are about 150 m across at precision 7", () => {
    const b = geohashBounds("u4pruyd");
    expect(57.64911).toBeGreaterThan(b.latMin);
    expect(57.64911).toBeLessThan(b.latMax);
    expect(10.40744).toBeGreaterThan(b.lngMin);
    expect(10.40744).toBeLessThan(b.lngMax);
    expect(distanceMetres(b.latMin, b.lngMin, b.latMin, b.lngMax)).toBeGreaterThan(50);
    expect(distanceMetres(b.latMin, b.lngMin, b.latMin, b.lngMax)).toBeLessThan(200);
    expect(() => geohashBounds("a")).toThrow();
  });

  it("measures the distance to the cell edge", () => {
    const b = geohashBounds("u4pruyd");
    const lat = (b.latMin + b.latMax) / 2;
    expect(distanceToCellEdgeMetres(lat, b.lngMin + 1e-9, "u4pruyd")).toBeLessThan(1);
    expect(distanceToCellEdgeMetres(lat, (b.lngMin + b.lngMax) / 2, "u4pruyd")).toBeGreaterThan(20);
  });
});

describe("invalid coordinates", () => {
  it("geohashEncode returns null and resolveAnchor returns no anchor, never throwing", () => {
    for (const [la, ln] of [
      [Number.NaN, 0],
      [0, Number.NaN],
      [91, 0],
      [-90.5, 0],
      [0, 180.1],
      [0, -181],
      [Infinity, 0]
    ] as const) {
      expect(geohashEncode(la, ln, 7)).toBeNull();
      expect(resolveAnchor({ lat: la, lng: ln }, [])).toBeNull();
    }
    expect(geohashEncode(90, 180, 7)).not.toBeNull();
    expect(geohashEncode(-90, -180, 7)).not.toBeNull();
  });
});

describe("resolveAnchor", () => {
  const lat = 51.5;
  const lng = -0.1;
  const home: KnownPlace = { anchor: { t: "cond", id: "home" }, lat, lng, radiusM: 100 };
  const shop: KnownPlace = { anchor: { t: "place", id: "p-shop" }, lat, lng, radiusM: 100 };

  it("backs the cell of its centre when no known place contains the fix", () => {
    const r = resolveAnchor({ lat: 52, lng: 0.5, accM: 5 }, [home])!;
    expect(r.anchor).toEqual({ t: "cell", gh7: geohashEncode(52, 0.5, 7) });
  });

  it("backs a known place that contains the centre, cond before place", () => {
    expect(resolveAnchor({ lat, lng }, [shop, home])!.anchor).toEqual({ t: "cond", id: "home" });
    expect(resolveAnchor({ lat, lng }, [shop])!.anchor).toEqual({ t: "place", id: "p-shop" });
  });

  it("a fix on a cell edge still lands on the place that contains it", () => {
    const b = geohashBounds(geohashEncode(lat, lng, 7)!);
    const edgeLng = b.lngMax - 1e-7;
    const place: KnownPlace = { anchor: { t: "cond", id: "edge" }, lat, lng: edgeLng + 0.0002, radiusM: 60 };
    const r = resolveAnchor({ lat, lng: edgeLng, accM: 30 }, [place])!;
    expect(r.anchor).toEqual({ t: "cond", id: "edge" });
    expect(r.nearCellEdge).toBe(true);
  });

  it("outside any place a fix within acc of an edge backs the cell of its centre and is flagged", () => {
    const b = geohashBounds(geohashEncode(lat, lng, 7)!);
    const edgeLng = b.lngMax - 1e-7;
    const r = resolveAnchor({ lat, lng: edgeLng, accM: 30 }, [])!;
    expect(r.anchor).toEqual({ t: "cell", gh7: geohashEncode(lat, edgeLng, 7) });
    expect(r.nearCellEdge).toBe(true);
    expect(resolveAnchor({ lat, lng: (b.lngMin + b.lngMax) / 2, accM: 3 }, [])!.nearCellEdge).toBe(false);
  });

  it("among places of one rank the nearest centre wins, then the lower id", () => {
    const near: KnownPlace = { anchor: { t: "cond", id: "z-near" }, lat, lng, radiusM: 500 };
    const far: KnownPlace = { anchor: { t: "cond", id: "a-far" }, lat: lat + 0.001, lng, radiusM: 500 };
    expect(resolveAnchor({ lat, lng }, [far, near])!.anchor).toEqual({ t: "cond", id: "z-near" });
    const twinA: KnownPlace = { anchor: { t: "cond", id: "a" }, lat, lng, radiusM: 50 };
    const twinB: KnownPlace = { anchor: { t: "cond", id: "b" }, lat, lng, radiusM: 50 };
    expect(resolveAnchor({ lat, lng }, [twinB, twinA])!.anchor).toEqual({ t: "cond", id: "a" });
  });
});

describe("the sun", () => {
  const at = (iso: string) => Date.parse(iso);
  it("London midsummer: day at noon, night at midnight", () => {
    expect(isDaylight(51.5, -0.1, at("2026-06-21T12:00:00Z"))).toBe(true);
    expect(isDaylight(51.5, -0.1, at("2026-06-21T00:00:00Z"))).toBe(false);
    expect(solarElevationDeg(51.5, -0.1, at("2026-06-21T12:00:00Z"))).toBeCloseTo(90 - 51.5 + 23.44, 0);
  });

  it("London midwinter noon is low, about 15 degrees", () => {
    expect(solarElevationDeg(51.5, -0.1, at("2026-12-21T12:00:00Z"))).toBeCloseTo(90 - 51.5 - 23.44, 0);
  });

  it("equator at the equinox is overhead at noon", () => {
    expect(solarElevationDeg(0, 0, at("2026-09-23T12:00:00Z"))).toBeGreaterThan(85);
  });

  it("Tromso has midnight sun in June and polar night in December", () => {
    expect(isDaylight(69.65, 18.96, at("2026-06-21T22:45:00Z"))).toBe(true);
    expect(isDaylight(69.65, 18.96, at("2026-12-21T11:00:00Z"))).toBe(false);
  });

  it("accepts a Date and is a pure function of its inputs", () => {
    const d = new Date("2026-03-20T06:00:00Z");
    expect(solarElevationDeg(10, 20, d)).toBe(solarElevationDeg(10, 20, d.getTime()));
  });
});
