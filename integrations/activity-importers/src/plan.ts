import { archiveHasher, openArchive, sourceSha256, type Archive } from "./archive.js";
import { parseAccessLogCsv, parseAccessLogJson } from "./parsers/access-log.js";
import { parseAppleHealth } from "./parsers/apple-health.js";
import { parseChromeHistory } from "./parsers/chrome.js";
import { channelIdFromFolder, parseDiscordMessagesCsv, parseDiscordMessagesJson } from "./parsers/discord.js";
import { parseFitMetrics } from "./parsers/fit.js";
import { parseGoogleActivity } from "./parsers/google-activity.js";
import { chatSpaceId, parseChatOwner, parseGoogleChatMessages } from "./parsers/google-chat.js";
import { isPhotoSidecarName, parseGooglePhotosSidecar } from "./parsers/google-photos.js";
import { parseMapsPlaces } from "./parsers/maps.js";
import { parseSpotifyHistory } from "./parsers/spotify.js";
import { parseTimeline } from "./parsers/timeline.js";
import { ImportReadError, newStats, skip, type ActivityEventDraft, type Stats } from "./types.js";

/**
 * Turns "this source, this path" into the work to do: one `EventJob` per source of the activity store found, plus a
 * `YoutubeJob` when a Takeout holds a YouTube watch history (that goes to the existing watch-history route and is
 * never parsed here). Nothing is read until a job's `events()` is iterated, and every job counts what it skipped.
 */
export const IMPORT_SOURCES = [
  "takeout",
  "chrome",
  "google-activity",
  "maps",
  "fit",
  "timeline",
  "google-chat",
  "access-log",
  "google-photos",
  "youtube",
  "spotify",
  "discord",
  "apple-health"
] as const;
export type ImportSourceName = (typeof IMPORT_SOURCES)[number];

export function isImportSource(value: string): value is ImportSourceName {
  return (IMPORT_SOURCES as readonly string[]).includes(value);
}

export interface EventJob {
  kind: "events";
  /** The source its events carry (a name in the contracts registry). */
  source: string;
  /** The files it reads, for messages. */
  files: string[];
  stats: Stats;
  events(): AsyncGenerator<ActivityEventDraft>;
}

export interface YoutubeJob {
  kind: "youtube";
  source: "youtube";
  /** The history file inside the archive. */
  file: string;
  size: number;
  /** The whole file's bytes (the route takes one JSON body), read when called. */
  read(): Promise<Uint8Array>;
}

export type ImportJob = EventJob | YoutubeJob;

export interface ImportPlan {
  archive: Archive;
  jobs: ImportJob[];
  /** Plain notes for the user: what was looked for and not found. */
  notes: string[];
  /** The hash an event job is recorded under as an import. */
  sha256For(job: EventJob): Promise<string>;
}

/** Importers written from documented formats and never run on a real export. Each run says so. */
const UNVERIFIED_SOURCES = new Set(["timeline", "google-chat", "google-access-log", "google-photos"]);

const basenameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path: string) => {
  const parts = path.split("/");
  return parts.length > 1 ? parts[parts.length - 2]! : "";
};

async function readAll(chunks: AsyncIterable<Uint8Array | string>, declaredSize: number): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    const part = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    total += part.length;
    if (total > declaredSize)
      throw new ImportReadError(`The file holds more than its declared ${declaredSize} bytes; it is damaged.`);
    parts.push(part);
  }
  return Buffer.concat(parts);
}

/** Adds the file's name to an `ImportReadError` from its parser, so the message says which file. */
async function* inFile<T>(file: string, rows: AsyncGenerator<T>): AsyncGenerator<T> {
  try {
    yield* rows;
  } catch (error) {
    if (error instanceof ImportReadError && !error.message.startsWith(`${file}:`))
      throw new ImportReadError(`${file}: ${error.message}`);
    throw error;
  }
}

function eventJob(
  source: string,
  files: string[],
  build: (stats: Stats) => AsyncGenerator<ActivityEventDraft>
): EventJob {
  const stats = newStats();
  return {
    kind: "events",
    source,
    files,
    stats,
    events: () => build(stats)
  };
}

function matching(archive: Archive, test: (path: string, lower: string) => boolean): string[] {
  return archive.entries
    .map((entry) => entry.path)
    .filter((path) => test(path, path.toLowerCase()))
    .sort();
}

/** `bare` is true when the user named one file: then its name is not checked, since they named the source. */
function pick(archive: Archive, test: (path: string, lower: string) => boolean): string[] {
  return archive.kind === "file" ? archive.entries.map((entry) => entry.path) : matching(archive, test);
}

function chromeJob(archive: Archive): EventJob | null {
  const files = pick(archive, (_p, lower) => basenameOf(lower) === "browserhistory.json");
  if (files.length === 0) return null;
  return eventJob("chrome-takeout", files, async function* (stats) {
    for (const file of files) yield* parseChromeHistory(archive.open(file), stats);
  });
}

function googleActivityJob(archive: Archive): EventJob | null {
  const files = pick(archive, (_p, lower) => basenameOf(lower) === "myactivity.json");
  if (files.length === 0) return null;
  return eventJob("google-activity", files, async function* (stats) {
    for (const file of files) {
      yield* parseGoogleActivity(archive.open(file), parentOf(file) || "unknown", stats);
    }
  });
}

function mapsJob(archive: Archive): EventJob | null {
  const files = pick(archive, (_p, lower) =>
    /^(saved places|labeled places|labelled places)\.json$/.test(basenameOf(lower))
  );
  if (files.length === 0) return null;
  return eventJob("maps-places", files, async function* (stats) {
    for (const file of files)
      yield* parseMapsPlaces(
        archive.open(file),
        basenameOf(file).toLowerCase().startsWith("label") ? "labelled" : "saved",
        stats
      );
  });
}

function fitJob(archive: Archive): EventJob | null {
  const files = pick(
    archive,
    (_path, lower) => lower.endsWith(".csv") && /(^|\/)(daily activity metrics|daily summaries)\//.test(lower)
  );
  if (files.length === 0) return null;
  return eventJob("fit", files, async function* (stats) {
    for (const file of files) yield* parseFitMetrics(archive.open(file), basenameOf(file), stats);
  });
}

function timelineJob(archive: Archive): EventJob | null {
  const files = pick(
    archive,
    (path, lower) =>
      basenameOf(lower) === "timeline.json" ||
      basenameOf(lower) === "records.json" ||
      (/^\d{4}_[a-z]+\.json$/.test(basenameOf(lower)) && /^\d{4}$/.test(parentOf(path)))
  );
  if (files.length === 0) return null;
  return eventJob("timeline", files, async function* (stats) {
    for (const file of files) yield* inFile(file, parseTimeline(archive.open(file), stats));
  });
}

/** `Google Chat/Users/<id>/user_info.json` names the owner; the Users folder is the only place the export says who you are. */
function chatOwnerFiles(archive: Archive): string[] {
  return matching(archive, (_path, lower) => /(^|\/)users\/[^/]+\/user_info\.json$/.test(lower));
}

function googleChatJob(archive: Archive): EventJob | null {
  const files = pick(
    archive,
    (path, lower) => basenameOf(lower) === "messages.json" && /(^|\/)groups\/[^/]+\/messages\.json$/.test(lower)
  );
  if (files.length === 0) return null;
  const ownerFiles = archive.kind === "file" ? [] : chatOwnerFiles(archive);
  return eventJob("google-chat", [...files, ...ownerFiles], async function* (stats) {
    let owner: string | null = null;
    for (const file of ownerFiles) {
      owner = await parseChatOwner(archive.open(file));
      if (owner) break;
    }
    for (const file of files) {
      const space = chatSpaceId(parentOf(file));
      if (!space) {
        stats.read += 1;
        skip(stats, "space folder name is empty");
        continue;
      }
      yield* inFile(file, parseGoogleChatMessages(archive.open(file), space, owner, stats));
    }
  });
}

function accessLogJob(archive: Archive): EventJob | null {
  const files = pick(
    archive,
    (path, lower) =>
      /^activities\b.*\.(csv|json)$/.test(basenameOf(lower)) &&
      (lower.includes("access log") || basenameOf(lower).includes("services accessed"))
  );
  if (files.length === 0) return null;
  return eventJob("google-access-log", files, async function* (stats) {
    for (const file of files)
      yield* inFile(
        file,
        file.toLowerCase().endsWith(".json")
          ? parseAccessLogJson(archive.open(file), stats)
          : parseAccessLogCsv(archive.open(file), stats)
      );
  });
}

/** Only each photo's small `.json` sidecar is listed, hashed and read; the media files are never opened. */
function googlePhotosJob(archive: Archive): EventJob | null {
  const files = pick(
    archive,
    (_path, lower) =>
      lower.endsWith(".json") &&
      isPhotoSidecarName(basenameOf(lower)) &&
      /(^|\/)google (photos|fotos|foto)[^/]*\//.test(lower)
  );
  if (files.length === 0) return null;
  return eventJob("google-photos", files, async function* (stats) {
    for (const file of files) yield* parseGooglePhotosSidecar(archive.open(file), basenameOf(file), stats);
  });
}

function spotifyJob(archive: Archive): EventJob | null {
  const files = pick(archive, (_p, lower) => /^streaming_history_audio_.*\.json$/.test(basenameOf(lower)));
  if (files.length === 0) return null;
  return eventJob("spotify", files, async function* (stats) {
    for (const file of files) yield* parseSpotifyHistory(archive.open(file), stats);
  });
}

function discordJob(archive: Archive): EventJob | null {
  const files = pick(archive, (_p, lower) => /^messages\.(csv|json)$/.test(basenameOf(lower)));
  if (files.length === 0) return null;
  // A channel with both a CSV and a JSON is read once, from the CSV.
  const byFolder = new Map<string, string>();
  for (const file of files) {
    const folder = parentOf(file);
    const held = byFolder.get(folder);
    if (!held || (file.endsWith(".csv") && held.endsWith(".json"))) byFolder.set(folder, file);
  }
  const chosen = [...byFolder.values()];
  return eventJob("discord-package", chosen, async function* (stats) {
    for (const file of chosen) {
      const channel = channelIdFromFolder(parentOf(file));
      if (!channel) {
        stats.read += 1;
        skip(stats, "channel folder name is not a channel id");
        continue;
      }
      yield* file.endsWith(".csv")
        ? parseDiscordMessagesCsv(archive.open(file), channel, stats)
        : parseDiscordMessagesJson(archive.open(file), channel, stats);
    }
  });
}

function appleHealthJob(archive: Archive): EventJob | null {
  const files = pick(archive, (_p, lower) => basenameOf(lower) === "export.xml").slice(0, 1);
  if (files.length === 0) return null;
  return eventJob("apple-health", files, (stats) => parseAppleHealth(archive.open(files[0]!), stats));
}

function youtubeJob(archive: Archive): YoutubeJob | null {
  const entry = archive.entries.find((candidate) =>
    archive.kind === "file" ? true : candidate.path.toLowerCase().endsWith("history/watch-history.json")
  );
  if (!entry) return null;
  return {
    kind: "youtube",
    source: "youtube",
    file: entry.path,
    size: entry.size,
    read: () => readAll(archive.open(entry.path), entry.size)
  };
}

const EXPECTED: Record<Exclude<ImportSourceName, "takeout">, string> = {
  chrome: "Chrome/BrowserHistory.json",
  "google-activity": "My Activity/<product>/MyActivity.json",
  maps: "Saved Places.json or Labeled places.json",
  fit: "Fit/Daily activity metrics/*.csv",
  timeline: "Timeline.json, Records.json or Semantic Location History/<year>/<year>_<MONTH>.json",
  "google-chat": "Google Chat/Groups/<space>/messages.json",
  "access-log": "Access Log Activity/Activities - A list of Google services accessed by.csv",
  "google-photos": "Google Photos/<album>/<photo>.<ext>.json (the sidecar files)",
  youtube: "YouTube and YouTube Music/history/watch-history.json",
  spotify: "Streaming_History_Audio_*.json",
  discord: "messages/c<channel id>/messages.csv (or messages.json)",
  "apple-health": "apple_health_export/export.xml"
};

const BUILDERS: Record<Exclude<ImportSourceName, "takeout" | "youtube">, (archive: Archive) => EventJob | null> = {
  chrome: chromeJob,
  "google-activity": googleActivityJob,
  maps: mapsJob,
  fit: fitJob,
  timeline: timelineJob,
  "google-chat": googleChatJob,
  "access-log": accessLogJob,
  "google-photos": googlePhotosJob,
  spotify: spotifyJob,
  discord: discordJob,
  "apple-health": appleHealthJob
};

/** Finds the work for `source` in the file or folder at `path`. Throws `ImportReadError` when nothing there is for it. */
export async function planImport(source: ImportSourceName, path: string): Promise<ImportPlan> {
  const archive = await openArchive(path);
  const jobs: ImportJob[] = [];
  const notes: string[] = [];
  if (source === "takeout") {
    if (archive.kind === "file")
      throw new ImportReadError(
        `${path} is a single file. "takeout" reads a Takeout zip (or the folder it was unzipped into); for one file name its source, e.g. "chrome", "google-activity", "maps", "fit", "timeline", "google-chat", "access-log", "google-photos" or "youtube".`
      );
    for (const name of [
      "chrome",
      "google-activity",
      "maps",
      "fit",
      "timeline",
      "google-chat",
      "access-log",
      "google-photos"
    ] as const) {
      const job = BUILDERS[name](archive);
      if (job) jobs.push(job);
      else notes.push(`No ${EXPECTED[name]} found in ${path}; skipped.`);
    }
    const youtube = youtubeJob(archive);
    if (youtube) jobs.push(youtube);
    else notes.push(`No ${EXPECTED.youtube} found in ${path}; skipped.`);
  } else if (source === "youtube") {
    const job = youtubeJob(archive);
    if (job) jobs.push(job);
  } else {
    const job = BUILDERS[source](archive);
    if (job) jobs.push(job);
  }
  if (jobs.length === 0)
    throw new ImportReadError(
      source === "takeout"
        ? `Nothing this importer reads was found in ${path}. Expected a Takeout with Chrome, My Activity, Maps, Fit, Timeline, Google Chat, Access Log Activity, Google Photos or YouTube history. Export those products from takeout.google.com in JSON format.`
        : `No ${EXPECTED[source]} found in ${path}. Check that you chose the right source and the right export.`
    );
  for (const job of jobs)
    if (job.kind === "events" && UNVERIFIED_SOURCES.has(job.source))
      notes.push(
        `${job.source}: format not yet checked against a real Takeout; read the skipped reasons below and report a file that does not parse.`
      );
  if (archive.duplicates.length > 0)
    notes.push(
      `${archive.duplicates.length} path(s) appear in more than one zip part (for example ${archive.duplicates[0]}); only the first copy was read.`
    );
  const hash = archiveHasher(archive);
  return {
    archive,
    jobs,
    notes,
    async sha256For(job) {
      const container = await hash(job.files);
      // A bare file is recorded under its own hash. A container (zip or folder) can feed several sources, and one
      // hash can name only one import, so each source's import is recorded under a hash of the container and the source.
      return archive.kind === "file" ? container : sourceSha256(container, job.source);
    }
  };
}
