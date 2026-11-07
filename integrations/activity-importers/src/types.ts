/**
 * The shapes every importer shares. A parser is a pure streaming function: bytes in, event drafts out, and a
 * `Stats` it fills in as it goes. Nothing here touches the network or imports portal code.
 */

/** One event as `POST /api/activity-events` takes it. Content goes in `content` and nowhere else. */
export interface ActivityEventDraft {
  id: string;
  source: string;
  kind: string;
  /** RFC 3339, UTC, millisecond precision. */
  start: string;
  end?: string;
  tzOffsetMin?: number;
  approximate?: boolean;
  attrs: Record<string, unknown>;
  content?: string;
}

/** A chunk source: a Node stream, a file read stream or any async iterable of bytes or text. */
export type ByteSource = AsyncIterable<Uint8Array | string>;

/** What a parser counted. Unknown or malformed rows are skipped and counted here, never guessed. */
export interface Stats {
  /** Rows of the kinds this importer handles (so `skipped` and `emitted` are measured against it). */
  read: number;
  emitted: number;
  /** Rows of a handled kind that were malformed or unrecognised, by plain-English reason. */
  skipped: number;
  /** Rows that are valid but not wanted (another record type, a product another route covers). */
  ignored: number;
  reasons: Record<string, number>;
  /** The input ended inside a structure (a cut-off download). Events read before that are still emitted. */
  truncated: boolean;
}

export function newStats(): Stats {
  return { read: 0, emitted: 0, skipped: 0, ignored: 0, reasons: {}, truncated: false };
}

/** Counts a skipped row under a reason. Reasons are fixed phrases, so the tally stays small. */
export function skip(stats: Stats, reason: string): void {
  stats.skipped += 1;
  stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
}

export function mergeStats(into: Stats, from: Stats): void {
  into.read += from.read;
  into.emitted += from.emitted;
  into.skipped += from.skipped;
  into.ignored += from.ignored;
  into.truncated ||= from.truncated;
  for (const [reason, count] of Object.entries(from.reasons))
    into.reasons[reason] = (into.reasons[reason] ?? 0) + count;
}

/** Thrown for a file that cannot be read at all (not a zip, unsupported compression), as opposed to a bad row. */
export class ImportReadError extends Error {}
