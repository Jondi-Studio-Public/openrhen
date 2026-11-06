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
  /** Every local date in the range, zero where nothing was watched. */
  days: { date: string; count: number }[];
  /** Watches by local hour of day, 24 entries. */
  hours: number[];
  total: number;
  estimate: WatchEstimate;
  /** Rows held but not counted as watches. */
  excluded: { ads: number; posts: number; music: number };
  imports: WatchImportSummary[];
}
