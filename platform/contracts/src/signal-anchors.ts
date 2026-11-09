/**
 * Pure place maths: geohash-7 cells, anchor resolution and the sun. No I/O; every time is an argument.
 * Design 2.4 (position anchors, geohash edges, `isDay`) and 14 (precedence cond, then place, then cell).
 */
import type { Anchor } from "./signal-availability.js";

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
const EARTH_RADIUS_M = 6_371_008.8;
const METRES_PER_DEGREE = 111_320;

export interface GeohashBounds {
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
}

function validLatLng(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/** Standard geohash encoding; `precision` 7 is the cell of about 150 m. Null for a NaN or out-of-range lat or lng. */
export function geohashEncode(lat: number, lng: number, precision = 7): string | null {
  if (!validLatLng(lat, lng)) return null;
  let latLo = -90;
  let latHi = 90;
  let lngLo = -180;
  let lngHi = 180;
  let hash = "";
  let bit = 0;
  let ch = 0;
  let evenBit = true;
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) {
        ch = (ch << 1) | 1;
        lngLo = mid;
      } else {
        ch <<= 1;
        lngHi = mid;
      }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) {
        ch = (ch << 1) | 1;
        latLo = mid;
      } else {
        ch <<= 1;
        latHi = mid;
      }
    }
    evenBit = !evenBit;
    if (++bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

export function geohashBounds(hash: string): GeohashBounds {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let evenBit = true;
  for (const c of hash) {
    const idx = BASE32.indexOf(c);
    if (idx < 0) throw new Error(`Invalid geohash character "${c}".`);
    for (let n = 4; n >= 0; n--) {
      const bitN = (idx >> n) & 1;
      if (evenBit) {
        const mid = (lngMin + lngMax) / 2;
        if (bitN) lngMin = mid;
        else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bitN) latMin = mid;
        else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }
  return { latMin, latMax, lngMin, lngMax };
}

/** Great-circle distance in metres. */
export function distanceMetres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Metres from a point to the nearest edge of its own geohash cell. */
export function distanceToCellEdgeMetres(lat: number, lng: number, hash: string): number {
  const b = geohashBounds(hash);
  const toLat = Math.min(lat - b.latMin, b.latMax - lat) * METRES_PER_DEGREE;
  const toLng = Math.min(lng - b.lngMin, b.lngMax - lng) * METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
  return Math.max(0, Math.min(toLat, toLng));
}

/** A known place with a centre and radius: a `condition_definitions` row (`cond`) or a discovered place (`place`). */
export interface KnownPlace {
  anchor: Extract<Anchor, { t: "cond" | "place" }>;
  lat: number;
  lng: number;
  radiusM: number;
}

export interface PositionFix {
  lat: number;
  lng: number;
  /** Accuracy radius in metres (`attrs.acc_m`); 0 when unknown. */
  accM?: number;
}

export interface ResolvedAnchor {
  anchor: Anchor;
  /** The fix is within its accuracy of its cell's edge, so its cell is a weak claim. */
  nearCellEdge: boolean;
}

const PRECEDENCE: Readonly<Record<string, number>> = { cond: 0, place: 1 };

/**
 * Precedence is cond, then place, then cell. A known place that contains the fix's centre backs it, so a fix near a
 * cell edge still lands on the place that contains it; otherwise it backs the cell of its centre (flagged when that
 * cell edge is within the fix's accuracy). A fix with a NaN or out-of-range lat or lng has no anchor (null). Among places of one rank the nearest centre wins, then the lower id.
 */
export function resolveAnchor(fix: PositionFix, places: readonly KnownPlace[]): ResolvedAnchor | null {
  const gh7 = geohashEncode(fix.lat, fix.lng, 7);
  if (gh7 === null) return null;
  const nearCellEdge = distanceToCellEdgeMetres(fix.lat, fix.lng, gh7) <= Math.max(0, fix.accM ?? 0);
  const containing = places
    .map((p) => ({ p, d: distanceMetres(fix.lat, fix.lng, p.lat, p.lng) }))
    .filter((x) => x.d <= x.p.radiusM)
    .sort(
      (a, b) =>
        (PRECEDENCE[a.p.anchor.t] ?? 9) - (PRECEDENCE[b.p.anchor.t] ?? 9) ||
        a.d - b.d ||
        (a.p.anchor.id < b.p.anchor.id ? -1 : a.p.anchor.id > b.p.anchor.id ? 1 : 0)
    );
  const hit = containing[0];
  if (hit) return { anchor: hit.p.anchor, nearCellEdge };
  return { anchor: { t: "cell", gh7 }, nearCellEdge };
}

/** Solar elevation in degrees (NOAA low-precision formulas, good to about 0.01 degrees). */
export function solarElevationDeg(lat: number, lng: number, at: Date | number): number {
  const ms = at instanceof Date ? at.getTime() : at;
  const rad = Math.PI / 180;
  const n = ms / 86_400_000 + 2440587.5 - 2451545.0;
  const L = (((280.46 + 0.9856474 * n) % 360) + 360) % 360;
  const g = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmstDeg = ((((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24) * 15;
  const ha = (gmstDeg + lng) * rad - ra;
  const sinEl = Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha);
  return Math.asin(Math.max(-1, Math.min(1, sinEl))) / rad;
}

/** Daylight: the sun's centre above -0.833 degrees (sunrise and sunset, allowing for refraction and the disc). */
export function isDaylight(lat: number, lng: number, at: Date | number): boolean {
  return solarElevationDeg(lat, lng, at) > -0.833;
}
