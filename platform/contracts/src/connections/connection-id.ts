import { z } from "zod";
import { mergedRecord } from "../extensions.js";
import "../private/index.js";
import "./calendar-feed-manifest.js";

/** Format only: for any provider id read back from storage. */
export const sourceIdSchema = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

/** Path words that are siblings of `/api/connections/[connectionId]`, so no connection may take them. */
export const RESERVED_ROUTE_WORDS = ["status"] as const;

/** Values that share an id column (`sources.source_type`, `journey_samples.source`) with connection ids. */
export const RESERVED_SOURCE_IDS = [
  "csv",
  "xlsx",
  "ai_text",
  "ai_image",
  "fixture",
  "manual_capture",
  "own_trip",
  "email",
  "deliverable_text",
  "deliverable_upload"
] as const;

/** Source ids an extension reserves (a feature registers its own), each with its label. Read at parse time. */
export function extensionSourceIds(): Record<string, string> {
  return mergedRecord((extension) => extension.sourceIds);
}

const RESERVED: readonly string[] = [...RESERVED_ROUTE_WORDS, ...RESERVED_SOURCE_IDS];

export const connectionIdSchema = sourceIdSchema.refine(
  (id) => !RESERVED.includes(id) && !Object.hasOwn(extensionSourceIds(), id),
  {
    message: "reserved id"
  }
);

export type SourceId = string;
export type ConnectionId = string;
