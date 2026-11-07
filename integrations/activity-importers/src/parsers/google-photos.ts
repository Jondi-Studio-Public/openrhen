import { readText } from "../chunks.js";
import { eventKey } from "../keys.js";
import { fromEpochSeconds } from "../time.js";
import { skip, type ActivityEventDraft, type ByteSource, type Stats } from "../types.js";

/**
 * Google Photos metadata from Takeout, UNVERIFIED against a real export. Only the small `.json` sidecar that sits
 * next to each photo or video is read, e.g. `IMG_1234.jpg.json` (newer exports: `IMG_1234.jpg.supplemental-metadata.json`,
 * sometimes cut short). The photo or video file itself is never opened: the planner does not even list it for this
 * importer. A sidecar is `{title, description?, creationTime: {timestamp}, photoTakenTime: {timestamp}, geoData:
 * {latitude, longitude}, ...}` with epoch SECONDS as text. One event per media item: kind `photo` or `video` from
 * the media file's extension in the sidecar's name, at `photoTakenTime`. Without it the item is skipped (the upload
 * time, `creationTime`, is not when it happened); it is kept in attrs. The file name and description are content;
 * the position is rounded in attrs and 0,0 means none. The key is built from the sidecar's stable fields, so the
 * same item listed in an album and in "Photos from <year>" is one event.
 */
const MEDIA = /\.([a-z0-9]{2,5})(?:\(\d+\))?(?:\.[a-z-]{0,30})?(?:\(\d+\))?\.json$/i;
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "avi", "3gp", "mkv", "webm", "mpg", "mpeg", "wmv", "mts"]);
const PHOTO_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "heic",
  "heif",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "dng",
  "raw",
  "arw",
  "cr2",
  "nef"
]);

/** True for a name that looks like a media item's sidecar (not an album's `metadata.json`). */
export function isPhotoSidecarName(basename: string): boolean {
  const ext = MEDIA.exec(basename)?.[1]?.toLowerCase();
  return !!ext && (VIDEO_EXTENSIONS.has(ext) || PHOTO_EXTENSIONS.has(ext));
}

export function photoKindOf(basename: string): "photo" | "video" | null {
  const ext = MEDIA.exec(basename)?.[1]?.toLowerCase();
  if (!ext) return null;
  return VIDEO_EXTENSIONS.has(ext) ? "video" : PHOTO_EXTENSIONS.has(ext) ? "photo" : null;
}

const MAX_SIDECAR_CHARS = 1024 * 1024;

const stamp = (value: unknown): unknown =>
  value !== null && typeof value === "object" ? (value as { timestamp?: unknown }).timestamp : undefined;

function position(value: unknown): { lat: number; lng: number } | null {
  if (value === null || typeof value !== "object") return null;
  const { latitude, longitude } = value as { latitude?: unknown; longitude?: unknown };
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude === 0 && longitude === 0) return null;
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { lat: latitude, lng: longitude } : null;
}

export async function* parseGooglePhotosSidecar(
  source: ByteSource,
  basename: string,
  stats: Stats,
  now: Date = new Date()
): AsyncGenerator<ActivityEventDraft> {
  stats.read += 1;
  const kind = photoKindOf(basename);
  if (!kind) {
    skip(stats, "sidecar name does not say a known photo or video type");
    return;
  }
  let document: unknown;
  try {
    document = JSON.parse(await readText(source, MAX_SIDECAR_CHARS));
  } catch {
    skip(stats, "sidecar is not valid JSON (or is far larger than a sidecar)");
    return;
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    skip(stats, "sidecar is not a JSON object");
    return;
  }
  const record = document as Record<string, unknown>;
  const taken = fromEpochSeconds(stamp(record.photoTakenTime), now);
  if (!taken) {
    skip(stats, "photoTakenTime.timestamp is missing or is not epoch seconds");
    return;
  }
  const created = fromEpochSeconds(stamp(record.creationTime), now);
  const title = typeof record.title === "string" ? record.title.replace(/\s+/g, " ").trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  // The item's own link tells two files that share a name and times apart, and is the same for its album and year copies.
  const url = typeof record.url === "string" && record.url.length <= 500 ? record.url.trim() : "";
  const geo = position(record.geoData) ?? position(record.geoDataExif);
  const attrs: Record<string, unknown> = {};
  if (geo) {
    attrs.lat = Math.round(geo.lat * 1e5) / 1e5;
    attrs.lng = Math.round(geo.lng * 1e5) / 1e5;
  }
  if (created) attrs.uploaded_at = created.toISOString();
  const content = [title, description].filter((part) => part !== "").join("\n");
  stats.emitted += 1;
  yield {
    id: eventKey(
      "google-photos",
      kind,
      stamp(record.photoTakenTime) as string | number,
      title,
      created ? created.getTime() : "",
      ...(url ? [url] : [])
    ),
    source: "google-photos",
    kind,
    start: taken.toISOString(),
    attrs,
    ...(content ? { content } : {})
  };
}
