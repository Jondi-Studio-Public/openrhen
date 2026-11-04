// Time zones for the calendar feed parser: which TZID spellings we trust, and local wall time to instant.
// Rule (design v4 (d)): a TZID is accepted only as an exact-case IANA name or `UTC` that `Intl` accepts, else a
// Windows name from the CLDR table. Offsets (`+05:00`), abbreviations (`EST`) and lowercase are unknown.
import { WINDOWS_ZONES } from "./windows-zones.js";

const IANA_SHAPE = /^(?:UTC|GMT|[A-Z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2})$/;
const formatters = new Map<string, Intl.DateTimeFormat | null>();
const zoneCache = new Map<string, string | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  if (formatters.has(zone)) return formatters.get(zone) ?? null;
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
    });
  } catch {
    formatter = null;
  }
  formatters.set(zone, formatter);
  return formatter;
}

/**
 * True when `Intl` knows this exact-case IANA name. `Intl` matches names case-insensitively, so a spelling whose
 * canonical form differs only by case (`europe/london`, `EUROPE/LONDON`) is refused. A link name (`Asia/Calcutta`)
 * resolves to a different canonical name and is accepted as spelled.
 */
export function isIanaZone(zone: string): boolean {
  if (!IANA_SHAPE.test(zone) || !formatterFor(zone)) return false;
  const canonical = formatterFor(zone)?.resolvedOptions().timeZone ?? "";
  return canonical.toLowerCase() !== zone.toLowerCase() || canonical === zone;
}

/** Resolve a TZID to an IANA id, or null when unknown. */
export function resolveZone(
  raw: string | undefined | null,
  vtimezoneLocations?: ReadonlyMap<string, string>
): string | null {
  if (raw === undefined || raw === null) return null;
  const tzid = raw.trim();
  if (!tzid) return null;
  if (zoneCache.has(tzid)) return zoneCache.get(tzid) ?? null;
  let resolved: string | null = null;
  if (isIanaZone(tzid)) resolved = tzid;
  else if (Object.hasOwn(WINDOWS_ZONES, tzid)) resolved = WINDOWS_ZONES[tzid] ?? null;
  else {
    // Mozilla/Lotus style `/mozilla.org/20050126_1/Europe/London`: the IANA name is the tail after the version folder.
    const olson = /^\/[^/]+\/[^/]+\/(.+)$/.exec(tzid);
    if (olson?.[1] && isIanaZone(olson[1])) resolved = olson[1];
    else {
      const location = vtimezoneLocations?.get(tzid);
      if (location && isIanaZone(location)) resolved = location;
    }
  }
  zoneCache.set(tzid, resolved);
  return resolved;
}

/** Offset of `zone` from UTC in milliseconds at the instant `utcMs`. */
export function offsetAt(zone: string, utcMs: number): number {
  const formatter = formatterFor(zone);
  if (!formatter) throw new Error("unknown zone");
  const parts = formatter.formatToParts(new Date(utcMs));
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second")
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export interface LocalDateTime {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** Local wall time in `zone` to a UTC instant (ms). A time in a DST gap moves forward; one that happens twice takes the earlier instant. */
export function localToInstant(zone: string, t: LocalDateTime): number {
  const wall = Date.UTC(t.y, t.m - 1, t.d, t.h, t.mi, t.s);
  if (zone === "UTC") return wall;
  const before = offsetAt(zone, wall - 86_400_000);
  const after = offsetAt(zone, wall + 86_400_000);
  const candidates = new Set([before, after]);
  const valid: number[] = [];
  for (const offset of candidates) {
    const instant = wall - offset;
    if (offsetAt(zone, instant) === offset) valid.push(instant);
  }
  if (valid.length > 0) return Math.min(...valid);
  // A gap: the wall time never happened. Reading it with the offset from before the gap moves it forward.
  return wall - before;
}

/** UTC instant (ms) to the local calendar fields in `zone`. */
export function instantToLocal(zone: string, utcMs: number): LocalDateTime {
  const shifted = new Date(utcMs + (zone === "UTC" ? 0 : offsetAt(zone, utcMs)));
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
    mi: shifted.getUTCMinutes(),
    s: shifted.getUTCSeconds()
  };
}
