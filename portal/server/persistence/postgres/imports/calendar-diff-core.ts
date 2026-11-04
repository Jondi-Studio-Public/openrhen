import type { ImportField, ImportRecord } from "@openrhen/contracts";
import type { Sql } from "../sql-pool";

/**
 * What every calendar-sourced diff (the calendar provider, the roster provider, Google Calendar and others) shares: the
 * import-field and snapshot helpers, saved-place matching and buffer defaults, declined-delete
 * bookkeeping, and the one writer that links a written commitment to its calendar event.
 */

/** A saved location, as `condition_definitions` rows read for one: name, buffers, default routine. */
export interface LocationRow {
  id: string;
  name: string;
  setup_before_minutes?: number | null;
  transition_after_minutes?: number | null;
  default_routine_preset_id?: string | null;
}

export interface BufferDefaults {
  default_setup_buffer_minutes: number;
  default_transition_buffer_minutes: number;
}

/** A `calendar_event_links` row joined onto its fixed commitment. */
export interface LinkRow {
  /** The link's own id, present on rows read from `calendar_event_links`; what an unlink names. */
  id?: string;
  external_event_id: string;
  commitment_id: string;
  version: number;
  last_remote_snapshot: Record<string, unknown> | null;
  title: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
  /** How the commitment was closed, when it is cancelled: what tells a cancel the source made from the person's own. */
  closed_by?: string | null | undefined;
  closed_reason?: string | null | undefined;
  closed_from_status?: string | null | undefined;
  location: string | null;
  setup_before_minutes: number;
  transition_after_minutes: number;
}

/** A `calendar_event_dismissals` row: keyed by the event id, or `series:<seriesId>` for a whole series. */
export interface DismissalRow {
  external_event_id: string;
  title: string;
  starts_at: Date;
}

/** The fields both a create and an update diff over; shared by every calendar source, whose remote has
 * no buffer or place concept of its own. */
export const commitmentFields = [
  "title",
  "startsAt",
  "endsAt",
  "status",
  "location",
  "setupBeforeMinutes",
  "transitionAfterMinutes"
] as const;

export function importField(value: unknown, evidence: string[]): ImportRecord["fields"][string] {
  return value === null || value === undefined
    ? { value: null, basis: "missing", confidence: null, evidence, needsReview: false }
    : { value, basis: "explicit", confidence: "high", evidence, needsReview: false };
}

/** A saved place an event's free-text location appears to name, and how sure the reading is. */
export interface LocationMatch {
  location: LocationRow;
  confidence: "high" | "medium" | "low";
  /** Whether the review must confirm it: only a name said exactly is taken as said. */
  needsReview: boolean;
  evidence: string;
}

/** Lowercase words with punctuation dropped, so `St. Mary's Clinic` and `st marys clinic` read alike. */
function normaliseWords(value: string): string[] {
  return value
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Levenshtein distance, for names a calendar spelled slightly differently from the catalogue. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1)
      row.push(Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    previous = row;
  }
  return previous[b.length]!;
}

/** Every run of `length` consecutive words of `words`, joined back into one string. */
function wordRuns(words: string[], length: number): string[] {
  const runs: string[] = [];
  for (let start = 0; start + length <= words.length; start += 1)
    runs.push(words.slice(start, start + length).join(" "));
  return runs;
}

/**
 * How closely a saved place's name reads in an event's location text: 0 said exactly, 1 the name
 * appearing as a whole run of words inside it, 2 a run within two edits of it. Anything else is not
 * a match. Ranks, not scores, so the tiers stay comparable across names of different lengths.
 */
function locationMatchRank(text: string, name: string): 0 | 1 | 2 | undefined {
  if (text.trim().toLowerCase() === name.trim().toLowerCase()) return 0;
  const words = normaliseWords(text);
  const nameWords = normaliseWords(name);
  if (!words.length || !nameWords.length) return undefined;
  const runs = wordRuns(words, nameWords.length);
  const joined = nameWords.join(" ");
  if (runs.includes(joined)) return 1;
  return runs.some((run) => editDistance(run, joined) <= 2) ? 2 : undefined;
}

/**
 * Which saved place an event's free-text location names. An exact name is taken as said and offered
 * at high confidence; anything looser is a proposal the review must confirm, never a silent commit —
 * the name appearing whole inside the text is medium, a near-spelling of it low. Ties go to the
 * longest name, then to the lowest id, so the same event and the same catalogue always agree.
 */
export function matchLocation(
  text: string | null | undefined,
  locations: readonly LocationRow[]
): LocationMatch | undefined {
  const value = String(text ?? "").trim();
  if (!value) return undefined;
  const ranked = locations
    .map((location) => ({ location, rank: locationMatchRank(value, String(location.name)) }))
    .filter((candidate): candidate is { location: LocationRow; rank: 0 | 1 | 2 } => candidate.rank !== undefined)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        String(b.location.name).length - String(a.location.name).length ||
        String(a.location.id).localeCompare(String(b.location.id))
    );
  const best = ranked[0];
  if (!best) return undefined;
  return {
    location: best.location,
    confidence: best.rank === 0 ? "high" : best.rank === 1 ? "medium" : "low",
    needsReview: best.rank > 0,
    evidence:
      best.rank === 0
        ? `The event location "${value}" is the saved place ${best.location.name}`
        : `The event location "${value}" looks like the saved place ${best.location.name} — confirm it`
  };
}

/** The place field a calendar-sourced record carries: the match prefilled, or blank when nothing looks like one. */
export function locationField(match: LocationMatch | undefined): ImportField {
  if (!match) return { value: null, basis: "missing", confidence: null, evidence: [], needsReview: false };
  return {
    value: match.location.id,
    basis: "inferred",
    confidence: match.confidence,
    evidence: [match.evidence],
    needsReview: match.needsReview
  };
}

/**
 * Saved-place matching for a calendar diff: the place an event's free text names exactly (for the buffers
 * it takes), and the import field that carries the looser match for review.
 */
export const savedPlaceMatching = {
  row: (text: string | null, locations: readonly LocationRow[]) =>
    locations.find(
      (item) =>
        String(item.name).toLowerCase() ===
        String(text ?? "")
          .trim()
          .toLowerCase()
    ),
  field: (text: string | null, locations: readonly LocationRow[]) => locationField(matchLocation(text, locations))
};

function bufferDefaults(location: LocationRow | undefined, defaults?: BufferDefaults) {
  return {
    before: location?.setup_before_minutes ?? defaults?.default_setup_buffer_minutes ?? 0,
    after: location?.transition_after_minutes ?? defaults?.default_transition_buffer_minutes ?? 0,
    evidence: location ? [`Applied from saved location ${location.name}`] : ["Applied from portal-wide buffer defaults"]
  };
}

export function applySeriesLocationDefaults(
  record: ImportRecord,
  location: LocationRow | undefined,
  locationId: ImportField,
  defaults?: BufferDefaults
): ImportRecord {
  const { before, after, evidence } = bufferDefaults(location, defaults);
  return {
    ...record,
    fields: {
      ...record.fields,
      locationId,
      setupBeforeMinutes: importField(before, evidence),
      transitionAfterMinutes: importField(after, evidence)
    }
  };
}

export function applyStoredLocationDefaults(
  record: ImportRecord,
  location: LocationRow | undefined,
  locationId: ImportField,
  steps: any[],
  dependencies: any[],
  defaults?: BufferDefaults
): ImportRecord {
  const { before, after, evidence } = bufferDefaults(location, defaults);
  const preset = location?.default_routine_preset_id;
  const routineSteps = preset
    ? steps
        .filter((step) => step.preset_id === preset)
        .map((step) => ({
          id: step.id,
          title: step.title,
          durationMinutes: step.duration_minutes,
          sequence: step.sequence,
          timingRule: step.timing_rule,
          maxLeadMinutes: step.max_lead_minutes ?? undefined,
          waitAfterMinutes: step.wait_after_minutes ?? undefined,
          mustStartByMinutes: step.must_start_by_minutes ?? undefined,
          preferredBands: Array.isArray(step.preferred_bands) ? step.preferred_bands : undefined,
          energy: step.energy,
          contexts: Array.isArray(step.contexts) ? step.contexts : [],
          dependencyIds: dependencies.filter((edge) => edge.step_id === step.id).map((edge) => edge.depends_on_step_id)
        }))
    : [];
  return {
    ...record,
    fields: {
      ...record.fields,
      locationId,
      setupBeforeMinutes: importField(before, evidence),
      transitionAfterMinutes: importField(after, evidence)
    },
    relationships: {
      ...record.relationships,
      locationProfileId: location?.id ?? null,
      routinePresetId: preset ?? null,
      routineSteps: routineSteps.length ? JSON.stringify(routineSteps) : null
    }
  };
}

export function currentSnapshot(row: LinkRow) {
  return {
    title: row.title,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    status: row.status,
    location: row.location,
    setupBeforeMinutes: row.setup_before_minutes,
    transitionAfterMinutes: row.transition_after_minutes
  };
}

/** The dismissal id a declined delete of one linked event is remembered under. */
export function declinedDeleteId(eventKey: string): string {
  return `delete:${eventKey}`;
}

/**
 * Deletes held only for safety that the owner declined, remembered with the linked event's last known
 * title and start: the next run does not ask again while the link still describes that same event.
 * `importPrefix` is the provider's single-event import key prefix (`google_calendar:event:`).
 */
export function declinedDeleteDismissals(
  records: Pick<ImportRecord, "importKey" | "operation" | "removed" | "relationships" | "fields">[],
  importPrefix: string,
  mode: "deselected" | "all"
): { externalEventId: string; title: string; startsAt: string }[] {
  const out: { externalEventId: string; title: string; startsAt: string }[] = [];
  for (const record of records) {
    if (record.operation !== "delete" || record.relationships.remoteCancelEdited) continue;
    if ((mode === "deselected" && !record.removed) || !record.importKey.startsWith(importPrefix)) continue;
    const title = record.fields.title?.value;
    const startsAt = record.fields.startsAt?.value;
    if (typeof title !== "string" || typeof startsAt !== "string") continue;
    out.push({ externalEventId: declinedDeleteId(record.importKey.slice(importPrefix.length)), title, startsAt });
  }
  return out;
}

/** Whether the owner already declined deleting this link while it still describes the same event. */
export function isDeleteDeclined(
  eventKey: string,
  snapshot: { title?: unknown; startsAt?: unknown } | null,
  dismissals: ReadonlyMap<string, DismissalRow>
): boolean {
  const declined = dismissals.get(declinedDeleteId(eventKey));
  if (!declined || typeof snapshot?.startsAt !== "string") return false;
  return (
    declined.title === snapshot.title && new Date(snapshot.startsAt).toISOString() === declined.starts_at.toISOString()
  );
}

export function withinRange(startsAt: string, dateStart: string, dateEnd: string) {
  const day = startsAt.slice(0, 10);
  return day >= dateStart && day <= dateEnd;
}

export interface CalendarDismissalInsert {
  externalEventId: string;
  title: string;
  startsAt: string;
}

/**
 * "Keep it" on a delete held because the commitment was edited here (`remoteCancelEdited`) means the
 * commitment is the owner's now: its link to the calendar event is dropped, so the next run neither
 * asks again nor follows the event. A delete held only for safety (a missing event, the mass-delete
 * guard) keeps its link, so an event that comes back updates the commitment instead of duplicating
 * it; declining one is remembered by `declinedDeleteDismissals` instead.
 */
export async function releaseKeptCalendarLinks(
  sql: Sql,
  userId: string,
  provider: string,
  records: Pick<ImportRecord, "operation" | "removed" | "matchedEntityId" | "relationships">[],
  which: "deselected" | "all"
) {
  const kept = records
    .filter(
      (record) =>
        (which === "all" || record.removed) &&
        record.matchedEntityId &&
        Boolean(record.relationships.remoteCancelEdited)
    )
    .map((record) => record.matchedEntityId!);
  if (!kept.length) return;
  await sql`DELETE FROM calendar_event_links WHERE user_id=${userId} AND provider=${provider} AND commitment_id::text IN ${sql(kept)}`;
}

/** Remembers rejected events so the next run does not propose them again (until they change). */
export async function recordCalendarDismissals(
  sql: Sql,
  userId: string,
  provider: string,
  dismissals: CalendarDismissalInsert[]
) {
  for (const dismissal of dismissals)
    await sql`INSERT INTO calendar_event_dismissals(user_id,provider,external_event_id,title,starts_at) VALUES(${userId},${provider},${dismissal.externalEventId},${dismissal.title},${new Date(dismissal.startsAt)}) ON CONFLICT(user_id,provider,external_event_id) DO UPDATE SET title=EXCLUDED.title,starts_at=EXCLUDED.starts_at,updated_at=CURRENT_TIMESTAMP,version=calendar_event_dismissals.version+1`;
}

/** What a source-and-link write needs; each provider builds these exactly as its diff reads them back. */
export interface CalendarEventLinkArgs {
  commitmentId: string;
  provider: string;
  role: "primary" | "secondary";
  /** The `sources.source_type` this event is recorded under. */
  sourceType: string;
  /** The `sources.external_id`; Google keys it by its own event key, which differs from the link's. */
  sourceExternalId: string;
  /** The `calendar_event_links.external_event_id`. */
  linkExternalId: string;
  frameId: string;
  profileLabel: string | null;
  sourceCalendarId: string | null;
  /** The `sources.captured_text`, already serialised. */
  capturedText: string;
  /** The `calendar_event_links.last_remote_snapshot` the next diff compares to. */
  snapshot: unknown;
  hash: string;
  title: string;
  occurredAt: Date;
}

/**
 * After a calendar-sourced commitment is written: records the event as a source, points the
 * commitment at it, and upserts the calendar link with the snapshot the next diff will compare to.
 */
export async function linkCalendarEventCommitment(
  sql: Sql,
  userId: string,
  args: CalendarEventLinkArgs,
  /** Joining a commitment other sources already describe: its first source stays its `source_id`. */
  joining = false
) {
  const sourceRows = await sql<
    { id: string }[]
  >`INSERT INTO sources(user_id,source_type,external_id,title,captured_text,occurred_at,content_hash) VALUES(${userId},${args.sourceType},${args.sourceExternalId},${args.title},${args.capturedText},${args.occurredAt},${args.hash}) ON CONFLICT(user_id,source_type,external_id) DO UPDATE SET title=EXCLUDED.title,captured_text=EXCLUDED.captured_text,occurred_at=EXCLUDED.occurred_at,content_hash=EXCLUDED.content_hash RETURNING id`;
  if (joining)
    await sql`UPDATE commitments SET source_id=COALESCE(source_id,${sourceRows[0]!.id}) WHERE id=${args.commitmentId}`;
  else await sql`UPDATE commitments SET source_id=${sourceRows[0]!.id} WHERE id=${args.commitmentId}`;
  await sql`INSERT INTO calendar_event_links(user_id,provider,role,frame_id,external_event_id,commitment_id,profile_label,source_calendar_id,last_remote_snapshot,last_remote_hash,last_seen_at) VALUES(${userId},${args.provider},${args.role},${args.frameId},${args.linkExternalId},${args.commitmentId},${args.profileLabel},${args.sourceCalendarId},${sql.json(args.snapshot as never)},${args.hash},CURRENT_TIMESTAMP) ON CONFLICT(user_id,provider,frame_id,external_event_id) DO UPDATE SET commitment_id=EXCLUDED.commitment_id,profile_label=EXCLUDED.profile_label,source_calendar_id=EXCLUDED.source_calendar_id,last_remote_snapshot=EXCLUDED.last_remote_snapshot,last_remote_hash=EXCLUDED.last_remote_hash,last_seen_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`;
}
