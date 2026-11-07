import { eventKey } from "../keys.js";
import { readText } from "../chunks.js";
import { parseTimestamp } from "../time.js";
import { skip, type ActivityEventDraft, type ByteSource, type Stats } from "../types.js";

/**
 * Google Maps places from Takeout: GeoJSON `Saved Places.json` and `Labeled places.json`
 * (`{"features": [{geometry: {coordinates: [lng, lat]}, properties: {date?, Title|name, Location?}}]}`).
 * Each place is an instant `place` at the date the place was saved, with its name and rounded position in attrs.
 * A place with no date has no time to put it at, so it is skipped and counted: this importer never uses the
 * import time. These files are small (a few thousand places), so the document is parsed whole.
 */
export type PlaceList = "saved" | "labelled";

export async function* parseMapsPlaces(
  source: ByteSource,
  list: PlaceList,
  stats: Stats
): AsyncGenerator<ActivityEventDraft> {
  let document: unknown;
  try {
    document = JSON.parse(await readText(source));
  } catch {
    skip(stats, "file is not valid JSON");
    stats.read += 1;
    return;
  }
  const features = (document as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) {
    stats.read += 1;
    skip(stats, 'file has no "features" list');
    return;
  }
  for (const feature of features as unknown[]) {
    stats.read += 1;
    const record = feature as { geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> } | null;
    const properties = record?.properties;
    if (!properties || typeof properties !== "object") {
      skip(stats, "place has no properties");
      continue;
    }
    const time = parseTimestamp(properties.date ?? properties.Date, { utcOffsetIsUnknown: true });
    if (!time) {
      skip(stats, "place has no date, so it has no time to be placed at");
      continue;
    }
    const location = (properties.Location ?? properties.location ?? {}) as Record<string, unknown>;
    const nameValue = properties.Title ?? properties.name ?? location["Business Name"];
    const name = typeof nameValue === "string" ? nameValue.replace(/\s+/g, " ").trim() : "";
    if (!name) {
      skip(stats, "place has no name");
      continue;
    }
    const coordinates = record?.geometry?.coordinates;
    const geo = (location["Geo Coordinates"] ?? {}) as Record<string, unknown>;
    let lat = Array.isArray(coordinates) ? Number(coordinates[1]) : Number(geo.Latitude);
    let lng = Array.isArray(coordinates) ? Number(coordinates[0]) : Number(geo.Longitude);
    // Takeout writes 0,0 for a place with no position; that is "unknown", not a point in the Atlantic.
    const hasPosition =
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      !(lat === 0 && lng === 0) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180;
    if (!hasPosition) {
      lat = NaN;
      lng = NaN;
    }
    const attrs: Record<string, unknown> = { name, list };
    if (hasPosition) {
      attrs.lat = Math.round(lat * 1e5) / 1e5;
      attrs.lng = Math.round(lng * 1e5) / 1e5;
    }
    const url = properties["Google Maps URL"] ?? properties.google_maps_url;
    stats.emitted += 1;
    yield {
      id: eventKey(
        "maps-places",
        list,
        time.date.toISOString(),
        name,
        typeof url === "string" ? url : "",
        hasPosition ? `${lat},${lng}` : ""
      ),
      source: "maps-places",
      kind: "place",
      start: time.date.toISOString(),
      attrs
    };
  }
}
