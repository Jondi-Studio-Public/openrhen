import {
  connectionManifest,
  connectionRegistry,
  isImportRemovedClose,
  type CalendarEvent,
  type ImportField,
  type ImportRecord
} from "@openrhen/contracts";
import type { CalendarSeriesGroup } from "@/features/imports/calendar-series";
import { STILL_CANCELLED_WARNING } from "@/features/imports/import-validation";
import {
  applySeriesLocationDefaults,
  applyStoredLocationDefaults,
  currentSnapshot,
  importField,
  isDeleteDeclined,
  type BufferDefaults,
  type CalendarDismissalInsert,
  type DismissalRow,
  type LinkRow,
  type LocationRow
} from "./calendar-diff-core";
import { sourceClosedOf } from "./source-closed";
import { calendarProfile } from "./calendar-profiles/calendar";
// The other profiles register themselves from the files this lists (empty in the OpenRhen export).
import "./calendar-profiles/private/index";
import "./calendar-profiles/fixed-blocks";
import {
  CORE_DIFF_PROFILE,
  isDiffProfileRegistered,
  registerDiffProfile,
  registeredDiffProfile
} from "./calendar-diff-registry";
import {
  classifySeries,
  classifySourceEvent,
  providerLabel,
  toMatchRecord,
  toSeriesLinkRecord,
  type CommitmentLink,
  type CommitmentLinks,
  type SourceMatchContext
} from "./source-match-records";

/**
 * One diff for every calendar source: the orchestration that
 * turns events a connection read into import records (creates, updates, conflicts, deletes and unlinks)
 * lives here once, and everything that differs between sources sits behind a `CalendarDiffProfile`. The
 * profile is picked by the connection's declared `calendarSource.diffProfile`, never by its id. Pure over
 * the rows the store hands it, so the diff can be read without a database.
 */

/** A `calendar_event_links` row joined onto its fixed commitment, with the frame the event was read from. */
export interface CalendarLinkRow extends Omit<LinkRow, "last_remote_snapshot"> {
  /** The frame (a calendar id, for Google) this event was read from. */
  frame_id: string;
  last_remote_snapshot: Record<string, unknown> | null;
  /** The raw source the link was written from (a roster's job path); absent on a row read without it. */
  source_calendar_id?: string | null;
}

/** A `calendar_event_dismissals` row for this provider. */
export type CalendarDismissalRow = DismissalRow;

export interface CalendarDiffInput {
  timezone: string;
  /** The window that was read: inclusive lower and exclusive upper instant. */
  timeMin: string;
  timeMax: string;
  /** The same window as local dates, for a source that reads by date and so judges "in range" by date. */
  dateStart?: string | undefined;
  dateEnd?: string | undefined;
  /**
   * Which half of the diff to produce: `new` is the creates and matches for events not yet on the plan,
   * `updates` the updates, conflicts and removals for linked ones. Absent, both come back in one pass.
   */
  only?: "new" | "updates" | undefined;
  events: CalendarEvent[];
  /**
   * Whether the read covered the whole window: the feed was read to its end with nothing truncated, paged short or
   * timed out. Only a profile with `removal.missingNeedsCompleteRead` looks at it; for every other profile absence
   * is a delete whatever this says.
   */
  complete?: boolean | undefined;
  /** Frame names, for the review evidence and the link's profile label. */
  calendarNames: Record<string, string>;
  /** Links on the frames that were read, and only those: an unread frame's links must never look deleted. */
  links: CalendarLinkRow[];
  /** Series already imported as recurrence rules, by `<provider>:series:<key>` import key. */
  importedSeriesKeys: Set<string>;
  dismissals: CalendarDismissalRow[];
  /** Remote event ids OpenRhen itself published (`calendar_publications`), for a source it also publishes to. */
  publishedRemoteIds?: ReadonlySet<string> | undefined;
  locations: LocationRow[];
  presetSteps: any[];
  presetDependencies: any[];
  defaults?: BufferDefaults | undefined;
  /** The window's commitments and aliases, so an event already on the plan links instead of duplicating. */
  matchContext?: SourceMatchContext | undefined;
  /** Every link of the linked commitments, so their other sources are seen. */
  commitmentLinks?: CommitmentLinks | undefined;
  /** The settings that map a source's events to commitments, for a source whose events carry no title or place of their own. */
  mapping?: EventMapping | undefined;
}

/**
 * How a roster's settings turn its events into commitments: one title for every event, the saved place the
 * events are worked at (a store's own place winning where the event names one), and the project they attach to.
 * The private connection that feeds the profile reads these settings and passes them in.
 */
export interface EventMapping {
  title: string;
  locationName: string;
  /** The workplace name that words an event's free-text location where no saved place matched. */
  placeText?: string | undefined;
  /** A store number to the name of the saved place its events are worked at. */
  storeLocations?: Record<string, string> | undefined;
  projectName?: string | undefined;
  projects?: readonly { id: string; title: string }[] | undefined;
}

/**
 * What a batch carries of an {@link EventMapping} once it has been applied, so that committing it can rebuild
 * the snapshot it diffed against without reading settings or the saved places again.
 */
export interface LinkMapping {
  commitmentTitle: string;
  /** The workplace name that words a shift's free-text location where no saved place matched. */
  placeText?: string | undefined;
  matchedLocationName: string | null;
  storeLocationNames?: Record<string, string> | undefined;
  projectId?: string | null | undefined;
}

/** What a stored batch source keeps of each event, enough for a profile to remember a declined proposal. */
export interface StoredCalendarEvent {
  title: string;
  startsAt: string;
  seriesId: string | null;
  /** Only for a source whose events name the frame they sit on (Google's calendar id). */
  calendarId?: string | null | undefined;
}

/** The source text of a batch, parsed back: the events the batch's records were read from. */
export interface CalendarSource {
  provider: string;
  events: Record<string, StoredCalendarEvent>;
}

/** The fields of a commitment-shaped view that updates and deletes compare, as a stored snapshot holds them. */
export interface RemoteViewInput {
  title: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
}

/** What a profile needs besides the event itself when it writes a create. */
export interface CalendarCreateContext {
  calendarName: string;
  timezone: string;
  /** The saved place the profile matched for this event (`eventPlace`), if it has its own way of matching one. */
  place?: LocationRow | undefined;
  mapping?: EventMapping | undefined;
}

/** The saved place an event is worked at, and the import field that carries the match. */
export interface EventPlace {
  row: LocationRow | undefined;
  field: ImportField;
}

/** The place a free-text location names, and the field that carries the match. */
export interface LocationMatching {
  row: (text: string | null, locations: LocationRow[]) => LocationRow | undefined;
  field: (text: string | null, locations: LocationRow[]) => ImportField;
}

/**
 * The core-policy hooks. Event key, snapshot and hash formats are compared with rows already stored in
 * `calendar_event_links`, so each profile must keep today's formats byte for byte.
 */
export interface CalendarDiffProfile {
  /** `calendar_event_links.provider` and the import-key prefix (`<provider>:event:<key>`). */
  provider: string;
  /** How review evidence and warnings name the source ("Google Calendar"). */
  sourceLabel: string;
  /** Prefix of the conflict relationship names (`<prefix>Remote:<field>`, `<prefix>ConflictFields`). */
  relationshipPrefix: string;
  /** Why a linked event that was not read is listed, when it was not cancelled. */
  missingWhy: string;
  /** The fields a remote change can change on a commitment. */
  remoteFields: readonly string[];
  /** Whether an all-day event is never matched to the plan and starts unselected. */
  allDayStartsUnselected: boolean;
  /** The frame (calendar) an event was read from. */
  frameOf(event: CalendarEvent): string;
  /** What identifies one event across frames; the import key suffix and the link lookup key. */
  eventKey(event: CalendarEvent): string;
  /** The same key, from a stored link. */
  linkKey(frameId: string, externalEventId: string): string;
  /** The series key an event belongs to, or null for a one-off. */
  seriesKey(event: CalendarEvent): string | null;
  /** The commitment-shaped view of an event that updates compare. */
  remoteView(event: CalendarEvent, input: Pick<CalendarDiffInput, "mapping" | "locations">): Record<string, unknown>;
  /** The same view of what the link's last snapshot held, which is the "before" side of an update. */
  priorView(snapshot: Record<string, unknown> | null): Record<string, unknown>;
  /** The fields an update compares, in order. Absent: `remoteFields`, then status and the two buffers. */
  comparedFields?: readonly string[];
  /** The evidence on a field an update changed. Absent: `Updated in <sourceLabel> · <frame>`. */
  updatedEvidence?(frameName: string): string;
  /** How two values compare. Absent: equal when they match as JSON, `undefined` counting as `null`. */
  sameValue?(a: unknown, b: unknown): boolean;
  /** The full normalised event, as the next diff's "last seen" side. `mapping` is what its batch carried. */
  storedSnapshot(event: CalendarEvent, mapping?: LinkMapping): Record<string, unknown>;
  /** The hash of what the diff watches on an event. */
  remoteHash(event: CalendarEvent, mapping?: LinkMapping): string;
  /** The import fields of a one-off create. */
  createFields(event: CalendarEvent, context: CalendarCreateContext): ImportRecord["fields"];
  /** The relationships a one-off create carries (a default project); absent: none. */
  createRelationships?(event: CalendarEvent, context: CalendarCreateContext): Record<string, string | null>;
  /** The key after the import-key prefix is `eventKey`; this is the prefix. Absent: `<provider>:event:`. */
  importKeyPrefix?: string;
  /** The saved place an event is worked at, for a source whose events do not name it. Absent: matched on `location`. */
  eventPlace?(event: CalendarEvent, input: Pick<CalendarDiffInput, "mapping" | "locations">): EventPlace;
  /** The title a plan match compares, where the event's own is not what the commitment will be called. */
  matchTitle?(event: CalendarEvent, input: Pick<CalendarDiffInput, "mapping">): string;
  /** The fields a match with a commitment already on the plan applies from this source. Absent: none. */
  matchApplyFields?: readonly string[];
  /**
   * Last word on an update record before it is judged: add what the source maps besides the compared fields.
   * Returns whether the update is worth writing even if no compared field changed.
   */
  extendUpdate?(
    event: CalendarEvent,
    row: CalendarLinkRow,
    record: Pick<ImportRecord, "fields" | "relationships">,
    input: Pick<CalendarDiffInput, "mapping" | "locations">
  ): boolean;
  /**
   * Whether a change to this field comes only from the person's settings (a store-to-place mapping), the raw
   * source being unchanged since the link was written. Such a change never conflicts: a hand edit wins silently,
   * and another linked source is not asked. Absent: no field is settings-derived.
   */
  settingsOnlyChange?(name: string, event: CalendarEvent, row: CalendarLinkRow): boolean;
  /** Series grouping, for a source whose recurring events arrive as instances. */
  groupSeries?: {
    group(
      events: CalendarEvent[],
      timezone: string
    ): { series: CalendarSeriesGroup<CalendarEvent>[]; ungrouped: CalendarEvent[] };
    createFields(group: CalendarSeriesGroup<CalendarEvent>, context: CalendarCreateContext): ImportRecord["fields"];
  };
  /** Whether the event is cancelled or otherwise gone at the source. */
  isRemoved(event: CalendarEvent): boolean;
  /** Whether the source itself says the event is cancelled, as opposed to merely not being there. Absent: `isRemoved`. */
  isCancelled?(event: CalendarEvent): boolean;
  /** Whether the event is OpenRhen' own, published there: never proposed back. */
  isEcho(event: CalendarEvent, input: Pick<CalendarDiffInput, "publishedRemoteIds">): boolean;
  /** Whether an echoed event that is already linked is left out of the updates too. */
  echoSkipsUpdates?: boolean;
  /** What a person declined is not proposed again; absent: the source keeps no dismissals (a primary source is definitive). */
  dismissals?: {
    isDismissed(event: CalendarEvent, rows: Map<string, CalendarDismissalRow>): boolean;
    /** The dismissals a batch's create records call for; `deselected` is a commit, `all` a discard. */
    inserts(
      records: Pick<ImportRecord, "importKey" | "operation" | "removed" | "entityType" | "relationships">[],
      source: CalendarSource,
      mode: "deselected" | "all"
    ): CalendarDismissalInsert[];
  };
  /** The fields another (primary) source owns on a commitment, so this source's copy changes nothing. */
  ownedFields(others: readonly CommitmentLink[]): { fields: readonly string[]; owner: string } | null;
  /** Saved-place matching; absent when the source has no places to match. */
  locationMatching?: LocationMatching;
  /** How a linked event that the read no longer returns is judged and worded; absent: the Google rules. */
  removal?: CalendarRemovalPolicy;
}

/** What differs between sources in the way a linked event that went missing from the read is handled. */
export interface CalendarRemovalPolicy {
  /** Whether a linked event's start is inside the read window. Absent: between `timeMin` and `timeMax`. */
  inWindow?(
    startsAt: unknown,
    input: Pick<CalendarDiffInput, "timeMin" | "timeMax" | "dateStart" | "dateEnd">,
    row: CalendarLinkRow
  ): boolean;
  /** Whether a cancelled event outside the window is left alone too. Absent: a cancellation is always listed. */
  windowBoundsCancelled?: boolean;
  /** Why the row is listed when the source cancelled the event. Absent: `Cancelled in <sourceLabel>`. */
  cancelledWhy?: string;
  /** Why the row is held when other sources still carry the commitment. Absent: `missingWhy`. */
  unlinkWhy?: string;
  /** Why the row is held when the commitment was edited since the link's snapshot. Absent: `missingWhy`. */
  conflictWhy?: string;
  /** The fields edited in OpenRhen since the link's snapshot. Absent: `remoteFields` against `priorView`. */
  editedFields?(current: Record<string, unknown>, row: CalendarLinkRow): string[];
  /**
   * A linked event the read did not return is only a delete when the read was `complete`; absent, the source's own
   * cancellation still counts but plain absence is never listed. Absent: absence is a delete, as it always was.
   */
  missingNeedsCompleteRead?: boolean;
  /** Whether an earlier declined delete also silences a removal that would come back as an unlink or conflict. */
  declinedSilencesAll?: boolean;
}

export {
  diffProfileTraits,
  registerDiffProfile,
  registeredDiffProfile,
  registeredDiffProfileNames
} from "./calendar-diff-registry";

registerDiffProfile(CORE_DIFF_PROFILE, () => calendarProfile);

/**
 * The profile a connection's manifest declares (`calendarSource.diffProfile`), never chosen by id; none for an id that is no
 * calendar source. Not checked at module load: a profile file can be the first to load and reach this module through its
 * own imports before it has registered, so the check runs on first use (and in the doctor) instead.
 */
export function findProfile(connectionId: string): CalendarDiffProfile | undefined {
  const manifest = connectionManifest(connectionId);
  const declared = manifest?.calendarSource?.diffProfile;
  if (!declared || !manifest) return undefined;
  // A manifest naming a profile nothing registered is a build whose overlay failed to load: say so, naming every gap.
  if (!isDiffProfileRegistered(declared)) assertDiffProfilesRegistered();
  return registeredDiffProfile(declared, connectionId, manifest.label);
}

/** Connections whose manifest declares a diff profile nothing registered: a build whose overlay failed to load. */
export function unregisteredDiffProfiles(): { connectionId: string; profile: string }[] {
  return connectionRegistry().flatMap((manifest) => {
    const profile = manifest.calendarSource?.diffProfile;
    return profile && !isDiffProfileRegistered(profile) ? [{ connectionId: manifest.id, profile }] : [];
  });
}

/** Throws, naming every gap, when a registered manifest declares a profile that is not registered. */
export function assertDiffProfilesRegistered(): void {
  const gaps = unregisteredDiffProfiles();
  if (gaps.length)
    throw new Error(
      `Diff profiles are not registered: ${gaps.map((g) => `${g.connectionId} declares "${g.profile}"`).join(", ")}.`
    );
}

export function profileFor(connectionId: string): CalendarDiffProfile {
  const profile = findProfile(connectionId);
  if (!profile) throw new Error(`No calendar diff profile is available for ${connectionId}.`);
  return profile;
}

function withinWindow(startsAt: unknown, timeMin: string, timeMax: string): boolean {
  const start = typeof startsAt === "string" ? new Date(startsAt).getTime() : Number.NaN;
  return !Number.isNaN(start) && start >= new Date(timeMin).getTime() && start < new Date(timeMax).getTime();
}

function sameValue(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

const defaultComparedFields = (profile: CalendarDiffProfile) => [
  ...profile.remoteFields,
  "status",
  "setupBeforeMinutes",
  "transitionAfterMinutes"
];

/** An import record with today's key order (it is stored as written). */
function makeRecord(
  importKey: string,
  entityType: ImportRecord["entityType"],
  operation: ImportRecord["operation"],
  expectedVersion: number | null,
  matchedEntityId: string | null,
  fields: ImportRecord["fields"],
  sortOrder: number,
  extra: Partial<Pick<ImportRecord, "relationships" | "errors" | "warnings">> = {}
): ImportRecord {
  return {
    id: crypto.randomUUID(),
    importKey,
    entityType,
    operation,
    expectedVersion,
    matchedEntityId,
    fields,
    relationships: extra.relationships ?? {},
    errors: extra.errors ?? [],
    warnings: extra.warnings ?? [],
    removed: false,
    sortOrder
  };
}

/** The prefix of a one-off's import key. */
function keyPrefixOf(profile: CalendarDiffProfile): string {
  return profile.importKeyPrefix ?? `${profile.provider}:event:`;
}

/** The commitment's links other than this source's one. */
function othersOf(
  input: Pick<CalendarDiffInput, "commitmentLinks">,
  profile: CalendarDiffProfile,
  link: CalendarLinkRow
): CommitmentLink[] {
  return (input.commitmentLinks?.get(link.commitment_id) ?? []).filter(
    (other) => !(other.provider === profile.provider && other.externalEventId === link.external_event_id)
  );
}

/** The records a calendar preview would review, in order; empty when nothing needs review. */
export function calendarDiffRecords(input: CalendarDiffInput, profile: CalendarDiffProfile): ImportRecord[] {
  const linked = new Map(input.links.map((row) => [profile.linkKey(row.frame_id, row.external_event_id), row]));
  const remote = new Map(input.events.map((event) => [profile.eventKey(event), event]));
  const dismissals = new Map(input.dismissals.map((row) => [row.external_event_id, row]));
  const records: ImportRecord[] = [];
  const matching = profile.locationMatching;
  const findLocation = (text: string | null) => matching?.row(text, input.locations);
  const placeField = (text: string | null) =>
    matching?.field(text, input.locations) ??
    ({ value: null, basis: "missing", confidence: null, evidence: [], needsReview: false } as ImportField);
  // The place an event is worked at: the profile's own answer where the event does not name it, else its text matched.
  const placeOf = (event: CalendarEvent): EventPlace =>
    profile.eventPlace?.(event, input) ?? { row: findLocation(event.location), field: placeField(event.location) };
  const calendarName = (frame: string) => input.calendarNames[frame] ?? frame;
  const keyPrefix = keyPrefixOf(profile);
  const wantNew = input.only !== "updates";
  const wantChanges = input.only !== "new";

  const notYetImported = (wantNew ? input.events : []).filter((event) => {
    const series = profile.seriesKey(event);
    return (
      !profile.isRemoved(event) &&
      !profile.isEcho(event, input) &&
      !linked.has(profile.eventKey(event)) &&
      !(event.seriesId && series && input.importedSeriesKeys.has(`${profile.provider}:series:${series}`)) &&
      !profile.dismissals?.isDismissed(event, dismissals)
    );
  });
  // A series is one review decision per frame it appears on, so group frame by frame.
  const byFrame = new Map<string, CalendarEvent[]>();
  for (const event of notYetImported)
    byFrame.set(profile.frameOf(event), [...(byFrame.get(profile.frameOf(event)) ?? []), event]);
  for (const [frame, events] of byFrame) {
    const grouping = profile.groupSeries;
    const { series, ungrouped } = grouping
      ? grouping.group(events, input.timezone)
      : { series: [] as CalendarSeriesGroup<CalendarEvent>[], ungrouped: events };
    const oneOffs = [...ungrouped];
    for (const group of series) {
      const allDay = group.events.every((event) => event.allDay);
      // An all-day block has no clock time to match on, so an all-day series is never matched.
      const matched =
        allDay && profile.allDayStartsUnselected
          ? ({ kind: "series" } as const)
          : classifySeries(
              group.events.map((event) => ({
                provider: profile.provider as never,
                externalId: event.externalEventId,
                title: event.title,
                startsAt: event.startsAt,
                endsAt: event.endsAt,
                description: event.description,
                timezone: input.timezone
              })),
              input.matchContext
            );
      // A partial agreement with the plan: each occurrence is its own row, matched on its own.
      if (matched.kind === "occurrences") {
        oneOffs.push(...group.events);
        continue;
      }
      const context = { calendarName: calendarName(frame), timezone: input.timezone };
      const created = applySeriesLocationDefaults(
        makeRecord(
          `${profile.provider}:series:${profile.seriesKey(group.events[0]!) ?? group.seriesId}`,
          "fixed_commitment_recurrence",
          "create",
          null,
          null,
          grouping!.createFields(group, context),
          records.length
        ),
        findLocation(group.location),
        placeField(group.location),
        input.defaults
      );
      const record =
        matched.kind === "link"
          ? toSeriesLinkRecord(created, matched, input.timezone, { provider: profile.provider as never })
          : created;
      // A whole-day block rarely means Jon is busy all day, so an all-day series starts unselected.
      records.push(allDay && profile.allDayStartsUnselected ? { ...record, removed: true } : record);
    }
    for (const event of oneOffs) {
      // An all-day block has no clock time to match on, so it is never matched: it stays the unselected create.
      const classification =
        event.allDay && profile.allDayStartsUnselected
          ? ({ kind: "none" } as const)
          : classifySourceEvent(
              {
                provider: profile.provider as never,
                externalId: event.externalEventId,
                title: profile.matchTitle?.(event, input) ?? event.title,
                startsAt: event.startsAt,
                endsAt: event.endsAt,
                description: event.description,
                timezone: input.timezone
              },
              input.matchContext
            );
      if (classification.kind === "skip") continue;
      const place = placeOf(event);
      const context = {
        calendarName: calendarName(frame),
        timezone: input.timezone,
        place: place.row,
        mapping: input.mapping
      };
      const created = applyStoredLocationDefaults(
        makeRecord(
          `${keyPrefix}${profile.eventKey(event)}`,
          "fixed_commitment",
          "create",
          null,
          null,
          profile.createFields(event, context),
          records.length,
          profile.createRelationships ? { relationships: profile.createRelationships(event, context) } : {}
        ),
        place.row,
        place.field,
        input.presetSteps,
        input.presetDependencies,
        input.defaults
      );
      const record =
        classification.kind === "none"
          ? created
          : toMatchRecord(created, classification, input.timezone, {
              provider: profile.provider as never,
              ...(profile.matchApplyFields ? { applyFields: profile.matchApplyFields } : {})
            });
      records.push(event.allDay && profile.allDayStartsUnselected ? { ...record, removed: true } : record);
    }
  }
  for (const event of wantChanges ? input.events : []) {
    const link = linked.get(profile.eventKey(event));
    if (!link || profile.isRemoved(event)) continue;
    if (profile.echoSkipsUpdates && profile.isEcho(event, input)) continue;
    const record = updateRecord(
      profile,
      event,
      link,
      calendarName(profile.frameOf(event)),
      records.length,
      othersOf(input, profile, link),
      input,
      returnOf(link)
    );
    if (record) records.push(record);
  }
  for (const link of wantChanges ? input.links : []) {
    const key = profile.linkKey(link.frame_id, link.external_event_id);
    const present = remote.get(key);
    const gone = present !== undefined && profile.isRemoved(present);
    if (present && !gone) continue;
    // Already cancelled (by anyone): the source's removal has nothing left to do, so it is not proposed again.
    if (link.status === "cancelled") continue;
    // A person restored it after the source's removal was applied: it stays open until the event comes back and goes again.
    if (sourceClosedOf(link.last_remote_snapshot)) continue;
    const cancelled = present !== undefined && (profile.isCancelled ? profile.isCancelled(present) : gone);
    // Missing from the read is only a delete when the event sat inside the window: an event that ended
    // before it, or starts after it, was never going to be returned.
    // A source that cannot tell absence from a short read lists a missing event only when the read was complete.
    if (!cancelled && profile.removal?.missingNeedsCompleteRead && input.complete !== true) continue;
    const prior = link.last_remote_snapshot as { title?: unknown; startsAt?: unknown } | null;
    const inWindow =
      profile.removal?.inWindow?.(prior?.startsAt, input, link) ??
      withinWindow(prior?.startsAt, input.timeMin, input.timeMax);
    if (!inWindow && (!cancelled || profile.removal?.windowBoundsCancelled)) continue;
    const declined = !cancelled && isDeleteDeclined(key, prior, dismissals);
    if (declined && profile.removal?.declinedSilencesAll) continue;
    const record = deleteRecord(profile, link, cancelled, records.length, othersOf(input, profile, link));
    // A plain missing-event delete the owner already declined is not asked again (a real cancellation
    // still is); an edited one never gets here twice,
    // because keeping it drops the link.
    if (declined && record.operation === "delete") continue;
    records.push(record);
  }
  return records;
}

/** What confirming a removal does (the review shows it on the row). */
export const REMOVAL_WARNING = "Confirming this row cancels the commitment. You can restore it from Review > Closed.";

/**
 * What a linked event that is present and live means for a commitment the source's earlier removal closed: a commitment
 * the import cancelled reopens (to the status it had before, not a guess); one the person or an agent cancelled stays
 * cancelled and any update says so; an open one whose link still remembers the removal (a person restored it) has the
 * memory cleared. None of these is a change to a field the diff can see, so each makes a record even when nothing else
 * changed.
 */
interface SourceReturn {
  reopenTo?: string;
  clear?: boolean;
  stillClosed?: boolean;
}

function returnOf(row: CalendarLinkRow): SourceReturn | undefined {
  if (row.status === "cancelled") {
    if (!isImportRemovedClose(row)) return { stillClosed: true };
    const before = row.closed_from_status;
    return { reopenTo: before && before !== "cancelled" ? before : "confirmed" };
  }
  return sourceClosedOf(row.last_remote_snapshot) ? { clear: true } : undefined;
}

function updateRecord(
  profile: CalendarDiffProfile,
  event: CalendarEvent,
  row: CalendarLinkRow,
  calendarName: string,
  sortOrder: number,
  others: readonly CommitmentLink[],
  input: Pick<CalendarDiffInput, "mapping" | "locations">,
  back?: SourceReturn
): ImportRecord | null {
  const prior = profile.priorView(row.last_remote_snapshot);
  const current = currentSnapshot(row as unknown as LinkRow) as Record<string, unknown>;
  const next = profile.remoteView(event, input);
  const same = profile.sameValue ?? sameValue;
  const fields: ImportRecord["fields"] = {};
  const conflicts: string[] = [];
  const relationships: Record<string, string | null> = {};
  const againstByField: Record<string, string> = {};
  const owned = profile.ownedFields(others);
  const otherLabels = [...new Set(others.map((other) => providerLabel(other.provider)))].join(", ");
  let changed = false;
  for (const name of profile.comparedFields ?? defaultComparedFields(profile)) {
    if (!(name in next)) {
      fields[name] = importField(current[name], ["Kept from OpenRhen"]);
      continue;
    }
    // A primary source is definitive on the fields it gives: this copy is not asked about and changes nothing.
    if (owned && owned.fields.includes(name)) {
      fields[name] = importField(current[name], [`Kept from ${owned.owner}`]);
      continue;
    }
    const remoteChanged = !same(next[name], prior[name]);
    const localChanged = !same(current[name], prior[name]);
    // A settings-only change (the store mapping moved, the roster did not) leaves a hand edit alone and ignores
    // other sources: only an unedited field follows it.
    const settingsOnly = remoteChanged && Boolean(profile.settingsOnlyChange?.(name, event, row));
    if (settingsOnly && localChanged) {
      fields[name] = importField(current[name], ["Kept from OpenRhen"]);
      continue;
    }
    if (remoteChanged) changed = true;
    // Another source on the commitment makes any change here a disagreement, like an edit in OpenRhen.
    const conflict =
      remoteChanged && (localChanged || (others.length > 0 && !settingsOnly)) && !same(next[name], current[name]);
    if (conflict) {
      conflicts.push(name);
      relationships[`${profile.relationshipPrefix}Remote:${name}`] = JSON.stringify(next[name]);
      againstByField[name] = localChanged ? "OpenRhen" : otherLabels;
    }
    fields[name] = importField(conflict || !remoteChanged ? current[name] : next[name], [
      conflict
        ? `Conflict: changed in both ${profile.sourceLabel} and ${againstByField[name]}`
        : remoteChanged
          ? (profile.updatedEvidence?.(calendarName) ?? `Updated in ${profile.sourceLabel} · ${calendarName}`)
          : "Kept from OpenRhen"
    ]);
  }
  const extended = profile.extendUpdate?.(event, row, { fields, relationships }, input) ?? false;
  const warnings: string[] = [];
  if (back?.reopenTo) {
    // The event is back: the status the import closed it from, whatever else did or did not change.
    fields.status = importField(back.reopenTo, [`Back in ${profile.sourceLabel} · ${calendarName}`]);
    relationships.sourceReopen = "true";
  } else if (back?.clear) {
    fields.status = importField(current.status, [`Back in ${profile.sourceLabel} · ${calendarName}`]);
    relationships.sourceClear = "true";
  }
  if (back && (back.reopenTo || back.clear) && row.id) relationships.sourceLinkId = row.id;
  const forced = Boolean(back?.reopenTo || back?.clear);
  if (!changed && !extended && !forced) return null;
  if (back?.stillClosed) warnings.push(STILL_CANCELLED_WARNING);
  if (conflicts.length) relationships[`${profile.relationshipPrefix}ConflictFields`] = conflicts.join("|");
  return makeRecord(
    `${keyPrefixOf(profile)}${profile.eventKey(event)}`,
    "fixed_commitment",
    conflicts.length ? "conflict" : "update",
    row.version,
    row.commitment_id,
    fields,
    sortOrder,
    {
      relationships,
      warnings,
      errors: conflicts.map(
        (name) =>
          `${name} changed in both ${profile.sourceLabel} and ${againstByField[name]}. Choose which value to keep.`
      )
    }
  );
}

/** The remote fields whose value in OpenRhen differs from the link's last snapshot. */
function editedRemoteFields(
  profile: CalendarDiffProfile,
  current: Record<string, unknown>,
  row: CalendarLinkRow
): string[] {
  const prior = profile.priorView(row.last_remote_snapshot);
  const same = profile.sameValue ?? sameValue;
  return profile.remoteFields.filter((name) => !same(current[name], prior[name]));
}

/**
 * A linked event that is cancelled, or missing from the read. `remoteCancelled` marks only the first:
 * the source says so itself. A missing event may only have moved outside the window, so the sync never
 * applies it on its own. If the commitment was edited in OpenRhen since the link's last snapshot, the
 * record is a conflict rather than a delete: the owner's edits are not removed without asking.
 */
function deleteRecord(
  profile: CalendarDiffProfile,
  row: CalendarLinkRow,
  cancelled: boolean,
  sortOrder: number,
  others: readonly CommitmentLink[] = []
): ImportRecord {
  const snapshot = currentSnapshot(row as unknown as LinkRow);
  const current = snapshot as Record<string, unknown>;
  const editedHere = profile.removal?.editedFields
    ? profile.removal.editedFields(current, row)
    : editedRemoteFields(profile, current, row);
  const why = cancelled ? (profile.removal?.cancelledWhy ?? `Cancelled in ${profile.sourceLabel}`) : profile.missingWhy;
  const whyUnlink = cancelled ? why : (profile.removal?.unlinkWhy ?? why);
  const whyConflict = cancelled ? why : (profile.removal?.conflictWhy ?? why);
  const importKey = `${keyPrefixOf(profile)}${profile.linkKey(row.frame_id, row.external_event_id)}`;
  const currentFields = Object.fromEntries(
    Object.entries(snapshot).map(([name, value]) => [name, importField(value, [why])])
  );
  if (others.length && row.id) {
    // Held by other sources it is a disagreement, not a delete: `unlink` drops only this source's link (Keep,
    // the default) and the review can still turn it into a delete of the commitment.
    const labels = [...new Set(others.map((link) => providerLabel(link.provider)))].join(", ");
    return makeRecord(
      importKey,
      "fixed_commitment",
      "unlink",
      row.version,
      row.commitment_id,
      currentFields,
      sortOrder,
      {
        relationships: { sourceUnlinkLinkId: row.id, sourceUnlinkOthers: labels },
        warnings: [
          `${whyUnlink}, still on ${labels}: remove it? Keeping it drops only the ${profile.sourceLabel} link.`
        ]
      }
    );
  }
  return makeRecord(
    importKey,
    "fixed_commitment",
    editedHere.length ? "conflict" : "delete",
    row.version,
    row.commitment_id,
    currentFields,
    sortOrder,
    {
      relationships: {
        ...(cancelled ? { remoteCancelled: "true" } : {}),
        ...(editedHere.length ? { remoteCancelEdited: editedHere.join("|") } : {}),
        // The link that remembers the source's removal once it is applied (see `source-closed.ts`).
        ...(row.id ? { sourceLinkId: row.id } : {})
      },
      errors: editedHere.length
        ? [`${whyConflict}, but ${editedHere.join(", ")} changed in OpenRhen since. Delete it anyway or keep it.`]
        : [],
      warnings: [REMOVAL_WARNING]
    }
  );
}
