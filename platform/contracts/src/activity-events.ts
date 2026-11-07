import { z } from "zod";
import { withoutDatePatterns } from "./agent-sessions.js";

/**
 * The activity store: the ingest contract (schema version 1) every non-plan data source posts through, the source
 * registry that validates `source` and `kind` in code (so a new source needs no migration), and the pure rules for
 * one event. Information only: nothing in the engine reads it. See docs/architecture/activity-store.md.
 */

export const ACTIVITY_SCHEMA_VERSION = 1;
export const ACTIVITY_MAX_BATCH = 1000;
/** The longest request body the ingest route reads, in bytes. */
export const ACTIVITY_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const ACTIVITY_ATTRS_MAX_BYTES = 8 * 1024;
export const ACTIVITY_CONTENT_MAX_BYTES = 64 * 1024;
export const ACTIVITY_KEY_MAX_CHARS = 200;
export const ACTIVITY_FUTURE_SLACK_HOURS = 24;
export const ACTIVITY_DEVICE_MAX_CHARS = 100;
export const ACTIVITY_FILENAME_MAX_CHARS = 300;
/** Rows a retention purge or purge-by-source deletes per statement. */
export const ACTIVITY_PURGE_BATCH = 5000;
/** The most rows one `GET /api/activity-events` page returns. */
export const ACTIVITY_READ_MAX_LIMIT = 1000;
export const ACTIVITY_READ_DEFAULT_LIMIT = 200;

/** A kind any source may use: a new row that corrects an earlier one; `attrs.corrects` names the event_key. Raw rows are never rewritten. */
export const ACTIVITY_CORRECTION_KIND = "correction";

export interface ActivitySourceEntry {
  /** Bumped when the meaning of a source's kinds or attrs changes, so the predictor can tell old rows from new. */
  schemaVersion: number;
  kinds: readonly string[];
}

/** Every source the store accepts, with its kinds. `correction` is also accepted for every source. */
export const ACTIVITY_SOURCES: Readonly<Record<string, ActivitySourceEntry>> = {
  "rhen-watch": {
    schemaVersion: 1,
    kinds: [
      "foreground",
      "idle",
      "locked",
      "remote",
      "logon",
      "logoff",
      "suspended",
      "display_off",
      "ac",
      "battery",
      "suppressed",
      "unknown",
      "clock_jump",
      "dropped",
      "title",
      "ocr"
    ]
  },
  "chrome-takeout": { schemaVersion: 1, kinds: ["visit"] },
  "google-activity": { schemaVersion: 1, kinds: ["search", "view", "ask"] },
  "maps-places": { schemaVersion: 1, kinds: ["place"] },
  fit: { schemaVersion: 1, kinds: ["steps", "activity"] },
  spotify: { schemaVersion: 1, kinds: ["play"] },
  "discord-package": { schemaVersion: 1, kinds: ["message"] },
  "apple-health": { schemaVersion: 1, kinds: ["sleep", "workout", "steps"] },
  steam: { schemaVersion: 1, kinds: ["session"] },
  weather: { schemaVersion: 1, kinds: ["observation"] },
  // attrs: thread_id, gmail_id, from, to[], from_self, direction (in|out), labels[], subject; content is the stripped body (gated).
  // Discord and notification messages reuse this attrs shape, with thread_id the channel id.
  gmail: { schemaVersion: 1, kinds: ["message"] },
  // Facts read out of other events. attrs: source_event_id, who, what, when, confidence. A status change is a later
  // fact_status row (rows are never updated). A derived row never carries the raw body.
  derived: { schemaVersion: 1, kinds: ["invite", "ask", "fact_status"] },
  "iphone-shortcuts": {
    schemaVersion: 1,
    kinds: [
      "app_open",
      "app_close",
      "focus_on",
      "focus_off",
      "charger_on",
      "charger_off",
      "place_arrive",
      "place_leave",
      "wifi",
      "wake",
      "alarm"
    ]
  },
  "iphone-health": {
    schemaVersion: 1,
    kinds: ["steps_day", "sleep", "workout", "heart_rate_day", "energy_day"]
  }
};

export const ACTIVITY_SOURCE_NAMES: readonly string[] = Object.keys(ACTIVITY_SOURCES);

export function isKnownActivitySource(source: string): boolean {
  return Object.hasOwn(ACTIVITY_SOURCES, source);
}

export function activityKindsOf(source: string): readonly string[] {
  return isKnownActivitySource(source) ? [...ACTIVITY_SOURCES[source]!.kinds, ACTIVITY_CORRECTION_KIND] : [];
}

const SOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const activitySourceNameSchema = z.string().regex(SOURCE_NAME);

const timestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex characters.");

/** The shared fields of one event, as the batch form and the single-event shorthand both carry them. */
const eventFields = {
  source: z.string().describe("A registered source name, e.g. rhen-watch. A wrong name is answered with the list."),
  kind: z.string().describe("A kind registered for that source."),
  start: timestamp.describe(
    "RFC 3339. Second or millisecond precision; an offset such as +11:00 is accepted, normalised to UTC, and recorded as tz_offset_min."
  ),
  end: timestamp.nullish().describe("Omit or null for an instant event; otherwise not before start."),
  tzOffsetMin: z
    .number()
    .int()
    .min(-840)
    .max(840)
    .nullish()
    .describe("Minutes east of UTC at the event. Overrides the offset in start when both are given."),
  approximate: z.boolean().optional().describe("True for a derived value rather than an observed one."),
  attrs: z.record(z.string(), z.unknown()).optional().describe("Small structured facts, at most 8 KB as JSON."),
  content: z
    .string()
    .nullish()
    .describe("Text (titles, messages, search text). Dropped unless the source's content gate is on. At most 64 KB.")
};

/** One event in a batch. */
export const activityEventSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(ACTIVITY_KEY_MAX_CHARS)
    .describe(
      "The event key: unique per (source, id). Posting it again is reported as alreadyHeld and changes nothing."
    ),
  ...eventFields
});
export type ActivityEventInput = z.infer<typeof activityEventSchema>;

/** The import a batch belongs to. The first batch of a file carries `import`; later batches carry `importId`. */
export const activityImportRefSchema = z.object({
  sha256,
  filename: z.string().min(1).max(ACTIVITY_FILENAME_MAX_CHARS),
  source: z.string().optional().describe("The source the file feeds; defaults to the first event's source.")
});

/** The full batch contract, published as JSON Schema. The route validates each event on its own so one bad event rejects itself only. */
export const ingestActivityEventsSchema = z.object({
  schema: z.literal(ACTIVITY_SCHEMA_VERSION),
  device: z.string().min(1).max(ACTIVITY_DEVICE_MAX_CHARS).optional(),
  import: activityImportRefSchema.optional(),
  importId: z.uuid().optional(),
  events: z.array(activityEventSchema).min(1).max(ACTIVITY_MAX_BATCH)
});
export type IngestActivityEvents = z.infer<typeof ingestActivityEventsSchema>;

/** The envelope the route reads first: events stay unvalidated so each can be judged alone. */
export const activityEnvelopeSchema = z.object({
  schema: z.literal(ACTIVITY_SCHEMA_VERSION),
  device: z.string().min(1).max(ACTIVITY_DEVICE_MAX_CHARS).optional(),
  import: activityImportRefSchema.optional(),
  importId: z.uuid().optional(),
  events: z.array(z.unknown()).min(1).max(ACTIVITY_MAX_BATCH)
});

/**
 * The single-event shorthand a phone shortcut can post: no `schema`, no `events`. `id` is optional; without it the
 * server derives the key from a hash of source, kind, start (to the second), device and attrs.
 */
export const activityShorthandSchema = z.object({
  id: z.string().min(1).max(ACTIVITY_KEY_MAX_CHARS).optional(),
  device: z.string().min(1).max(ACTIVITY_DEVICE_MAX_CHARS).optional(),
  ...eventFields
});
export type ActivityShorthand = z.infer<typeof activityShorthandSchema>;

/** A body is the shorthand (one event) when it has no `events` list and names a source. */
export function isActivityShorthand(body: unknown): body is Record<string, unknown> {
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    !("events" in body) &&
    !("schema" in body) &&
    "source" in body
  );
}

export interface ActivityRejection {
  index: number;
  reason: string;
}

export interface ActivityIngestResult {
  schema: typeof ACTIVITY_SCHEMA_VERSION;
  added: number;
  alreadyHeld: number;
  contentDropped: number;
  rejected: ActivityRejection[];
  /** The import record this batch belongs to, when it named one. */
  importId: string | null;
  /** The agent that posted the batch (the row's `ingested_via`); null for the owner. */
  ingestedVia: string | null;
}

/** An event after validation: times are instants, and the offset is separated out. */
export interface ValidActivityEvent {
  key: string;
  source: string;
  kind: string;
  tsStart: Date;
  tsEnd: Date | null;
  tzOffsetMin: number | null;
  approximate: boolean;
  attrs: Record<string, unknown>;
  content: string | null;
}

export type ActivityEventVerdict = { ok: true; event: ValidActivityEvent } | { ok: false; reason: string };

/** Minutes east of UTC in an RFC 3339 timestamp's own offset; null for `Z` (UTC says nothing about local time) or none. */
export function offsetMinutesOf(value: string): number | null {
  const match = /([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

function issueText(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.join(".") || "event";
      return `${field}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Judges one event on its own. The reasons say what is wrong and the exact fix, because the poster is often an
 * automation (a phone shortcut shows the response body as is) and must not have to guess.
 */
export function validateActivityEvent(raw: unknown, now: Date): ActivityEventVerdict {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return {
      ok: false,
      reason:
        'Each event must be an object like {"id": "...", "source": "...", "kind": "...", "start": "2026-11-07T14:02:11Z"}.'
    };
  const record = raw as Record<string, unknown>;
  const source = record.source;
  if (typeof source !== "string" || !isKnownActivitySource(source))
    return {
      ok: false,
      reason: `source ${typeof source === "string" ? `"${source}" is not known` : "is missing"}. Use one of: ${ACTIVITY_SOURCE_NAMES.join(", ")}.`
    };
  const kinds = activityKindsOf(source);
  const kind = record.kind;
  if (typeof kind !== "string" || !kinds.includes(kind))
    return {
      ok: false,
      reason: `kind ${typeof kind === "string" ? `"${kind}" is not known` : "is missing"} for source "${source}". Use one of: ${kinds.join(", ")}.`
    };
  const parsed = activityEventSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: issueText(parsed.error) };
  const event = parsed.data;
  const tsStart = new Date(event.start);
  const tsEnd = event.end == null ? null : new Date(event.end);
  if (tsEnd !== null && tsEnd.getTime() < tsStart.getTime())
    return {
      ok: false,
      reason: `end (${event.end}) is before start (${event.start}). Swap them, or leave end out for an instant event.`
    };
  if (tsStart.getTime() > now.getTime() + ACTIVITY_FUTURE_SLACK_HOURS * 3_600_000)
    return {
      ok: false,
      reason: `start (${event.start}) is more than ${ACTIVITY_FUTURE_SLACK_HOURS} hours in the future. Check the device clock and time zone.`
    };
  const attrs = event.attrs ?? {};
  const attrsBytes = byteLength(JSON.stringify(attrs));
  if (attrsBytes > ACTIVITY_ATTRS_MAX_BYTES)
    return {
      ok: false,
      reason: `attrs is ${attrsBytes} bytes; the limit is ${ACTIVITY_ATTRS_MAX_BYTES}. Keep small facts in attrs and put text in content.`
    };
  const content = event.content ?? null;
  if (content !== null && byteLength(content) > ACTIVITY_CONTENT_MAX_BYTES)
    return {
      ok: false,
      reason: `content is ${byteLength(content)} bytes; the limit is ${ACTIVITY_CONTENT_MAX_BYTES}. Shorten it or split it into several events.`
    };
  return {
    ok: true,
    event: {
      key: event.id,
      source,
      kind,
      tsStart,
      tsEnd,
      tzOffsetMin: event.tzOffsetMin ?? offsetMinutesOf(event.start),
      approximate: event.approximate ?? false,
      attrs,
      content
    }
  };
}

/** Owner-side settings for one source (`PUT /api/activity-sources/:source`). Absent fields keep their value. */
export const activitySourceSettingsSchema = z
  .object({
    contentEnabled: z.boolean().optional(),
    retentionDays: z.number().int().min(1).max(36_500).nullable().optional()
  })
  .strict();
export type ActivitySourceSettings = z.infer<typeof activitySourceSettingsSchema>;

export interface ActivitySourceSummary {
  source: string;
  schemaVersion: number;
  events: number;
  lastEventAt: string | null;
  lastIngestedAt: string | null;
  contentEnabled: boolean;
  retentionDays: number | null;
}

export interface ActivitySummary {
  sources: ActivitySourceSummary[];
  imports: { id: string; source: string; filename: string; eventCount: number; importedAt: string }[];
}

export interface ActivityEventRow {
  id: string;
  source: string;
  kind: string;
  key: string;
  device: string | null;
  start: string;
  end: string | null;
  tzOffsetMin: number | null;
  approximate: boolean;
  attrs: Record<string, unknown>;
  content: string | null;
  importId: string | null;
  ingestedVia: string | null;
  ingestedAt: string;
}

export interface ActivityEventsPage {
  events: ActivityEventRow[];
  /** Pass as `after` for the next page; null on the last. */
  next: string | null;
}

/** The text shown when a source's content gate is off, so a missing `content` is never a mystery. */
export const ACTIVITY_CONTENT_GATE_NOTE =
  'Content is stored only for a source whose content gate is on (PUT /api/activity-sources/<source> with {"contentEnabled": true}).';

/** The JSON Schema published for client authors (`platform/contracts/activity-events-schema.v1.json`). */
export function activityEventsJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://openrhen.example/schemas/activity-events.v1.json",
    title: "OpenRhen activity events, version 1",
    ...(withoutDatePatterns(
      z.toJSONSchema(ingestActivityEventsSchema, { io: "input", unrepresentable: "any" })
    ) as Record<string, unknown>),
    "x-sources": Object.fromEntries(
      Object.entries(ACTIVITY_SOURCES).map(([name, entry]) => [
        name,
        { schemaVersion: entry.schemaVersion, kinds: [...entry.kinds, ACTIVITY_CORRECTION_KIND] }
      ])
    )
  };
}
