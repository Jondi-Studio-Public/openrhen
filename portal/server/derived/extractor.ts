import type { ScanInput } from "@/server/persistence/postgres/derived-scan-store";

/** One source row as an extractor sees it: the row's id and event key, its start time and whatever attrs it holds. */
export interface SourceMessage {
  id: string;
  key: string;
  tsStart: Date;
  attrs: unknown;
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
  extract(message: SourceMessage, now: Date): unknown[] | Promise<unknown[]>;
}
