import type { ScanInput } from "@/server/persistence/postgres/derived-scan-store";

/** One source row as an extractor sees it: the row's id and event key, its start time and whatever attrs it holds. */
export interface SourceMessage {
  id: string;
  key: string;
  tsStart: Date;
  attrs: unknown;
}

/** A stored `fact` row as an extractor reads it back: its attrs and the time of the message it was read from (RFC 3339). */
export interface StoredFactRow {
  attrs: Record<string, unknown>;
  start: string;
}

/**
 * A row an extractor writes on behalf of OTHER messages than the one it is reading: its lineage points at those
 * messages (by event key), not at the one being read, so deleting a source removes what was derived from it. A row whose
 * source message is gone is dropped.
 */
export interface RowFromKeys {
  event: unknown;
  fromKeys: readonly string[];
}

/**
 * What the runner lets an extractor ask of the database without handing it one. Reads only, answered on first use and
 * kept for the batch, so an extractor that never asks costs no query.
 */
export interface ExtractorLookups {
  /** The owner's IANA zone, the one an all-day date is read in. UTC if none is set. */
  timeZone(): Promise<string>;
  /**
   * The attrs of the stored `derived` `fact` rows with this fact id, newest first and bounded, including rows made
   * earlier in the same batch that are not written yet. A reading is only as complete as the rows already written, so an
   * extractor that depends on it sets `oldestFirst`.
   */
  factRows(factId: string): Promise<StoredFactRow[]>;
}

/**
 * A versioned extractor the runner drives. `extract` returns the derived rows (in the API's shape) for one source
 * message, possibly none, and throws when it cannot read the message: the runner counts that as a failure of that
 * message alone. An extractor writes `msg_class` and `fact` rows only; there is no path from here to a `fact_status`,
 * `override` or `label`, which are a person's (or Mark's) to write.
 */
export interface Extractor {
  name: string;
  version: string;
  /** The fixed name recorded as `ingested_via` on every row this extractor writes. */
  via: string;
  input: ScanInput;
  /** Run each batch's messages oldest first, so an update sees the invite it changes when both are in one batch. */
  oldestFirst?: boolean;
  /**
   * False for an extractor that writes no `msg_class` rows, so the eval report's T0 share (messages given a tier-t0
   * class) is not computed for it. Default true.
   */
  classifies?: boolean;
  extract(message: SourceMessage, now: Date, lookups?: ExtractorLookups): unknown[] | Promise<unknown[]>;
  // An element of the result may be a `RowFromKeys`; any other element is a row read from `message`.
}
