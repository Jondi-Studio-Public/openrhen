import {
  calendarFeedExtrasSchema,
  calendarFeedSeriesSchema,
  type CalendarFeedSeries
} from "@openrhen/contracts/integrations/calendar-feed";
import type {
  CalendarEvent,
  CalendarReadEventsResponse,
  CalendarSyncNotImported,
  ImportRecord
} from "@openrhen/contracts";
import type { Sql } from "@/server/persistence/postgres/sql-pool";
import { linkCalendarEventCommitment } from "@/server/persistence/postgres/imports/calendar-diff-core";
import {
  fixedBlockHash,
  fixedBlockSnapshot,
  readFixedBlocks,
  type FixedBlockEvent
} from "@/server/persistence/postgres/imports/calendar-profiles/fixed-blocks";

/**
 * The calendar feed's own pieces over the generic `fixed_blocks` profile (design v4 (e), (g), (h); build plan PR 6):
 * what the portal does with a feed read before it is diffed, the batch source text it keeps, the limits that keep a
 * batch inside `importBatchSchema`, the collision guard and the link it writes at commit. Pure apart from
 * `linkCalendarFeedCommitment`.
 *
 * This is the non-recurring, per-instance path. A recurring series is another path (the series pass,
 * `calendar-feed-series.ts`): an event that belongs to one is out of scope here, and `seriesStemsOf` is the one place
 * that says which events those are. `prepareFeedRead` hands the pass the usable descriptors by stem.
 */

export const CALENDAR_FEED_PROVIDER = "calendar_feed";
/** Every feed link sits on this one frame (there is one feed). */
export const FEED_FRAME = "feed";
export const FEED_EVENT_PREFIX = `${CALENDAR_FEED_PROVIDER}:event:`;
/** `importRecordSchema.importKey` is at most 120 characters (`platform/contracts/src/imports.ts`). */
export const FEED_MAX_KEY = 120;
export const FEED_MAX_ID = FEED_MAX_KEY - FEED_EVENT_PREFIX.length;
/** The import key of a rule the feed owns: `calendar_feed:series:<stem>`, with a later `.N` for a generation. */
export const FEED_SERIES_PREFIX = `${CALENDAR_FEED_PROVIDER}:series:`;
/** The longest encoded UID a series key carries; a longer one is not imported as a series (it is counted unreadable). */
export const FEED_SERIES_MAX_STEM = 80;
/** The longest series key: the stem limit plus a `.NNN` generation. Must stay within `FEED_MAX_KEY` (tested). */
export const FEED_SERIES_KEY_MAX = FEED_SERIES_PREFIX.length + FEED_SERIES_MAX_STEM + 4;
/** The highest generation a key can carry (`.999`); a rule revived more often than this is left ended. */
export const FEED_MAX_GENERATION = 999;
/** A stem that ends in `.<digits>` could be read as another stem plus a generation, so its generation 1 is written out. */
const endsInNumber = (stem: string): boolean => /\.\d+$/.test(stem);
/**
 * The name a UID's rule is stored under, for a series key or a link: generation 1 is the bare stem, generation N is
 * `<stem>.N`, and a stem that itself ends in `.<digits>` always carries its generation (`<stem>.1`), so two different
 * stems never share a name. Only ever built from a stem, never read back into one; the stem travels in
 * `relationships.feedSeries` and in a later generation's link snapshot.
 */
export const feedGenerationName = (stem: string, generation = 1): string =>
  generation > 1 || endsInNumber(stem) ? `${stem}.${generation}` : stem;
/**
 * The generation a series key names for a known stem, or null when the key is not that stem's. Used where a record
 * names its stem (`relationships.feedSeries`) and the key says which generation of it.
 */
export function feedGenerationOfKey(key: string, stem: string): number | null {
  if (!key.startsWith(FEED_SERIES_PREFIX)) return null;
  const rest = key.slice(FEED_SERIES_PREFIX.length);
  if (rest === stem) return endsInNumber(stem) ? null : 1;
  const tail = rest.startsWith(`${stem}.`) ? rest.slice(stem.length + 1) : "";
  if (!/^[1-9]\d{0,2}$/.test(tail)) return null;
  const generation = Number(tail);
  return generation >= (endsInNumber(stem) ? 1 : 2) && generation <= FEED_MAX_GENERATION ? generation : null;
}

/**
 * `importBatchSchema` allows 2,000 records and 100,000 source characters, and `insertBatch` checks neither, so an
 * overrun would be written and then be unreadable. The feed keeps well inside both.
 */
export const FEED_MAX_RECORDS = 1000;
export const FEED_MAX_SOURCE_CHARS = 90_000;

const TITLE_MAX = 300;
const LOCATION_MAX = 200;
const DESCRIPTION_MAX = 500;
const NO_TITLE = "(no title)";

/** What the review and the commit keep of one feed event; no description (design v4 (e)). */
export type FeedStoredEvent = FixedBlockEvent & { seriesId: string | null };

/**
 * The batch source of a feed batch, parsed back (`import_batches.source_text`). `series` is the rule descriptor of each
 * series create the batch holds, by the stem its import key carries; the commit reads the link snapshot from here,
 * never from the record (the review can edit the record). A batch written before the series pass has none.
 */
export interface FeedSource {
  provider: "calendar_feed";
  frameId: string;
  events: Record<string, FeedStoredEvent>;
  series?: Record<string, CalendarFeedSeries>;
}

/** What a run could not bring in, for the run summary (the card that words it is a later change). */
export type FeedNotImported = CalendarSyncNotImported;

export interface PreparedFeedRead {
  /** The events the per-instance diff sees, in the read's order. */
  events: CalendarEvent[];
  /** How many events the proxy returned, before any were set aside. */
  rawEventCount: number;
  /** The proxy's half of `complete` (`extras.transportComplete`). */
  transportComplete: boolean;
  /** True when something that cannot be matched to any link was left out (a series with no id): not a complete read. */
  readIncomplete: boolean;
  /** `idPrefix` of each event the proxy skipped; null for one with no id. */
  skippedPrefixes: (string | null)[];
  /** The stem of each event the portal could not use (null when it has no id), for the links it might be hiding. */
  unreadableStems: (string | null)[];
  /** Encoded UIDs of the events set aside as series (descriptor, or unrepresentable). */
  seriesStems: ReadonlySet<string>;
  /** The usable rule descriptor of each represented series, by stem (the series pass takes these). */
  series: ReadonlyMap<string, CalendarFeedSeries>;
  /** Why the proxy could not describe an unrepresentable series, by stem (the proxy's fixed reason text). */
  unrepresentableReasons: ReadonlyMap<string, string>;
  host: string | null;
  notImported: FeedNotImported;
}

/** A feed answer this build cannot interpret. The adapter turns it into a failed read with a fixed message. */
export class FeedReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedReadError";
  }
}

/** The encoded UID of a feed event id: ids are `<UID>` or `<UID>#<YYYYMMDD>`, and a `#` inside a UID is percent-encoded. */
export function feedStemOf(id: string): string {
  const at = id.indexOf("#");
  return at < 0 ? id : id.slice(0, at);
}

/**
 * The events that belong to a recurring series and so are not this path's: any event whose UID is listed in
 * `extras.unrepresentableSeries` (not imported, path D), or that carries `attributes.series` (the proxy's rule
 * descriptor, which sits on one event of a representable series and stands for every instance of that UID, so the
 * whole UID is set aside). A master-less override (RECURRENCE-ID only) has neither, so it stays per-instance.
 */
export function seriesStemsOf(
  events: readonly CalendarEvent[],
  unrepresentable: readonly { idPrefix: string }[]
): { represented: Set<string>; unrepresentable: Set<string> } {
  const unrepresentableStems = new Set(unrepresentable.map((entry) => entry.idPrefix));
  const represented = new Set<string>();
  for (const event of events) {
    const series = event.attributes?.series;
    if (series !== undefined && series !== null && !unrepresentableStems.has(feedStemOf(event.externalEventId)))
      represented.add(feedStemOf(event.externalEventId));
  }
  return { represented, unrepresentable: unrepresentableStems };
}

/** Names the portal keeps for its own rows beside an event's id (`series:<stem>` rule links, `delete:<id>` declined removals, `occ:<rule>:<date>` kept dates). */
const RESERVED_ID = /^(series|delete|occ):/;

const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);

/** A feed title as the plan keeps it: bounded, an empty one worded. */
export const feedTitle = (text: string): string => clip(text.trim(), TITLE_MAX) || NO_TITLE;
/** A feed place as the plan keeps it: bounded, an empty one none. */
export const feedLocation = (text: string | null): string | null =>
  text === null ? null : clip(text.trim(), LOCATION_MAX) || null;

/** A feed event as the diff and the batch source keep it: title and place bounded, an empty title worded. */
function normalised(event: CalendarEvent): CalendarEvent {
  return {
    ...event,
    title: feedTitle(event.title),
    location: feedLocation(event.location),
    description: event.description === null ? null : clip(event.description, DESCRIPTION_MAX)
  };
}

/**
 * Turns the proxy's answer into what the per-instance diff takes. Sets aside the series (see `seriesStemsOf`), any
 * event whose key would not fit `importKey`, and any event that fails the generic checks (`readFixedBlocks`); each
 * is counted and makes the read incomplete where a link could be hiding behind it. Throws `FeedReadError` for an
 * answer whose `extras` this build cannot read: the safe reading of that is a failed read, not a guess.
 */
export function prepareFeedRead(response: Pick<CalendarReadEventsResponse, "events" | "extras">): PreparedFeedRead {
  const extras = calendarFeedExtrasSchema.safeParse(response.extras);
  if (!extras.success) throw new FeedReadError("The calendar feed answer could not be read.");
  const stems = seriesStemsOf(
    response.events,
    (extras.data.unrepresentableSeries ?? []).flatMap((entry) => (entry.idPrefix ? [{ idPrefix: entry.idPrefix }] : []))
  );
  const seriesStems = new Set([...stems.represented, ...stems.unrepresentable]);
  const unrepresentableReasons = new Map<string, string>();
  for (const entry of extras.data.unrepresentableSeries ?? [])
    if (entry.idPrefix && !unrepresentableReasons.has(entry.idPrefix))
      unrepresentableReasons.set(entry.idPrefix, entry.reason);
  // A represented series is usable only with a descriptor this build reads, for the UID it sits on, and a stem that
  // fits a series key. Otherwise it is set aside and counted unreadable (a linked rule behind it is "changed").
  const series = new Map<string, CalendarFeedSeries>();
  for (const event of response.events) {
    const stem = feedStemOf(event.externalEventId);
    if (!stems.represented.has(stem) || series.has(stem)) continue;
    const parsed = calendarFeedSeriesSchema.safeParse(event.attributes?.series);
    if (
      parsed.success &&
      parsed.data.idPrefix === stem &&
      stem.length <= FEED_SERIES_MAX_STEM &&
      !RESERVED_ID.test(stem)
    )
      series.set(stem, parsed.data);
  }
  const unusableSeries = stems.represented.size - series.size;
  // An unrepresentable series with no id cannot be matched to a link or to its instances: count it, and the read is
  // not complete (the same rule as a skipped event with no id).
  const nullPrefixSeries = (extras.data.unrepresentableSeries ?? []).filter((entry) => !entry.idPrefix).length;

  const candidates: CalendarEvent[] = [];
  // Only a skip that could be hiding a linked event makes the read incomplete (`feedReadComplete`): a link's id is
  // never over-long, and a skipped event is hiding a link only when its id is one.
  const unreadableStems: (string | null)[] = [];
  let unreadable = unusableSeries;
  const readIncomplete = nullPrefixSeries > 0;
  for (const event of response.events) {
    if (seriesStems.has(feedStemOf(event.externalEventId))) continue;
    // The proxy escapes a UID that begins `series:` or `delete:` (its id would share a name with a rule link or a declined
    // removal). An id that still begins so is from a proxy that does not, and is left out rather than risk the collision.
    if (event.externalEventId.length > FEED_MAX_ID || RESERVED_ID.test(event.externalEventId)) {
      unreadable += 1;
      unreadableStems.push(feedStemOf(event.externalEventId));
      continue;
    }
    candidates.push(normalised(event));
  }
  const read = readFixedBlocks(candidates);
  unreadable += read.skipped.length + extras.data.skipped.length;
  for (const skip of read.skipped)
    unreadableStems.push(skip.externalEventId === null ? null : feedStemOf(skip.externalEventId));

  return {
    events: read.events,
    rawEventCount: response.events.length,
    transportComplete: extras.data.transportComplete,
    readIncomplete,
    skippedPrefixes: extras.data.skipped.map((entry) => entry.idPrefix),
    unreadableStems,
    seriesStems,
    series,
    unrepresentableReasons,
    host: extras.data.host,
    notImported: {
      unrepresentableSeries: stems.unrepresentable.size + nullPrefixSeries,
      seriesPending: series.size,
      seriesChanged: 0,
      unreadable,
      droppedForSize: 0
    }
  };
}

/** A feed link as `feedReadComplete` needs it. */
export interface FeedLinkInfo {
  external_event_id: string;
  last_remote_snapshot: Record<string, unknown> | null;
}

/**
 * Whether the read covers the whole window, so a linked event that is not in it may be listed for removal (design v4
 * (g)). Every part must hold: the proxy says the transport was complete; nothing was left out that cannot be matched to
 * a link (a series or skipped event with no id); no skipped event, proxy-side or portal-side, shares its UID with a
 * link; and the read is not empty while links sit in the window. A skip that matches no link cannot be hiding one, so
 * it no longer holds the read incomplete for good. `links` are the one-off links the per-instance diff sees: a link
 * behind a set-aside series is the series pass's and is taken out before this (`splitSeriesOwnedLinks`).
 */
export function feedReadComplete(
  prepared: Pick<
    PreparedFeedRead,
    "transportComplete" | "readIncomplete" | "skippedPrefixes" | "unreadableStems" | "rawEventCount"
  >,
  links: readonly FeedLinkInfo[],
  window: { timeMin: string; timeMax: string }
): boolean {
  if (!prepared.transportComplete || prepared.readIncomplete) return false;
  if (prepared.skippedPrefixes.includes(null) || prepared.unreadableStems.includes(null)) return false;
  const hidden = new Set<string>([
    ...(prepared.skippedPrefixes as string[]),
    ...(prepared.unreadableStems as string[])
  ]);
  if (links.some((link) => hidden.has(feedStemOf(link.external_event_id)))) return false;
  if (prepared.rawEventCount === 0 && links.some((link) => linkInWindow(link, window))) return false;
  return true;
}

/**
 * Splits the one-off links into those the per-instance diff reads and those whose UID is now a set-aside series
 * (descriptor or unrepresentable): the series pass owns the second kind. A link that replaces a moved date
 * (`feedMoveOf`) stays with the per-instance diff, and `moveDates` names its original dates by stem. They are left as they are (no absence
 * delete, no update), and `ownedStems` is what the pass counts as changed.
 */
export function splitSeriesOwnedLinks<T extends FeedLinkInfo>(
  links: readonly T[],
  seriesStems: ReadonlySet<string>
): {
  links: T[];
  ownedStems: Set<string>;
  moveDates: Map<string, Set<string>>;
  /** The latest start (ISO instant) any owned one-off link of a stem last recorded: where a series adopting them must begin after. */
  ownedLatestStart: Map<string, string>;
} {
  const kept: T[] = [];
  const ownedStems = new Set<string>();
  const moveDates = new Map<string, Set<string>>();
  const ownedLatestStart = new Map<string, string>();
  for (const link of links) {
    const stem = feedStemOf(link.external_event_id);
    const movedFrom = link.last_remote_snapshot?.feedMoveOf;
    if (typeof movedFrom === "string") {
      // The replacement of a date the series moved: a one-off event the per-instance diff keeps reading, paired with its date.
      kept.push(link);
      const dates = moveDates.get(stem) ?? new Set<string>();
      dates.add(movedFrom);
      moveDates.set(stem, dates);
    } else if (seriesStems.has(stem)) {
      ownedStems.add(stem);
      const starts = link.last_remote_snapshot?.startsAt;
      const time = typeof starts === "string" ? new Date(starts) : null;
      if (time && !Number.isNaN(time.getTime())) {
        const latest = ownedLatestStart.get(stem);
        if (!latest || time.toISOString() > latest) ownedLatestStart.set(stem, time.toISOString());
      }
    } else kept.push(link);
  }
  return { links: kept, ownedStems, moveDates, ownedLatestStart };
}

function linkInWindow(link: FeedLinkInfo, window: { timeMin: string; timeMax: string }): boolean {
  const starts = link.last_remote_snapshot?.startsAt;
  const time = typeof starts === "string" ? new Date(starts).getTime() : Number.NaN;
  return !Number.isNaN(time) && time >= new Date(window.timeMin).getTime() && time < new Date(window.timeMax).getTime();
}

/** The event as the batch source keeps it (no description). */
export function feedStoredEvent(event: CalendarEvent): FeedStoredEvent {
  return {
    externalEventId: event.externalEventId,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    location: event.location,
    status: event.status,
    seriesId: event.seriesId
  };
}

/**
 * The source text a feed batch keeps: only the events its records read from, sorted, so the same held events give the
 * same text run after run and the sync leaves an open review batch (and what was ticked in it) alone. `heldKeys`
 * covers records that carry no event.
 */
export function feedSyncSourceText(args: {
  events: readonly CalendarEvent[];
  records: readonly (Pick<ImportRecord, "importKey" | "operation"> & Partial<Pick<ImportRecord, "relationships">>)[];
  /** The descriptor of each series a record names (its create, update, end or a date of it), by stem; only those are kept. */
  series?: ReadonlyMap<string, CalendarFeedSeries>;
}): string {
  const ids = new Set<string>();
  const stems: string[] = [];
  for (const record of args.records) {
    if (record.importKey.startsWith(FEED_EVENT_PREFIX)) ids.add(record.importKey.slice(FEED_EVENT_PREFIX.length));
    const named = record.relationships?.feedSeries;
    if (named) stems.push(named);
    else if (record.importKey.startsWith(FEED_SERIES_PREFIX))
      stems.push(record.importKey.slice(FEED_SERIES_PREFIX.length));
    // A date of a rule (and a move's one-off) names its series so the commit reads the descriptor, not the record. A
    // rule record's key carries a generation after the stem, so the stem is the name the record gives, not the key.
  }
  const events = args.events
    .filter((event) => ids.has(event.externalEventId))
    .sort((a, b) => (a.externalEventId < b.externalEventId ? -1 : a.externalEventId > b.externalEventId ? 1 : 0));
  return JSON.stringify({
    provider: CALENDAR_FEED_PROVIDER,
    frameId: FEED_FRAME,
    heldKeys: args.records.map((record) => `${record.importKey}:${record.operation}`).sort(),
    events: Object.fromEntries(events.map((event) => [event.externalEventId, feedStoredEvent(event)])),
    // Added only when a series record is held, so a batch without one keeps the text it had before the series pass.
    ...(stems.length
      ? {
          series: Object.fromEntries(
            [...new Set(stems)].sort().flatMap((stem) => {
              const descriptor = args.series?.get(stem);
              return descriptor ? [[stem, descriptor] as const] : [];
            })
          )
        }
      : {})
  });
}

/**
 * Keeps the records that fit the batch ceilings, earliest-starting first. `startOf` gives a record's start (any
 * sortable string; unknown sorts last). The largest prefix whose source text and record count fit is kept, so every
 * subset of it (the auto batch and the held batch are previewed separately) fits too. `dropped` is the count left out.
 */
export function limitFeedRecords(
  records: readonly ImportRecord[],
  startOf: (record: ImportRecord) => string,
  textFor: (subset: readonly ImportRecord[]) => string,
  limits: { records: number; chars: number } = { records: FEED_MAX_RECORDS, chars: FEED_MAX_SOURCE_CHARS }
): { kept: ImportRecord[]; dropped: number } {
  const fits = (subset: readonly ImportRecord[]) =>
    subset.length <= limits.records && textFor(subset).length <= limits.chars;
  if (fits(records)) return { kept: [...records], dropped: 0 };
  const ordered = records
    .map((record, index) => ({ record, index, start: startOf(record) || "￿" }))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.index - b.index));
  let low = 0;
  let high = Math.min(ordered.length, limits.records);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(ordered.slice(0, middle).map((entry) => entry.record))) low = middle;
    else high = middle - 1;
  }
  const keep = new Set(ordered.slice(0, low).map((entry) => entry.index));
  // A moved meeting is two records that must travel together: a pair cut in half is dropped whole.
  const half = new Set<string>();
  const pairOf = (record: ImportRecord) => record.relationships.feedMove;
  const kept = new Set<string>();
  for (const index of keep) if (pairOf(records[index]!)) kept.add(pairOf(records[index]!)!);
  for (const [index, record] of records.entries()) {
    const pair = pairOf(record);
    if (pair && kept.has(pair) && !keep.has(index)) half.add(pair);
  }
  for (const [index, record] of records.entries())
    if (keep.has(index) && half.has(pairOf(record) ?? "")) keep.delete(index);
  return { kept: records.filter((_, index) => keep.has(index)), dropped: records.length - keep.size };
}

/**
 * Two feed events that match the same commitment on the plan both become a `link` (or a "possible" held choice), and
 * the second link insert would violate `calendar_event_links_commitment_unique` and abort the whole commit. Returns
 * the import keys of the records to demote to plain creates: one link wins each commitment (the first), and a
 * possible match only gets a commitment no link took.
 */
export function feedCommitmentCollisions(records: readonly ImportRecord[]): Set<string> {
  const demote = new Set<string>();
  const taken = new Set<string>();
  const target = (record: ImportRecord) =>
    record.operation === "link"
      ? record.matchedEntityId
      : record.operation === "conflict" && record.relationships.sourceMatchKind
        ? record.relationships.sourceMatchCommitmentId
        : null;
  for (const record of records) {
    if (record.operation !== "link") continue;
    const id = target(record);
    if (!id) continue;
    if (taken.has(id)) demote.add(record.importKey);
    else taken.add(id);
  }
  for (const record of records) {
    if (record.operation !== "conflict") continue;
    const id = target(record);
    if (!id) continue;
    if (taken.has(id)) demote.add(record.importKey);
    else taken.add(id);
  }
  return demote;
}

/**
 * The records after the collision guard: each demoted record is replaced by its plain create. A demoted record with no
 * plain create to replace it (it was left out of the re-diff) is dropped, not kept as the link it was demoted from: it
 * could not link anyway (the second link insert is the very thing the demotion avoids), so the event is simply
 * proposed again on the next run, once the commitment it matched is linked.
 */
export function applyFeedDemotions(
  records: readonly ImportRecord[],
  demote: ReadonlySet<string>,
  plain: ReadonlyMap<string, ImportRecord>
): ImportRecord[] {
  return records.flatMap((record) => {
    if (!demote.has(record.importKey)) return [record];
    const replacement = plain.get(record.importKey);
    return replacement ? [replacement] : [];
  });
}

/**
 * After a feed-sourced commitment is written: records the event as a source, points the commitment at it, and upserts
 * the calendar link with the snapshot the next diff will compare to. The second guard of the collision rule: a
 * commitment that already has a feed link under another external id is not linked again (it would abort the commit);
 * returns whether the link was written.
 */
export async function linkCalendarFeedCommitment(
  sql: Sql,
  userId: string,
  commitmentId: string,
  externalId: string,
  event: FeedStoredEvent,
  /** Joining a commitment other sources already describe: its first source stays its `source_id`. */
  joining: boolean
): Promise<boolean> {
  const other = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM calendar_event_links
    WHERE user_id=${userId} AND provider=${CALENDAR_FEED_PROVIDER} AND commitment_id=${commitmentId} AND external_event_id<>${externalId}
    LIMIT 1
  `;
  if (other.length) return false;
  const snapshot = fixedBlockSnapshot(event);
  await linkCalendarEventCommitment(
    sql,
    userId,
    {
      commitmentId,
      provider: CALENDAR_FEED_PROVIDER,
      role: "secondary",
      sourceType: "calendar_feed_event",
      sourceExternalId: externalId,
      linkExternalId: externalId,
      frameId: FEED_FRAME,
      profileLabel: "Calendar feed",
      sourceCalendarId: null,
      capturedText: JSON.stringify(event),
      snapshot,
      hash: fixedBlockHash(event),
      title: event.title,
      occurredAt: new Date(event.startsAt)
    },
    joining
  );
  return true;
}
