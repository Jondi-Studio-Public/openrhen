import { jsonArrayObjects } from "../json-stream.js";
import { parseTimestamp } from "../time.js";
import { skip, type ActivityEventDraft, type ByteSource, type Stats } from "../types.js";

/**
 * Spotify extended streaming history: `Streaming_History_Audio_*.json`, an array of plays.
 * `ts` is the END of the play (UTC), so the play started at `ts - ms_played`. Only the owner's own play facts are
 * kept: the track or episode id, the times, whether it was skipped, and the names (as content). Country, IP
 * address and device strings in the export are never read. A play with neither a track nor an episode id (an
 * audiobook, a removed track) is skipped, not given a made-up id.
 * The key is `spotify:<id>:<end time to the second>`, so the same play from the export and from the live poller
 * (later change) is one fact.
 */
const SPOTIFY_ID = /^[A-Za-z0-9]{10,40}$/;
const REASON = /^[a-z0-9_ -]{1,40}$/i;

function spotifyId(uri: unknown, type: "track" | "episode"): string | null {
  if (typeof uri !== "string") return null;
  const match = new RegExp(`^spotify:${type}:([A-Za-z0-9]+)$`).exec(uri);
  return match && SPOTIFY_ID.test(match[1]!) ? match[1]! : null;
}

export async function* parseSpotifyHistory(source: ByteSource, stats: Stats): AsyncGenerator<ActivityEventDraft> {
  for await (const element of jsonArrayObjects(source, (end) => {
    if (end.truncated) stats.truncated = true;
  })) {
    stats.read += 1;
    const row = element.ok ? (element.value as Record<string, unknown>) : null;
    if (!row) {
      skip(stats, "row is not valid JSON");
      continue;
    }
    const end = parseTimestamp(row.ts, { utcOffsetIsUnknown: true });
    if (!end) {
      skip(stats, "ts is missing or has no time zone");
      continue;
    }
    const played = row.ms_played;
    if (typeof played !== "number" || !Number.isFinite(played) || played < 0 || played > 24 * 3_600_000) {
      skip(stats, "ms_played is missing, negative or longer than a day");
      continue;
    }
    const trackId = spotifyId(row.spotify_track_uri, "track");
    const episodeId = spotifyId(row.spotify_episode_uri, "episode");
    if (!trackId && !episodeId) {
      skip(stats, "no Spotify track or episode id (an audiobook or a removed item)");
      continue;
    }
    const id = (trackId ?? episodeId)!;
    const endDate = end.date;
    const startDate = new Date(endDate.getTime() - Math.round(played));
    const attrs: Record<string, unknown> = trackId
      ? { track_id: id, ms_played: Math.round(played) }
      : { episode_id: id, ms_played: Math.round(played) };
    if (typeof row.skipped === "boolean") attrs.skipped = row.skipped;
    if (typeof row.shuffle === "boolean") attrs.shuffle = row.shuffle;
    if (typeof row.offline === "boolean") attrs.offline = row.offline;
    if (typeof row.reason_start === "string" && REASON.test(row.reason_start)) attrs.reason_start = row.reason_start;
    if (typeof row.reason_end === "string" && REASON.test(row.reason_end)) attrs.reason_end = row.reason_end;
    const names = trackId
      ? [row.master_metadata_track_name, row.master_metadata_album_artist_name, row.master_metadata_album_album_name]
      : [row.episode_name, row.episode_show_name];
    const lines = names.map((name) => (typeof name === "string" ? name.replace(/\s+/g, " ").trim() : ""));
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    stats.emitted += 1;
    yield {
      id: `spotify:${id}:${endDate.toISOString().slice(0, 19)}Z`,
      source: "spotify",
      kind: "play",
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      attrs,
      ...(lines.length > 0 ? { content: lines.join("\n") } : {})
    };
  }
}
