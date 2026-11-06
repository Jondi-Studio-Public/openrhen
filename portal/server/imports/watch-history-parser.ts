import { createHash } from "node:crypto";
import JSZip from "jszip";
import { WATCH_IMPORT_MAX_FILE_BYTES } from "@openrhen/contracts";
import { assertZipEntryCount, readZipEntryCapped } from "@/features/imports/zip-limits";

/**
 * Reads a Google Takeout YouTube watch history (`history/watch-history.json`), bare or inside the Takeout zip.
 * Pure: bytes in, rows out, no database. JSON only; the export folder's name is localised, so the file is found
 * by its path suffix, never by an English folder name.
 *
 * Shapes handled (all seen in real exports):
 * - `time` with or without fractional seconds, `Z` or an offset. An entry without a usable time is skipped.
 * - Title `Watched <title>`: the prefix is stripped. A removed video reads `Watched https://www.youtube.com/watch?v=ID`
 *   with no subtitles; its title is kept null rather than the address.
 * - Ads: `details[].name` is `From Google Ads`. Posts and anything else whose address is not a video: kind `post`.
 * - `header: "YouTube Music"`: source `youtube_music_takeout`, which Review leaves out of watch totals.
 * - Shorts are indistinguishable from other watches in the export and count as watches.
 *
 * Times are floored to whole seconds, so the same watch exported with and without fractional seconds is one row.
 * `dupIndex` numbers repeats of the same video in the same second inside one file (0, 1, 2 ...), so a second import
 * of the same file is idempotent while two real same-second watches both survive.
 */

export type WatchSource = "youtube_takeout" | "youtube_music_takeout";
export type WatchKind = "watch" | "ad" | "post";

export interface ParsedWatchEvent {
  source: WatchSource;
  kind: WatchKind;
  videoId: string;
  watchedAt: Date;
  dupIndex: number;
  title: string | null;
  channel: string | null;
}

export interface ParsedWatchHistory {
  events: ParsedWatchEvent[];
  /** Entries left out for lacking a usable time, or not being an object. */
  skipped: number;
}

export class WatchHistoryParseError extends Error {}

const VIDEO_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{6,64}$/;
const ZIP_HISTORY_SUFFIX = "history/watch-history.json";

/** The video id in a watch, Shorts, embed or youtu.be address; null for anything else (a post, a channel, a search). */
export function videoIdFromUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!VIDEO_HOSTS.has(url.hostname.toLowerCase())) return null;
  const fromQuery = url.searchParams.get("v");
  if (url.hostname.toLowerCase() === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return id && VIDEO_ID.test(id) ? id : null;
  }
  if (url.pathname === "/watch") return fromQuery && VIDEO_ID.test(fromQuery) ? fromQuery : null;
  const match = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{6,64})\/?$/.exec(url.pathname);
  return match?.[1] ?? null;
}

/** A stable stand-in id for an entry with no video id, so `video_id` is never null and re-imports still match. */
export function syntheticVideoId(url: unknown, title: unknown): string {
  const text = `${typeof url === "string" ? url : ""}\n${typeof title === "string" ? title : ""}`;
  return `x:${createHash("sha256").update(text).digest("hex").slice(0, 24)}`;
}

/** Floors to whole seconds; null for a missing, unparseable or time-zone-less value. */
export function parseTakeoutTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  // Require a zone: a bare local time would be read in the server's zone and shift every row.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  // Date.parse rolls 2026-02-30 over to March; a real stamp reads back as the same calendar day.
  const [y, m, d] = [Number(text.slice(0, 4)), Number(text.slice(5, 7)), Number(text.slice(8, 10))];
  const day = new Date(Date.UTC(y, m - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return null;
  // YouTube began in 2005; a year past next year is a corrupt stamp, not a watch.
  if (y < 2005 || ms > Date.now() + 366 * 86_400_000) return null;
  return new Date(Math.floor(ms / 1000) * 1000);
}

function text(value: unknown): string | null {
  // Postgres text cannot hold NUL, so one in a title would fail the whole import.
  const clean = typeof value === "string" ? value.replaceAll("\u0000", "").trim() : "";
  return clean ? clean : null;
}

function isAd(entry: Record<string, unknown>): boolean {
  const details = entry.details;
  return (
    Array.isArray(details) &&
    details.some((item) => item && typeof item === "object" && (item as { name?: unknown }).name === "From Google Ads")
  );
}

function channelOf(entry: Record<string, unknown>): string | null {
  const subtitles = entry.subtitles;
  if (!Array.isArray(subtitles)) return null;
  for (const subtitle of subtitles) {
    const name = subtitle && typeof subtitle === "object" ? text((subtitle as { name?: unknown }).name) : null;
    if (name) return name;
  }
  return null;
}

export function parseWatchHistoryJson(source: string): ParsedWatchHistory {
  let value: unknown;
  try {
    value = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
  } catch {
    throw new WatchHistoryParseError("That file is not valid JSON. Request the Takeout in JSON format, not HTML.");
  }
  if (!Array.isArray(value))
    throw new WatchHistoryParseError("That JSON is not a watch history: expected a list of entries.");
  const events: ParsedWatchEvent[] = [];
  const seen = new Map<string, number>();
  let skipped = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      skipped += 1;
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const watchedAt = parseTakeoutTime(entry.time);
    if (!watchedAt) {
      skipped += 1;
      continue;
    }
    const music = typeof entry.header === "string" && entry.header.trim().toLowerCase() === "youtube music";
    const rawTitle = text(entry.title);
    const watched = rawTitle !== null && /^watched\s/i.test(rawTitle);
    const title = rawTitle === null ? null : rawTitle.replace(/^watched\s+/i, "").trim() || null;
    const id = videoIdFromUrl(entry.titleUrl);
    // A removed video's title is its own address; keeping that as a title would only repeat the link.
    const shownTitle = title !== null && /^https?:\/\//i.test(title) ? null : title;
    const kind: WatchKind = isAd(entry) ? "ad" : id !== null || (watched && !text(entry.titleUrl)) ? "watch" : "post";
    const videoId = id ?? syntheticVideoId(entry.titleUrl, rawTitle);
    const sourceName: WatchSource = music ? "youtube_music_takeout" : "youtube_takeout";
    const key = `${sourceName}\n${videoId}\n${watchedAt.getTime()}`;
    const dupIndex = seen.get(key) ?? 0;
    seen.set(key, dupIndex + 1);
    events.push({
      source: sourceName,
      kind,
      videoId,
      watchedAt,
      dupIndex,
      title: shownTitle,
      channel: channelOf(entry)
    });
  }
  return { events, skipped };
}

/** The history JSON inside a Takeout zip, by path suffix; a lone `watch-history.json` anywhere is the fallback. */
export async function readWatchHistoryZip(bytes: Uint8Array): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new WatchHistoryParseError("That file is not a readable zip.");
  }
  assertZipEntryCount(zip, "The Takeout zip");
  const files = Object.values(zip.files).filter((file) => !file.dir);
  const normal = (name: string) => name.replace(/\\/g, "/").toLowerCase();
  const bySuffix = files.filter((file) => {
    const name = normal(file.name);
    return name === ZIP_HISTORY_SUFFIX || name.endsWith(`/${ZIP_HISTORY_SUFFIX}`);
  });
  const candidates = bySuffix.length
    ? bySuffix
    : files.filter((file) => normal(file.name).split("/").pop() === "watch-history.json");
  if (candidates.length === 0)
    throw new WatchHistoryParseError(
      "No watch-history.json in that zip. In Takeout choose YouTube, then History, in JSON format."
    );
  if (candidates.length > 1)
    throw new WatchHistoryParseError("That zip holds more than one watch-history.json; import them one at a time.");
  const entry = await readZipEntryCapped(candidates[0]!, WATCH_IMPORT_MAX_FILE_BYTES, "The watch history");
  return new TextDecoder("utf-8").decode(entry);
}

/** A bare JSON file, or a zip (told by its `PK` signature, not the filename), parsed to rows. */
export async function parseWatchHistoryUpload(bytes: Uint8Array): Promise<ParsedWatchHistory> {
  if (bytes.byteLength > WATCH_IMPORT_MAX_FILE_BYTES && !(bytes[0] === 0x50 && bytes[1] === 0x4b))
    throw new WatchHistoryParseError("That file is too large. Export a shorter date range from Takeout.");
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const json = isZip ? await readWatchHistoryZip(bytes) : new TextDecoder("utf-8").decode(bytes);
  return parseWatchHistoryJson(json);
}
