import { z } from "zod";
import { OWNER_EXPECTED_MAX_MINUTES, OWNER_EXPECTED_MIN_MINUTES } from "./data-flow/rhythm.js";
import { describeDerivedProblem } from "./activity-derived.js";
import { describeDriftProblem } from "./activity-drift.js";
import { describeDriftReasonProblem } from "./activity-drift-reason.js";
import { HIDDEN_OR_CONTROL_CHARS, MESSAGE_FAMILY, describeMessageProblem } from "./activity-message.js";
import type { MessageDuplicate } from "./activity-message-dedupe.js";
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
import { sanitizeMessageCalendarAttrs } from "./message-calendar-attrs.js";

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

/** The class of a source whose rows say where the person is or was. Reading them over a token needs `ACTIVITY_WHEREABOUTS_SCOPE`. */
export const ACTIVITY_WHEREABOUTS_CLASS = "whereabouts";
/** The scope that lets a token read whereabouts-class sources. Deliberately not offered to OAuth clients (`SCOPES_SUPPORTED`). */
export const ACTIVITY_WHEREABOUTS_SCOPE = "read:activity-whereabouts";
/** The scope that lets a token write the owner's place model (rooms, links, names): its rows will count as owner rows once the `place-owner` source maps to it. */
export const PLACE_MODEL_WRITE_SCOPE = "write:place-model";

/** The class of the drift source: flags, and which areas count as work. Reading it over a token needs `ACTIVITY_DRIFT_SCOPE`. */
export const ACTIVITY_DRIFT_CLASS = "drift";
/** The scope that lets a token read drift-class sources. Deliberately not offered to OAuth clients (`SCOPES_SUPPORTED`). A token can never write the source. */
export const ACTIVITY_DRIFT_SCOPE = "read:activity-drift";

/**
 * Sources no token can read or write, whatever scopes it holds, and that no generic activity listing shows: the owner's
 * own words (source `drift-reason`). There is deliberately no read scope for them and no class: a class is a scope
 * someone can be granted, and this is not. The owner reads them through owner-only routes.
 */
export const ACTIVITY_OWNER_ONLY_SOURCES: readonly string[] = Object.freeze(["drift-reason"]);

/** Every source class, frozen. */
export const ACTIVITY_SOURCE_CLASSES = Object.freeze([
  ACTIVITY_HEALTH_CLASS,
  ACTIVITY_WHEREABOUTS_CLASS,
  ACTIVITY_DRIFT_CLASS
] as const);
export type ActivitySourceClass = (typeof ACTIVITY_SOURCE_CLASSES)[number];

/** The read scope each class needs, beside `read:activity-event`. One table: add a class here and every helper follows. */
export const ACTIVITY_CLASS_READ_SCOPE: Readonly<Record<ActivitySourceClass, string>> = Object.freeze({
  [ACTIVITY_HEALTH_CLASS]: ACTIVITY_HEALTH_SCOPE,
  [ACTIVITY_WHEREABOUTS_CLASS]: ACTIVITY_WHEREABOUTS_SCOPE,
  [ACTIVITY_DRIFT_CLASS]: ACTIVITY_DRIFT_SCOPE
});

/**
 * A position a source supplies, declared as data so a reader holds no source names. `kind` is the row kind;
 * `accuracyAttr` names the attr holding the error radius in metres (else `defaultAccuracyM` applies); `snapped` marks
 * positions snapped to a known place; `mints` says whether the position may start a new place or only join one.
 */
export interface PositionInput {
  kind: string;
  accuracyAttr?: string;
  defaultAccuracyM: number;
  snapped: boolean;
  mints: boolean;
}

/**
 * What the hint reader may copy from a source's rows into `place_context` hints, declared as data. `nameFrom` is
 * `"content-first-line"` (only when `content` has two lines) or the name of an attr; `typeAttr` is the attr holding an
 * imported place type, whose home and work values are listed so the reader holds no enum strings. Core entries declare no type attr or values: a provider's vocabulary belongs to the overlay.
 */
export interface PlaceHintDeclaration {
  nameFrom: "content-first-line" | (string & {});
  typeAttr?: string;
  homeValues?: readonly string[];
  workValues?: readonly string[];
  inferredHomeValues?: readonly string[];
  inferredWorkValues?: readonly string[];
  listAttr?: string;
}

/** A cross-family kind: a collector's liveness report (`attrs {status, error?}`), allowed on a source whose delivery is `live` or `periodic`. */
export const ACTIVITY_HEARTBEAT_KIND = "heartbeat";
/** A cross-family kind: a claim that a window of a ledger source is complete (`attrs {complete, scope?, rev?}`), allowed on a source with a `complete` feed. */
export const ACTIVITY_COVERAGE_KIND = "coverage";
/** Kinds that belong to no family and are never listed in a source's `kinds`; each is allowed by the source's availability. */
export const ACTIVITY_CROSS_FAMILY_KINDS: readonly string[] = [ACTIVITY_HEARTBEAT_KIND, ACTIVITY_COVERAGE_KIND];

/** A heartbeat or coverage start/end may be this far ahead of `now` (device clock skew). */
export const ACTIVITY_CLOCK_SKEW_MINUTES = 5;
export const ACTIVITY_HEARTBEAT_ERROR_MAX_CHARS = 200;
export const ACTIVITY_COVERAGE_MAX_DAYS = 31;
export const ACTIVITY_COVERAGE_SCOPE_MAX_CHARS = 128;
/** A coverage window must start after this instant. */
export const ACTIVITY_COVERAGE_FLOOR = new Date("1990-01-01T00:00:00.000Z");
/** In a live (non-import) batch a coverage window must start within this many days of `now`. */
export const ACTIVITY_COVERAGE_LIVE_DAYS = 400;

/** The neutral family of message sources. A source in it may always post a heartbeat and a coverage row. */
export const ACTIVITY_MESSAGE_FAMILY = MESSAGE_FAMILY;

export interface ActivitySourceEntry {
  /** Bumped when the meaning of a source's kinds or attrs changes, so the predictor can tell old rows from new. */
  schemaVersion: number;
  kinds: readonly string[];
  /** Optional. A token reads a classed source only with that class's scope (`ACTIVITY_CLASS_READ_SCOPE`) as well as `read:activity-event`. */
  class?: ActivitySourceClass;
  /** The one family the source posts (a name and version, e.g. `name@1`); absent for legacy sources. */
  family?: `${string}@${number}`;
  /** How the source reaches us and what it supplies; absent for legacy sources and for projections such as `derived`. */
  availability?: SourceAvailability;
  /** Kinds that are read out of other events (clusters, stays) rather than sensed: they feed no signal, take a derived write scope and are deleted with their inputs. */
  projectionKinds?: readonly string[];
  /** Positions this source supplies, for the stay detector. Absent: the source supplies none. */
  positionInputs?: readonly PositionInput[];
  /** Attr names whose value is a stable place id from the export; the place extractor joins on them. */
  extIdAttrs?: readonly string[];
  /** What the hint reader may copy out of this source's rows. */
  placeHints?: PlaceHintDeclaration;
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
      "off",
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
  "maps-places": {
    schemaVersion: 1,
    kinds: ["place"],
    placeHints: { nameFrom: "name", listAttr: "list" }
  },
  fit: { schemaVersion: 1, kinds: ["steps", "activity"] },
  // Takeout Timeline. place_visit/activity_segment have an end; point is an instant. attrs: lat, lng, place_id, ...; content is the place name and address.
  timeline: {
    schemaVersion: 1,
    kinds: ["place_visit", "activity_segment", "point"],
    positionInputs: [
      { kind: "point", accuracyAttr: "accuracy_m", defaultAccuracyM: 50, snapped: false, mints: true },
      { kind: "place_visit", defaultAccuracyM: 50, snapped: true, mints: true }
    ],
    extIdAttrs: ["place_id"],
    placeHints: { nameFrom: "content-first-line" }
  },
  // Takeout Google Chat. Reuses the gmail attrs shape (thread_id = space id, from, from_self, direction); content is the message text.
  "google-chat": { schemaVersion: 1, kinds: ["message"] },
  // Takeout Access Log Activity. attrs: product, activity_type only; the IP address and user-agent are never read.
  "google-access-log": { schemaVersion: 1, kinds: ["access"] },
  // Takeout Google Photos sidecar metadata only (never the media). attrs: lat, lng, uploaded_at; content is the file name and description.
  "google-photos": {
    schemaVersion: 1,
    kinds: ["photo", "video"],
    // Photo positions only join places that other sources found; they never start one.
    positionInputs: [
      { kind: "photo", defaultAccuracyM: 50, snapped: false, mints: false },
      { kind: "video", defaultAccuracyM: 50, snapped: false, mints: false }
    ]
  },
  spotify: { schemaVersion: 1, kinds: ["play"] },
  "discord-package": { schemaVersion: 1, kinds: ["message"] },
  "apple-health": { schemaVersion: 1, kinds: ["sleep", "workout", "steps"], class: ACTIVITY_HEALTH_CLASS },
  steam: { schemaVersion: 1, kinds: ["session"] },
  weather: { schemaVersion: 1, kinds: ["observation"] },
  // attrs: thread_id, gmail_id, from, to[], from_self, direction (in|out), labels[], subject; content is the stripped body (gated).
  // Discord and notification messages reuse this attrs shape, with thread_id the channel id. The source's header and
  // calendar attrs (auth, ics, jsonld, and the ics event time) are described in message-calendar-attrs.ts, which drops a malformed one and
  // notes it in attrs.calendar_dropped instead of rejecting the message.
  // It reports liveness (heartbeat) and how far it has read (coverage); it supplies no signal, so its feeds are empty.
  gmail: {
    schemaVersion: 1,
    kinds: ["message"],
    availability: {
      delivery: "periodic",
      origin: "account",
      feeds: [],
      recoveryHint:
        "Check that the message collector is running and signed in, then post a heartbeat (POST /api/activity-events with kind heartbeat) to confirm it is alive."
    }
  },
  // Rows read out of other events by a versioned reader. msg_class and fact name their source_event_id; fact_status,
  // override and label name a fact_id. A status change is a later fact_status row (rows are never updated). Per-kind
  // attrs are validated in activity-derived.ts; a derived row never carries the raw body.
  derived: { schemaVersion: 1, kinds: ["msg_class", "fact", "fact_status", "override", "label"] },
  // Rows a not-yet-promoted extractor version writes so two versions can be compared on the eval set before one is
  // promoted: extractor output only (msg_class, fact), under the same validators as `derived`, and no `correction`
  // kind. A status, override or label is never stored here for any writer. Reads of `derived` never show these rows,
  // and only the in-process runner path and a write:activity-derived token write them. Not a user-facing shadow mode.
  "derived-shadow": { schemaVersion: 1, kinds: ["msg_class", "fact"] },
  // The drift detector's own rows (docs/architecture/drift.md): shadow flags, and whether an area counts as work (inferred by
  // the local model, or corrected by the owner). Written in-process or by the owner session only, read by the owner
  // only (class `drift`), and never open to a token. Per-kind attrs are validated in activity-drift.ts.
  drift: { schemaVersion: 1, kinds: ["flag", "work_label"], class: ACTIVITY_DRIFT_CLASS },
  // The owner's own words about a deviated check-in ("What pulled you off?") and the short tags put on them. Private free
  // text, so unlike `drift` it has no class and no read scope: ACTIVITY_OWNER_ONLY_SOURCES keeps it out of every
  // generic read, and no token may write it. Per-kind attrs are validated in activity-drift-reason.ts.
  "drift-reason": { schemaVersion: 1, kinds: ["reason", "reason_tag"] },
  // The phone app's own liveness: a generic collector that delivers live from the phone. It posts only `heartbeat`
  // (one row per install, key `hb:<device>:<UTC hour>:<status>`) and supplies no signal of its own, so `kinds` and
  // `feeds` are empty. Its body-signal rows go to `physiology`; its place and motion kinds are separate work.
  phone: {
    schemaVersion: 1,
    kinds: [],
    availability: {
      delivery: "live",
      origin: "phone",
      feeds: [],
      recoveryHint:
        "Open the phone app so it wakes and posts a heartbeat, and check its Sources screen for a sign-in or network problem."
    }
  },
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

/** The sources of one class, sorted. */
export function activitySourcesOfClass(sourceClass: ActivitySourceClass): string[] {
  return Object.entries(ACTIVITY_SOURCES)
    .filter(([, entry]) => entry.class === sourceClass)
    .map(([name]) => name)
    .sort();
}

/** The sources of class `health`, sorted. */
export function activityHealthSources(): string[] {
  return activitySourcesOfClass(ACTIVITY_HEALTH_CLASS);
}

/**
 * The classed sources a read must leave out for these token scopes, grouped by class (a class with nothing withheld is
 * absent). `undefined` scopes (the owner, an environment token, a background writer) withhold nothing; a token without
 * a class's read scope withholds every source of that class.
 */
export function withheldActivityClasses(
  scopes: readonly string[] | undefined,
  sourcesOfClass: (sourceClass: ActivitySourceClass) => string[] = activitySourcesOfClass
): Partial<Record<ActivitySourceClass, string[]>> {
  const withheld: Partial<Record<ActivitySourceClass, string[]>> = {};
  if (scopes === undefined) return withheld;
  for (const sourceClass of ACTIVITY_SOURCE_CLASSES) {
    const needed = ACTIVITY_CLASS_READ_SCOPE[sourceClass];
    if (scopes.some((held) => scopeCovers(held, needed))) continue;
    const sources = sourcesOfClass(sourceClass);
    if (sources.length > 0) withheld[sourceClass] = sources;
  }
  return withheld;
}

/** The classed sources a read must leave out for these token scopes, sorted. */
export function withheldActivitySources(scopes: readonly string[] | undefined): string[] {
  return Object.values(withheldActivityClasses(scopes)).flat().sort();
}

/** Groups withheld source names by their class; a source with no class is left out of the result. */
export function groupWithheldByClass(sources: readonly string[]): Partial<Record<ActivitySourceClass, string[]>> {
  const grouped: Partial<Record<ActivitySourceClass, string[]>> = {};
  for (const source of sources) {
    const sourceClass = activitySourceEntry(source)?.class;
    if (sourceClass !== undefined) (grouped[sourceClass] ??= []).push(source);
  }
  return grouped;
}

/**
 * The text that names why sources were left out of a read: which classes, and the scopes that would let a token read them.
 */
export function describeWithheldClasses(withheld: Partial<Record<ActivitySourceClass, string[]>>): string {
  const classes = ACTIVITY_SOURCE_CLASSES.filter((sourceClass) => withheld[sourceClass] !== undefined);
  const scopes = classes.map((sourceClass) => ACTIVITY_CLASS_READ_SCOPE[sourceClass]);
  const kinds = classes.join(" and ");
  return `These sources hold ${kinds} data and are left out: this token lacks the ${scopes.join(" and ")} scope. Create a token with --scopes read:activity-event,${scopes.join(",")} to read them.`;
}

const FAMILY_REF = /^[a-z0-9][a-z0-9-]*@[1-9][0-9]*$/;
/** Families an extension source may name. Slice 1.3 replaces this with the family registry. `message@1` is the neutral message family (activity-message.ts). */
export const KNOWN_ACTIVITY_FAMILIES: ReadonlySet<string> = new Set<string>([MESSAGE_FAMILY]);

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

/** Sources that take no `correction` row: one kind of output only (`derived-shadow`), or corrections that are rows of their own kind (`drift` work labels). */
const NO_CORRECTIONS: readonly string[] = ["derived-shadow", "drift", "drift-reason"];

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
  /** Message copies not stored because another source already holds the message (or an earlier event of this batch does). Each also counts in `alreadyHeld`. Empty for every other event. */
  duplicates: MessageDuplicate[];
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
export function validateActivityEvent(
  raw: unknown,
  now: Date,
  options: ActivityEventOptions = {}
): ActivityEventVerdict {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return reject(
      'Each event must be an object like {"id": "...", "source": "...", "kind": "...", "start": "2026-11-07T14:02:11Z"}.'
    );
  const record = raw as Record<string, unknown>;
  const source = record.source;
  const registry = options.registry;
  const entry =
    typeof source !== "string"
      ? undefined
      : registry
        ? Object.hasOwn(registry, source)
          ? registry[source]
          : undefined
        : activitySourceEntry(source);
  if (typeof source !== "string" || !entry)
    return reject(
      `source ${typeof source === "string" ? `"${source.slice(0, 60)}" is not known` : "is missing"}. Use one of: ${(registry ? Object.keys(registry) : ACTIVITY_SOURCE_NAMES).join(", ")}.`
    );
  const kinds = registry
    ? NO_CORRECTIONS.includes(source)
      ? [...entry.kinds]
      : [...entry.kinds, ACTIVITY_CORRECTION_KIND]
    : activityKindsOf(source);
  const kind = record.kind;
  const crossFamily = typeof kind === "string" && ACTIVITY_CROSS_FAMILY_KINDS.includes(kind);
  if (crossFamily) {
    const allowed = describeCrossFamilyKindProblem(source, kind, entry);
    if (allowed) return reject(allowed);
  } else if (typeof kind !== "string" || !kinds.includes(kind))
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
  let attrs = rawAttrs as Record<string, unknown>;
  // A mail message with a malformed calendar attr is stored without that attr and with a note, never rejected.
  if (source === "gmail") attrs = sanitizeMessageCalendarAttrs(attrs).attrs;
  const attrsProblem = describeUnstorableAttrs(attrs);
  if (attrsProblem) return reject(attrsProblem);
  if (crossFamily) {
    const problem =
      kind === ACTIVITY_HEARTBEAT_KIND
        ? describeHeartbeatProblem(id, tsStart, attrs, now, options.device)
        : describeCoverageProblem(
            id,
            tsStart,
            tsEnd,
            attrs,
            now,
            options.live !== false,
            options.scopeRequired?.(source) === true
          );
    if (problem) return reject(problem);
    if (rawContent !== null) return reject(`${kind} takes no content. Leave content out.`);
  }
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
  if (source === "drift") {
    const driftProblem = describeDriftProblem({ id, kind, tsStart, tsEnd, attrs, content });
    if (driftProblem) return reject(driftProblem);
  }
  if (source === "drift-reason") {
    const reasonProblem = describeDriftReasonProblem({ id, kind, tsEnd, attrs, content });
    if (reasonProblem) return reject(reasonProblem);
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
  if (entry.family === MESSAGE_FAMILY && kind === "message") {
    const verdict = describeMessageProblem({ id, kind, tsStart, tsEnd, content, attrs });
    if (!verdict.ok) return reject(verdict.reason);
    // The tidied attrs and the computed fingerprint (taken from the raw content, before any content gate) are what is stored.
    attrs = verdict.attrs;
    const messageBytes = byteLength(JSON.stringify(attrs));
    if (messageBytes > ACTIVITY_ATTRS_MAX_BYTES)
      return reject(
        `attrs is ${messageBytes} bytes; the limit is ${ACTIVITY_ATTRS_MAX_BYTES}. Keep small facts in attrs and put text in content.`
      );
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

/** What `validateActivityEvent` needs beyond the event: where the source is looked up, and the batch it came in. */
export interface ActivityEventOptions {
  /** The sources to judge against; default the merged core and extension registry. */
  registry?: Readonly<Record<string, ActivitySourceEntry>> | undefined;
  /** The batch's `device`, which a heartbeat key names; absent gives `_`. */
  device?: string | null | undefined;
  /** False for an import (a file), true (default) for a live batch; only coverage time bounds differ. */
  live?: boolean | undefined;
  /** True when the source's family scopes coverage (`scopeAttr`), so a coverage row must carry `attrs.scope`. */
  scopeRequired?: ((source: string) => boolean) | undefined;
}

/**
 * True when a coverage row of this entry must name its `attrs.scope` (the account or channel it covers): a message-family
 * source, or any source that declares availability with no feeds (the mail source). Without a scope, a collector reading
 * two accounts would let a window of one account hide silence on the other.
 */
export function coverageScopeRequiredFor(entry: ActivitySourceEntry | undefined): boolean {
  if (!entry) return false;
  return entry.family === ACTIVITY_MESSAGE_FAMILY || entry.availability?.feeds.length === 0;
}

function describeCrossFamilyKindProblem(source: string, kind: string, entry: ActivitySourceEntry): string | undefined {
  const availability = entry.availability;
  const message = entry.family === ACTIVITY_MESSAGE_FAMILY;
  const own = entry.kinds[0];
  if (kind === ACTIVITY_HEARTBEAT_KIND) {
    if (message || availability?.delivery === "live" || availability?.delivery === "periodic") return undefined;
    return `heartbeat is not accepted for source "${source}": only a source that delivers live or periodically takes one. Send ${own ? `an event of kind "${own}"` : "this source's own events"} now; to report liveness for this source, tell the owner its registry entry must declare availability (delivery live or periodic).`;
  }
  // A source with availability and no feeds supplies no signal, so coverage there only says how far it has been read.
  if (message || availability?.feeds.some((feed) => feed.complete === true) || availability?.feeds.length === 0)
    return undefined;
  return `coverage is not accepted for source "${source}": only a source with a complete (ledger) feed, or a message source, takes one. ${own ? `Send an event of kind "${own}" now` : "Send this source's own events now"}; to report coverage for this source, tell the owner its registry entry must declare availability (a complete feed, or no feeds) or name the family ${MESSAGE_FAMILY}.`;
}

const unknownAttrs = (attrs: Record<string, unknown>, allowed: readonly string[]) => {
  const extra = Object.keys(attrs).find((key) => !allowed.includes(key));
  return extra === undefined
    ? undefined
    : `attrs "${extra.slice(0, 60)}" is not allowed here. Allowed: ${allowed.join(", ")}.`;
};

/** The heartbeat key a batch from `device` must use for a heartbeat at `start` with `status`. */
export function heartbeatKey(device: string | null | undefined, start: Date, status: string): string {
  return `hb:${device ?? "_"}:${start.toISOString().slice(0, 13)}:${status}`;
}

/** The coverage key for a window; times are canonical (milliseconds, `Z`), so `Z` and `+00:00` agree. */
export function coverageKey(scope: string | undefined, start: Date, end: Date, rev?: number): string {
  return `cov:${scope ?? "_"}:${start.toISOString()}:${end.toISOString()}${rev === undefined ? "" : `:r${rev}`}`;
}

function describeHeartbeatProblem(
  id: string,
  start: Date,
  attrs: Record<string, unknown>,
  now: Date,
  device: string | null | undefined
): string | undefined {
  const extra = unknownAttrs(attrs, ["status", "error"]);
  if (extra) return extra;
  const status = attrs.status;
  if (status !== "ok" && status !== "error") return 'attrs.status must be "ok" or "error".';
  const error = attrs.error;
  if (error !== undefined && (typeof error !== "string" || error.length > ACTIVITY_HEARTBEAT_ERROR_MAX_CHARS))
    return `attrs.error must be text of at most ${ACTIVITY_HEARTBEAT_ERROR_MAX_CHARS} characters, or left out.`;
  if (start.getTime() > now.getTime() + ACTIVITY_CLOCK_SKEW_MINUTES * 60_000)
    return `heartbeat start (${start.toISOString()}) is more than ${ACTIVITY_CLOCK_SKEW_MINUTES} minutes in the future. Check the device clock.`;
  const expected = heartbeatKey(device, start, status);
  if (id !== expected)
    return `heartbeat id "${id.slice(0, 80)}" must be "${expected}". The key names the batch device (${device ? `"${device}"` : 'none sent, so "_"'}) and the hour, so send "device" at the top of the batch and use that key.`;
  return undefined;
}

/**
 * A coverage scope may not hold the characters `HIDDEN_OR_CONTROL_CHARS` lists (the same subset as the agent evidence
 * rule; ZWNJ and ZWJ stay legal for non-Latin names), nor ":" (the id is cov:<scope>:<start>:<end>). Scope is compared
 * exactly and case-sensitively ("Inbox" and "inbox" are two scopes): it is part of the coverage id, so folding it would
 * silently alias windows a collector keeps apart.
 */
function describeCoverageProblem(
  id: string,
  start: Date,
  end: Date | null,
  attrs: Record<string, unknown>,
  now: Date,
  live: boolean,
  scopeRequired: boolean
): string | undefined {
  if (end === null)
    return "coverage needs an end: send the window as start and end, such as the statement period or the span just checked.";
  if (end.getTime() <= start.getTime())
    return `coverage end (${end.toISOString()}) must be after start (${start.toISOString()}).`;
  if (end.getTime() - start.getTime() > ACTIVITY_COVERAGE_MAX_DAYS * 86_400_000)
    return `coverage window is longer than ${ACTIVITY_COVERAGE_MAX_DAYS} days. Send several windows.`;
  if (end.getTime() > now.getTime() + ACTIVITY_CLOCK_SKEW_MINUTES * 60_000)
    return `coverage end (${end.toISOString()}) is more than ${ACTIVITY_CLOCK_SKEW_MINUTES} minutes in the future. Cover only what has been checked.`;
  if (start.getTime() <= ACTIVITY_COVERAGE_FLOOR.getTime())
    return `coverage start (${start.toISOString()}) must be after ${ACTIVITY_COVERAGE_FLOOR.toISOString().slice(0, 10)}.`;
  if (live && start.getTime() < now.getTime() - ACTIVITY_COVERAGE_LIVE_DAYS * 86_400_000)
    return `coverage start (${start.toISOString()}) is more than ${ACTIVITY_COVERAGE_LIVE_DAYS} days ago; send older windows inside an import.`;
  const extra = unknownAttrs(attrs, ["complete", "scope", "rev"]);
  if (extra) return extra;
  if (attrs.complete !== true) return "attrs.complete must be true: a coverage row only declares a complete window.";
  const scope = attrs.scope;
  const scopeFix = `Add "scope": "<name>" to attrs and use the id ${coverageKey("<name>", start, end, undefined)}.`;
  const scopeWhy =
    "the account, mailbox or channel the window covers, so one account's window cannot hide silence on another";
  if (scope === undefined || (typeof scope === "string" && scope.trim() === "")) {
    if (scopeRequired)
      return `attrs.scope is required for this source (${scopeWhy}) and must not be blank. ${scopeFix}`;
    if (scope !== undefined) return "attrs.scope must not be blank: name the account or channel, or leave it out.";
  } else if (typeof scope !== "string" || scope.length > ACTIVITY_COVERAGE_SCOPE_MAX_CHARS)
    return `attrs.scope must be text of 1 to ${ACTIVITY_COVERAGE_SCOPE_MAX_CHARS} characters, or left out.`;
  else if (HIDDEN_OR_CONTROL_CHARS.test(scope))
    return "attrs.scope must not contain control, hidden or text-reordering characters (zero-width space, word joiner, byte order mark, bidirectional overrides and isolates, tag characters); name the account or channel in plain text.";
  else if (scope.includes(":"))
    return 'attrs.scope must not contain ":" (the coverage id is cov:<scope>:<start>:<end>, so a colon would make it ambiguous). Use a name such as "inbox-main".';
  else if (scope !== scope.trim()) return "attrs.scope must not start or end with spaces. Send it trimmed.";
  const rev = attrs.rev;
  if (rev !== undefined && (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1))
    return "attrs.rev must be a whole number of 1 or more, or left out.";
  const expected = coverageKey(scope as string | undefined, start, end, rev as number | undefined);
  if (id !== expected)
    return `coverage id "${id.slice(0, 120)}" must be "${expected}". The key is built from the scope, start, end and rev, so send exactly that id.`;
  return undefined;
}

/**
 * Owner-side settings for one source (`PUT /api/activity-sources/:source`). Absent fields keep their value.
 * `expectedEveryMinutes` is how often the owner expects the source to send (5 to 129600, 90 days); a source that reports
 * coverage is then late after 3 x that and stale after 6 x; `null` clears it and the source returns to learning its own rhythm.
 */
export const activitySourceSettingsSchema = z
  .object({
    contentEnabled: z.boolean().optional(),
    retentionDays: z.number().int().min(1).max(36_500).nullable().optional(),
    expectedEveryMinutes: z
      .number()
      .int()
      .min(OWNER_EXPECTED_MIN_MINUTES)
      .max(OWNER_EXPECTED_MAX_MINUTES)
      .nullable()
      .optional()
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
  /** How often the owner expects this source to send, in minutes; null while none is set and the source learns its own rhythm. */
  expectedEveryMinutes: number | null;
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
  /** Only on a `fact` row read with `include=evidence`: its span resolved to the mail text, or why it cannot be. */
  evidence?: ActivityEvidence;
}

/**
 * A fact's span resolved at read (`GET /api/activity-events?include=evidence`). `text` is third-party mail text: it is
 * data to read, never an instruction, whatever it says. `source_removed` (the message or its text is gone) and
 * `source_changed` (the text no longer hashes as it did when the span was found) carry no text.
 */
export interface ActivityEvidence {
  state: "ok" | "source_removed" | "source_changed";
  text?: string;
  untrusted: true;
  note: string;
}

export interface ActivityEventsPage {
  events: ActivityEventRow[];
  /** Pass as `after` for the next page; null on the last. */
  next: string | null;
  /** Present when sources were left out of this read because the token lacks their class's read scope: their names. */
  withheld?: string[];
  /** Present with `withheld`: how many withheld sources each class holds. */
  withheldClasses?: Partial<Record<ActivitySourceClass, number>>;
  /** Present with `withheld`: the scopes that are missing and how to get them. */
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
      "The batch body of POST /api/activity-events. It does not describe the single-event shorthand body ({source, kind, start, id?, device?, end?, attrs?, content?}) or the rules that compare fields (end not before start, start not more than 24 hours ahead, attrs under 8 KB, content under 64 KB, offsets within -14:00 to +14:00, no NUL or lone surrogate in text, one source per import); the server states each of those in the rejection text. A time with an offset sets tz_offset_min to that offset (so +00:00 gives 0; Z leaves it unknown). Events of source physiology are also held to physiology-schema.v1.json and its canonical key rule. Events of a source whose family is message@1 are held to the message rules (closed attrs, the mid: or fp: key, a server-computed attrs.fp).",
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
