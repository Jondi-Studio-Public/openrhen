import { z } from "zod";
import { describeDerivedProblem } from "./activity-derived.js";
import {
  PHYSIOLOGY_KINDS,
  PHYSIOLOGY_SCHEMA_VERSION,
  PHYSIOLOGY_SOURCE,
  describePhysiologyProblem
} from "./activity-physiology.js";
import { scopeCovers } from "./agent-scopes.js";
import { withoutDatePatterns } from "./agent-sessions.js";
import { mergedRecord } from "./extensions.js";
import type { SourceAvailability } from "./signal-availability.js";

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

/** The class of a source whose rows describe the body. Reading them over a token needs `ACTIVITY_HEALTH_SCOPE`. */
export const ACTIVITY_HEALTH_CLASS = "health";
/** The scope that lets a token read health-class sources. Deliberately not offered to OAuth clients (`SCOPES_SUPPORTED`). */
export const ACTIVITY_HEALTH_SCOPE = "read:activity-health";

export interface ActivitySourceEntry {
  /** Bumped when the meaning of a source's kinds or attrs changes, so the predictor can tell old rows from new. */
  schemaVersion: number;
  kinds: readonly string[];
  /** Optional. `health`: a token reads this source only with `read:activity-health` (and `read:activity-event`). */
  class?: typeof ACTIVITY_HEALTH_CLASS;
  /** The one family the source posts (a name and version, e.g. `name@1`); absent for legacy sources. */
  family?: `${string}@${number}`;
  /** How the source reaches us and what it supplies; absent for legacy sources and for projections such as `derived`. */
  availability?: SourceAvailability;
  /** Kinds that are read out of other events (clusters, stays) rather than sensed: they feed no signal, take a derived write scope and are deleted with their inputs. */
  projectionKinds?: readonly string[];
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
      "paused",
      "degraded",
      "start",
      "stop",
      // A browser visit: the URL and page title are sent in `content` ("url\ntitle"), so the content gate governs them; attrs never hold either.
      "visit",
      // One minute of keyboard and mouse activity per app run: attrs {exe, run, observed_ms, input_ms}.
      "input_minute",
      "title",
      "ocr"
    ]
  },
  "chrome-takeout": { schemaVersion: 1, kinds: ["visit"] },
  "google-activity": { schemaVersion: 1, kinds: ["search", "view", "ask"] },
  "maps-places": { schemaVersion: 1, kinds: ["place"] },
  fit: { schemaVersion: 1, kinds: ["steps", "activity"] },
  // Takeout Timeline. place_visit/activity_segment have an end; point is an instant. attrs: lat, lng, place_id, ...; content is the place name and address.
  timeline: { schemaVersion: 1, kinds: ["place_visit", "activity_segment", "point"] },
  // Takeout Google Chat. Reuses the gmail attrs shape (thread_id = space id, from, from_self, direction); content is the message text.
  "google-chat": { schemaVersion: 1, kinds: ["message"] },
  // Takeout Access Log Activity. attrs: product, activity_type only; the IP address and user-agent are never read.
  "google-access-log": { schemaVersion: 1, kinds: ["access"] },
  // Takeout Google Photos sidecar metadata only (never the media). attrs: lat, lng, uploaded_at; content is the file name and description.
  "google-photos": { schemaVersion: 1, kinds: ["photo", "video"] },
  spotify: { schemaVersion: 1, kinds: ["play"] },
  "discord-package": { schemaVersion: 1, kinds: ["message"] },
  "apple-health": { schemaVersion: 1, kinds: ["sleep", "workout", "steps"], class: ACTIVITY_HEALTH_CLASS },
  steam: { schemaVersion: 1, kinds: ["session"] },
  weather: { schemaVersion: 1, kinds: ["observation"] },
  // attrs: thread_id, gmail_id, from, to[], from_self, direction (in|out), labels[], subject; content is the stripped body (gated).
  // Discord and notification messages reuse this attrs shape, with thread_id the channel id.
  gmail: { schemaVersion: 1, kinds: ["message"] },
  // Rows read out of other events by a versioned reader. msg_class and fact name their source_event_id; fact_status,
  // override and label name a fact_id. A status change is a later fact_status row (rows are never updated). Per-kind
  // attrs are validated in activity-derived.ts; a derived row never carries the raw body.
  derived: { schemaVersion: 1, kinds: ["msg_class", "fact", "fact_status", "override", "label"] },
  // Rows a not-yet-promoted extractor version writes so two versions can be compared on the eval set before one is
  // promoted: extractor output only (msg_class, fact), under the same validators as `derived`, and no `correction`
  // kind. A status, override or label is never stored here for any writer. Reads of `derived` never show these rows,
  // and only the in-process runner path and a write:activity-derived token write them. Not a user-facing shadow mode.
  "derived-shadow": { schemaVersion: 1, kinds: ["msg_class", "fact"] },
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
    kinds: ["steps_day", "sleep", "workout", "heart_rate_day", "energy_day"],
    class: ACTIVITY_HEALTH_CLASS
  },
  // Generic physiology from any wearable, phone or health app, posted by the user's own collector as period rows under
  // one canonical key (activity-physiology.ts; docs/operations/posting-physiology-data.md). Context only.
  [PHYSIOLOGY_SOURCE]: {
    schemaVersion: PHYSIOLOGY_SCHEMA_VERSION,
    kinds: PHYSIOLOGY_KINDS,
    class: ACTIVITY_HEALTH_CLASS
  }
};

export const ACTIVITY_SOURCE_NAMES: readonly string[] = Object.keys(ACTIVITY_SOURCES);

/** The sources of class `health`, sorted. */
export function activityHealthSources(): string[] {
  return Object.entries(ACTIVITY_SOURCES)
    .filter(([, entry]) => entry.class === ACTIVITY_HEALTH_CLASS)
    .map(([name]) => name)
    .sort();
}

/**
 * The health-class sources a read must leave out for these token scopes. `undefined` scopes (the owner, an environment
 * token, a background writer) withhold nothing; a token without `read:activity-health` withholds every health source.
 */
export function withheldActivitySources(scopes: readonly string[] | undefined): string[] {
  if (scopes === undefined || scopes.some((held) => scopeCovers(held, ACTIVITY_HEALTH_SCOPE))) return [];
  return activityHealthSources();
}

const FAMILY_REF = /^[a-z0-9][a-z0-9-]*@[1-9][0-9]*$/;
/** Families an extension source may name. Slice 1.3 replaces this with the family registry. */
export const KNOWN_ACTIVITY_FAMILIES: ReadonlySet<string> = new Set<string>();

/** What is wrong with the sources one extension registers, or undefined when they are fine. */
export function describeExtensionSourceProblem(
  extensionId: string,
  sources: Readonly<Record<string, ActivitySourceEntry>>,
  families: ReadonlySet<string> = KNOWN_ACTIVITY_FAMILIES
): string | undefined {
  for (const [name, entry] of Object.entries(sources)) {
    if (Object.hasOwn(ACTIVITY_SOURCES, name))
      return `Extension "${extensionId}" source "${name}" shadows a core source.`;
    if (!name.startsWith(`${extensionId}-`) || !SOURCE_NAME.test(name))
      return `Extension "${extensionId}" source "${name}" must match ${SOURCE_NAME} and start with "${extensionId}-".`;
    if (!entry.family || !FAMILY_REF.test(entry.family) || !families.has(entry.family))
      return `Extension "${extensionId}" source "${name}" must name an existing family${entry.family ? `, not "${entry.family}"` : ""}.`;
  }
  return undefined;
}

const checkedExtensionSources = new WeakSet<object>();

/** Core sources and every extension's, merged. Throws if an extension source is invalid or shadows a core one. */
function mergedActivitySources(): Readonly<Record<string, ActivitySourceEntry>> {
  const extra = mergedRecord((extension) => {
    const sources = extension.activitySources;
    if (!sources) return undefined;
    if (!checkedExtensionSources.has(sources)) {
      const problem = describeExtensionSourceProblem(extension.id, sources);
      if (problem) throw new Error(problem);
      checkedExtensionSources.add(sources);
    }
    return sources;
  });
  return Object.keys(extra).length === 0 ? ACTIVITY_SOURCES : { ...extra, ...ACTIVITY_SOURCES };
}

/** The entry for a source, core or extension; undefined when unknown. */
export function activitySourceEntry(source: string): ActivitySourceEntry | undefined {
  const merged = mergedActivitySources();
  return Object.hasOwn(merged, source) ? merged[source] : undefined;
}

/** Every known source name, core first. */
export function activitySourceNames(): readonly string[] {
  return Object.keys(mergedActivitySources());
}

export function isKnownActivitySource(source: string): boolean {
  return Object.hasOwn(mergedActivitySources(), source);
}

/** Sources that hold one kind of output only and so take no `correction` row. */
const NO_CORRECTIONS: readonly string[] = ["derived-shadow"];

export function activityKindsOf(source: string): readonly string[] {
  const entry = activitySourceEntry(source);
  if (!entry) return [];
  return NO_CORRECTIONS.includes(source) ? [...entry.kinds] : [...entry.kinds, ACTIVITY_CORRECTION_KIND];
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

/** What the store already holds for a physiology event that was answered `alreadyHeld`, so a collector can compare and re-post as the next `v`. */
export interface ActivityHeldEntry {
  /** The event's position in the batch. */
  index: number;
  key: string;
  /** The held row's `attrs.v`. */
  v: number | null;
  /** The held row's `attrs.coverage_s` and `attrs.n`; null for a kind that has none. */
  coverage_s: number | null;
  n: number | null;
}

export interface ActivityIngestResult {
  schema: typeof ACTIVITY_SCHEMA_VERSION;
  added: number;
  alreadyHeld: number;
  contentDropped: number;
  rejected: ActivityRejection[];
  /** For each physiology event answered `alreadyHeld`: what is already stored under its key. Empty for every other source. */
  held: ActivityHeldEntry[];
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

const TIME_EXAMPLE = '"2026-11-07T14:02:11Z" or "2026-11-07T14:02:11+11:00"';
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const MIN_YEAR = 1970;
const MAX_YEAR = 2200;
const MAX_OFFSET_MINUTES = 840;
const MAX_ATTRS_DEPTH = 20;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Why a time is unusable, in words that say what to send, or null when it is a real RFC 3339 time. Checks what the
 * database would otherwise throw on: an offset outside -14:00..+14:00, a date that does not exist, a year it cannot hold.
 * `field` is the field's name in the message. Never throws.
 */
export function describeTimeProblem(field: string, value: unknown): string | null {
  if (value === undefined || value === null)
    return `${field} is missing. Send an RFC 3339 time such as ${TIME_EXAMPLE}.`;
  if (typeof value !== "string") return `${field} must be a time as text, such as ${TIME_EXAMPLE}.`;
  const match = RFC3339.exec(value);
  const [month, day, hour, minute, second] = [2, 3, 4, 5, 6].map((i) => Number(match?.[i]));
  const offsetMinutes = match?.[8] === undefined ? 0 : Number(match[8]) * 60 + Number(match[9]);
  const daysInMonth = match ? new Date(Date.UTC(Number(match[1]), month!, 0)).getUTCDate() : 0;
  const real =
    match !== null &&
    month! >= 1 &&
    month! <= 12 &&
    day! >= 1 &&
    day! <= daysInMonth &&
    hour! <= 23 &&
    minute! <= 59 &&
    second! <= 59 &&
    (match[9] === undefined || Number(match[9]) < 60) &&
    offsetMinutes <= MAX_OFFSET_MINUTES &&
    !Number.isNaN(new Date(value).getTime());
  if (!real)
    return `${field} "${value.slice(0, 60)}" is not a real time. Send an RFC 3339 time such as ${TIME_EXAMPLE} (an offset runs from -14:00 to +14:00).`;
  const year = new Date(value).getUTCFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR)
    return `${field} "${value}" is outside the years ${MIN_YEAR} to ${MAX_YEAR}. Check the device clock.`;
  return null;
}

/**
 * Why text cannot be stored: a NUL or a lone surrogate, which Postgres refuses (so one such event would otherwise
 * fail the whole batch and a retrying uploader would never stop). Null when the text is fine. Never throws.
 */
export function describeUnstorableText(field: string, text: string): string | null {
  if (text.includes("\u0000"))
    return `${field} contains a NUL character (\\u0000), which cannot be stored. Remove or replace it.`;
  if (LONE_SURROGATE.test(text))
    return `${field} contains a lone surrogate (half of an emoji or other character), which cannot be stored. Remove or replace it.`;
  return null;
}

function describeUnstorableAttrs(value: unknown, depth = 0): string | null {
  if (depth > MAX_ATTRS_DEPTH)
    return `attrs nests deeper than ${MAX_ATTRS_DEPTH} levels. Keep attrs flat: small facts, not documents.`;
  if (typeof value === "string") return describeUnstorableText("attrs", value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = describeUnstorableAttrs(item, depth + 1);
      if (problem) return problem;
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const problem = describeUnstorableText("attrs", key) ?? describeUnstorableAttrs(item, depth + 1);
      if (problem) return problem;
    }
  }
  return null;
}

const reject = (reason: string): ActivityEventVerdict => ({ ok: false, reason });

/**
 * Judges one event on its own. The reasons say what is wrong and the exact fix, in plain words, because the poster is
 * often an automation (a phone shortcut shows the response body as is) and must not have to guess. Never throws.
 */
export function validateActivityEvent(raw: unknown, now: Date): ActivityEventVerdict {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return reject(
      'Each event must be an object like {"id": "...", "source": "...", "kind": "...", "start": "2026-11-07T14:02:11Z"}.'
    );
  const record = raw as Record<string, unknown>;
  const source = record.source;
  if (typeof source !== "string" || !isKnownActivitySource(source))
    return reject(
      `source ${typeof source === "string" ? `"${source.slice(0, 60)}" is not known` : "is missing"}. Use one of: ${ACTIVITY_SOURCE_NAMES.join(", ")}.`
    );
  const kinds = activityKindsOf(source);
  const kind = record.kind;
  if (typeof kind !== "string" || !kinds.includes(kind))
    return reject(
      `kind ${typeof kind === "string" ? `"${kind.slice(0, 60)}" is not known` : "is missing"} for source "${source}". Use one of: ${kinds.join(", ")}.`
    );
  const id = record.id;
  if (typeof id !== "string" || id.length === 0)
    return reject(
      `id is missing. Send a text key of 1 to ${ACTIVITY_KEY_MAX_CHARS} characters that is the same each time you send this event, such as "phone-2026-11-07T14:02:11".`
    );
  if (id.length > ACTIVITY_KEY_MAX_CHARS)
    return reject(`id is ${id.length} characters long; the limit is ${ACTIVITY_KEY_MAX_CHARS}. Send a shorter key.`);
  const idProblem = describeUnstorableText("id", id);
  if (idProblem) return reject(idProblem);
  const startProblem = describeTimeProblem("start", record.start);
  if (startProblem) return reject(startProblem);
  const start = record.start as string;
  const end = record.end ?? null;
  if (end !== null) {
    const endProblem = describeTimeProblem("end", end);
    if (endProblem) return reject(endProblem);
  }
  const tzOffsetMin = record.tzOffsetMin ?? null;
  if (
    tzOffsetMin !== null &&
    (typeof tzOffsetMin !== "number" || !Number.isInteger(tzOffsetMin) || Math.abs(tzOffsetMin) > MAX_OFFSET_MINUTES)
  )
    return reject(
      `tzOffsetMin must be a whole number of minutes east of UTC between -${MAX_OFFSET_MINUTES} and ${MAX_OFFSET_MINUTES} (Sydney in summer is 660), or left out.`
    );
  if (record.approximate !== undefined && typeof record.approximate !== "boolean")
    return reject("approximate must be true or false, or left out.");
  const rawAttrs = record.attrs ?? {};
  if (rawAttrs === null || typeof rawAttrs !== "object" || Array.isArray(rawAttrs))
    return reject('attrs must be an object of small facts such as {"app": "Maps"}, or left out.');
  const rawContent = record.content ?? null;
  if (rawContent !== null && typeof rawContent !== "string") return reject("content must be text, or left out.");

  const tsStart = new Date(start);
  const tsEnd = end === null ? null : new Date(end as string);
  if (tsEnd !== null && tsEnd.getTime() < tsStart.getTime())
    return reject(
      `end (${end as string}) is before start (${start}). Swap them, or leave end out for an instant event.`
    );
  if (tsStart.getTime() > now.getTime() + ACTIVITY_FUTURE_SLACK_HOURS * 3_600_000)
    return reject(
      `start (${start}) is more than ${ACTIVITY_FUTURE_SLACK_HOURS} hours in the future. Check the device clock and time zone.`
    );
  const attrs = rawAttrs as Record<string, unknown>;
  const attrsProblem = describeUnstorableAttrs(attrs);
  if (attrsProblem) return reject(attrsProblem);
  const attrsBytes = byteLength(JSON.stringify(attrs));
  if (attrsBytes > ACTIVITY_ATTRS_MAX_BYTES)
    return reject(
      `attrs is ${attrsBytes} bytes; the limit is ${ACTIVITY_ATTRS_MAX_BYTES}. Keep small facts in attrs and put text in content.`
    );
  const content = rawContent as string | null;
  if (source === "derived" || source === "derived-shadow") {
    const derivedProblem = describeDerivedProblem(kind, attrs, content);
    if (derivedProblem) return reject(derivedProblem);
  }
  if (source === PHYSIOLOGY_SOURCE) {
    const physiologyProblem = describePhysiologyProblem({
      id,
      kind,
      tsStart,
      tsEnd,
      approximate: record.approximate === true,
      content,
      attrs
    });
    if (physiologyProblem) return reject(physiologyProblem);
  }
  if (content !== null) {
    const contentProblem = describeUnstorableText("content", content);
    if (contentProblem) return reject(contentProblem);
    if (byteLength(content) > ACTIVITY_CONTENT_MAX_BYTES)
      return reject(
        `content is ${byteLength(content)} bytes; the limit is ${ACTIVITY_CONTENT_MAX_BYTES}. Shorten it or split it into several events.`
      );
  }
  return {
    ok: true,
    event: {
      key: id,
      source,
      kind,
      tsStart,
      tsEnd,
      tzOffsetMin: (tzOffsetMin as number | null) ?? offsetMinutesOf(start),
      approximate: record.approximate === true,
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
  /** `scheduled` while a retention is set: the derived tick deletes expired events. `not_set` keeps the source permanently. */
  retentionPurge: "not_set" | "scheduled";
  /** The last purge of this source that deleted something (rows deleted, when), or that skipped it with the reason; null if neither has happened, and always null while the source has no retention (a record from an earlier setting is hidden). */
  lastPurge: { removed: number; at: string; skipped?: string } | null;
}

/** One extractor version of the derived layer (source `derived`), so a stale layer is visible instead of silently trusted. */
export interface ActivityExtractorSummary {
  extractor: string;
  version: string;
  /** The active version's rows are the ones reads show. False for a version not yet promoted, or one that has not run. */
  active: boolean;
  /**
   * How many source rows this extractor has not read yet: those ingested after its forward watermark plus the backfill
   * still to do (an exact count over the `(user, source, ingested_at)` index; every source row before the first run).
   * Null for an extractor this server does not know.
   */
  behind: number | null;
  /** Source messages given up on after repeated failures. */
  skipped: number;
  lastOkAt: string | null;
  lastError: string | null;
}

/** The window the per-device view looks back over. */
export const ACTIVITY_DEVICES_WINDOW_DAYS = 30;

/**
 * One device, kind and collector of a health-class source over the last 30 days, computed from the stored rows. The
 * device is `attrs.device` (physiology), else `attrs.source_name`, else the batch's `device` column (the legacy sources);
 * the collector is the token name that posted (`ingested_via`, null for the owner). "No data newer than X" is all this
 * can say: it cannot tell a device that is not worn from one that has not synced.
 */
export interface ActivityDeviceSummary {
  source: string;
  device: string | null;
  kind: string;
  ingestedVia: string | null;
  /** The latest end (start for an instant) of the rows in the window. */
  lastEventAt: string;
  lastIngestedAt: string;
  rows30d: number;
}

export interface ActivitySummary {
  /** Health-class sources by device, kind and collector, from one bounded scan of the last 30 days. */
  devices: ActivityDeviceSummary[];
  /** The sum of `behind` over the active extractors (all not-yet-run ones included): how far the derived layer lags the mail. */
  derivedBehind: number;
  extractors: ActivityExtractorSummary[];
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
  /** Present when sources were left out of this read because the token lacks `read:activity-health`: their names. */
  withheld?: string[];
  /** Present with `withheld`: the scope that is missing and how to get it. */
  withheldNote?: string;
}

/** The text shown when a source's content gate is off, so a missing `content` is never a mystery. */
export const ACTIVITY_CONTENT_GATE_NOTE =
  'Content is stored only for a source whose content gate is on (PUT /api/activity-sources/<source> with {"contentEnabled": true}).';

/**
 * The JSON Schema published for client authors (`platform/contracts/activity-events-schema.v1.json`). Regenerate the file
 * after a change: `../../engine/service/node_modules/.bin/tsx -e "import {activityEventsJsonSchema as f} from './src/activity-events.ts'; process.stdout.write(JSON.stringify(f(), null, 2) + '\n')" > activity-events-schema.v1.json`
 * (run from `platform/contracts`; `tsx` is a dependency of `engine/service`, not of contracts; `portal/server/activity-events-schema.test.ts` fails when the file is stale).
 */
export function activityEventsJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://openrhen.example/schemas/activity-events.v1.json",
    title: "OpenRhen activity events, version 1",
    description:
      "The batch body of POST /api/activity-events. It does not describe the single-event shorthand body ({source, kind, start, id?, device?, end?, attrs?, content?}) or the rules that compare fields (end not before start, start not more than 24 hours ahead, attrs under 8 KB, content under 64 KB, offsets within -14:00 to +14:00, no NUL or lone surrogate in text, one source per import); the server states each of those in the rejection text. A time with an offset sets tz_offset_min to that offset (so +00:00 gives 0; Z leaves it unknown). Events of source physiology are also held to physiology-schema.v1.json and its canonical key rule.",
    ...(withoutDatePatterns(
      z.toJSONSchema(ingestActivityEventsSchema, { io: "input", unrepresentable: "any" })
    ) as Record<string, unknown>),
    "x-sources": Object.fromEntries(
      Object.entries(ACTIVITY_SOURCES).map(([name, entry]) => [
        name,
        {
          schemaVersion: entry.schemaVersion,
          kinds: [...activityKindsOf(name)],
          ...(entry.class === undefined ? {} : { class: entry.class })
        }
      ])
    )
  };
}
