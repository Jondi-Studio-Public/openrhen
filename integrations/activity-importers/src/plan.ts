import { archiveSha256, openArchive, sourceSha256, type Archive } from "./archive.js";
import { parseAppleHealth } from "./parsers/apple-health.js";
import { parseChromeHistory } from "./parsers/chrome.js";
import { channelIdFromFolder, parseDiscordMessagesCsv, parseDiscordMessagesJson } from "./parsers/discord.js";
import { parseFitMetrics } from "./parsers/fit.js";
import { parseGoogleActivity } from "./parsers/google-activity.js";
import { parseMapsPlaces } from "./parsers/maps.js";
import { parseSpotifyHistory } from "./parsers/spotify.js";
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

const basenameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path: string) => {
  const parts = path.split("/");
  return parts.length > 1 ? parts[parts.length - 2]! : "";
};

async function readAll(chunks: AsyncIterable<Uint8Array | string>): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  return Buffer.concat(parts);
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
    read: () => readAll(archive.open(entry.path))
  };
}

const EXPECTED: Record<Exclude<ImportSourceName, "takeout">, string> = {
  chrome: "Chrome/BrowserHistory.json",
  "google-activity": "My Activity/<product>/MyActivity.json",
  maps: "Saved Places.json or Labeled places.json",
  fit: "Fit/Daily activity metrics/*.csv",
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
        `${path} is a single file. "takeout" reads a Takeout zip (or the folder it was unzipped into); for one file name its source, e.g. "chrome", "google-activity", "maps", "fit" or "youtube".`
      );
    for (const name of ["chrome", "google-activity", "maps", "fit"] as const) {
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
        ? `Nothing this importer reads was found in ${path}. Expected a Takeout with Chrome, My Activity, Maps, Fit or YouTube history. Export those products from takeout.google.com in JSON format.`
        : `No ${EXPECTED[source]} found in ${path}. Check that you chose the right source and the right export.`
    );
  return {
    archive,
    jobs,
    notes,
    async sha256For(job) {
      const container = await archiveSha256(archive, job.files);
      // A bare file is recorded under its own hash. A container (zip or folder) can feed several sources, and one
      // hash can name only one import, so each source's import is recorded under a hash of the container and the source.
      return archive.kind === "file" ? container : sourceSha256(container, job.source);
    }
  };
}
