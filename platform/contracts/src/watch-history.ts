import { z } from "zod";

/**
 * Watch history: the contract for importing a Google Takeout file and for the Review panel's counts. The
 * person's own viewing record, held where the planning engine cannot see it; no agent route reads or writes it.
 */

/** The longest request body the import route accepts, in bytes (base64 inflates a zip by about a third). */
export const WATCH_IMPORT_MAX_BODY_BYTES = 70_000_000;
/** The most a bare JSON file, or the history file inside a zip, may hold once unpacked. */
export const WATCH_IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Rows inserted per statement; the whole import still runs in one transaction. */
export const WATCH_IMPORT_BATCH_ROWS = 1000;
/** Two watches further apart than this belong to different sessions. */
export const WATCH_SESSION_GAP_MINUTES = 120;
/** The longest span of local dates one review read may ask for. */
export const WATCH_REVIEW_MAX_DAYS = 366;
/** The span Review shows when the caller names none. */
export const WATCH_REVIEW_DEFAULT_DAYS = 30;

/** Video ids per length lookup: the YouTube Data API's own limit for `videos.list`. */
export const VIDEO_DURATIONS_BATCH = 50;
/** Quota units the lookup allows itself a day: Google's default is 10,000, and the rest is left to the person's other uses. */
export const YOUTUBE_DAILY_UNIT_LIMIT = 9_500;
/** A real YouTube video id. Anything else in a Takeout file (a synthetic `x:` id, an odd address) is never looked up. */
export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The portal's request to the `youtube_data` connection for video lengths. The key rides in the body, from the
 * portal's encrypted store to the proxy, and the proxy sends it to Google in a header only.
 */
export const videoDurationsRequestSchema = z
  .object({
    apiKey: z.string().trim().min(1).max(2048),
    ids: z.array(z.string().regex(YOUTUBE_VIDEO_ID)).min(1).max(VIDEO_DURATIONS_BATCH)
  })
  .strict();
export type VideoDurationsRequest = z.infer<typeof videoDurationsRequestSchema>;

/**
 * One answer per id asked for. `durationS` is null with `unavailable: true` for a video that is private, deleted or
 * not found, and null with `unavailable: false` for a live or zero-length one (no usable length, but not gone).
 */
export const videoDurationsResponseSchema = z.object({
  videos: z.array(
    z.object({
      id: z.string(),
      durationS: z.number().int().nonnegative().nullable(),
      unavailable: z.boolean()
    })
  )
});
export type VideoDurationsResponse = z.infer<typeof videoDurationsResponseSchema>;

export const importWatchHistorySchema = z.object({
  filename: z.string().trim().min(1).max(255),
  encoding: z.enum(["base64", "text"]),
  data: z.string().min(1)
});
export type ImportWatchHistory = z.infer<typeof importWatchHistorySchema>;

export interface WatchImportResult {
  /** The id to undo this import with; null when nothing new was added (the file was imported before). */
  importId: string | null;
  /** Watches, ads and posts read from the file with a usable time. */
  read: number;
  /** Rows added; a repeat upload adds none. */
  added: number;
  /** Rows already held, so left alone. */
  alreadyHeld: number;
  /** Entries left out for lacking a time or a usable address. */
  skipped: number;
  /** How the rows added split by kind and source. */
  watches: number;
  ads: number;
  posts: number;
  music: number;
}

export interface WatchEstimate {
  /** Whole minutes; the true figure is not below `lowMin`, and this estimate leans toward `highMin`. */
  lowMin: number;
  highMin: number;
  /** (low + high) / 2, rounded. */
  midMin: number;
  /** Watches counted, sessions they fall in, and watches whose length is not known and not bounded by a next watch. */
  videos: number;
  sessions: number;
  unknownCount: number;
}

/** How far the video-length lookup has got, for the Review panel. */
export interface WatchLengths {
  /** Whether a YouTube key is saved and readable. */
  keyState: "set" | "unreadable" | "unset";
  /** Watches in the range whose length is known (so the estimate used it). */
  known: number;
  /** Watches in the range with no length yet. */
  missing: number;
  /** Watches in the range whose video is private, deleted or has no usable length. */
  unavailable: number;
  /** Set when the last lookup stopped because Google's daily quota ran out; it resumes on the next run. */
  quotaPaused: boolean;
}

export interface WatchLengthsFetchResult {
  /** Lengths stored this run (including videos marked unavailable). */
  fetched: number;
  /** Ids still without a length after this run. */
  remaining: number;
  /** Why the run stopped early, or null when it finished. */
  stopped: "no_key" | "key_unreadable" | "bad_key" | "quota" | "rate_limited" | "unreachable" | "not_ready" | null;
  /** A plain sentence for the person. */
  message: string;
}

export interface WatchImportSummary {
  id: string;
  filename: string;
  eventCount: number;
  importedAt: string;
}

export interface WatchHistoryReview {
  timezone: string;
  /** Local dates, inclusive. */
  from: string;
  to: string;
  /** Whether any watch has ever been imported. */
  hasData: boolean;
  /** Takeout YouTube watches held in all, whatever the range (ads, posts and YouTube Music not counted). */
  watchesHeld: number;
  /** Every local date in the range, zero where nothing was watched. */
  days: { date: string; count: number }[];
  /** Watches by local hour of day, 24 entries. */
  hours: number[];
  total: number;
  estimate: WatchEstimate;
  lengths: WatchLengths;
  /** Rows held but not counted as watches. */
  excluded: { ads: number; posts: number; music: number };
  imports: WatchImportSummary[];
}
