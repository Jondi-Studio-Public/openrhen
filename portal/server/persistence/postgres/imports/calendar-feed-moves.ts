import { calendarEventSchema, zonedDateTime, type CalendarEvent, type ImportRecord } from "@openrhen/contracts";
import type { CalendarFeedSeries, CalendarFeedSeriesException } from "@openrhen/contracts/integrations/calendar-feed";
import {
  FEED_EXCEPTION_HORIZON_DAYS,
  addDays,
  feedMovePairId,
  generatedSnapshot,
  isMove,
  isRuleDate,
  type FeedDateRow,
  type FeedDateRule
} from "./calendar-feed-dates";
import { feedLocation, feedStemOf, feedTitle } from "./calendar-profiles/calendar-feed";

/**
 * A date the feed moves to another local day (build plan PR 8, series design v3 "date lifecycle"). It is two changes that
 * go together: the original date is cancelled (the date lifecycle's cancel, tagged with the pair) and the meeting at its
 * new time is an ordinary one-off event, `<stem>#move<YYYYMMDD of the original date>`, that the per-instance diff creates,
 * updates and removes like any feed event. Both records carry `relationships.feedMove=<pair>` and are always held, so the
 * original is never cancelled without its replacement (and the commit refuses to write only one half).
 *
 * The link of a replacement remembers the original date as `feedMoveOf` on its snapshot, which is how the next sync knows
 * it belongs to the series and not to an old per-instance link. A move that stops being a move (the feed moved it back
 * to its own day, dropped the change, or the series is gone) leaves the replacement absent from the read, which the
 * per-instance diff reads as a delete; that delete and the original date's revert (or in-place change) are one pair.
 */

const compact = (date: string): string => date.replaceAll("-", "");

/** The external id of the one-off event that stands for a moved date. */
export const feedMoveEventId = (stem: string, originalDate: string): string => `${stem}#move${compact(originalDate)}`;

/** Which series and original date an event id stands for, or null when it is not a move's replacement. */
export function parseFeedMoveEventId(id: string): { stem: string; date: string } | null {
  const match = /^(.+)#move(\d{4})(\d{2})(\d{2})$/.exec(id);
  return match ? { stem: match[1]!, date: `${match[2]}-${match[3]}-${match[4]}` } : null;
}

/** The original date a link's snapshot says it replaces, or null. */
export const linkMoveDate = (snapshot: Record<string, unknown> | null | undefined): string | null => {
  const value = snapshot?.feedMoveOf;
  return typeof value === "string" ? value : null;
};

export interface FeedMoveEventsInput {
  stem: string;
  series: CalendarFeedSeries;
  rule: FeedDateRule;
  rows: ReadonlyMap<string, FeedDateRow>;
  /** Original dates whose replacement already exists on the plan. */
  existing: ReadonlySet<string>;
  today: string;
  now: Date;
  /** The local dates the read covers; a new replacement outside it waits. */
  window?: { startDate: string; endDate: string } | undefined;
  /** Whether a new replacement may be proposed (a complete read; one already on the plan is always kept). */
  allowNew: boolean;
}

/**
 * The one-off events the feed's moves stand for. One already on the plan is always listed (while its exception stays), so
 * it is updated and never read as absent; a new one is listed only when the original date can be cancelled in the same
 * review: a date of the rule, still ahead, not under way, inside the insert horizon, and the new day inside the read.
 */
export function feedMoveEvents(input: FeedMoveEventsInput): Array<{ event: CalendarEvent; date: string }> {
  const { series, today, now } = input;
  const horizonEnd = addDays(today, FEED_EXCEPTION_HORIZON_DAYS);
  const out: Array<{ event: CalendarEvent; date: string }> = [];
  for (const exception of series.exceptions) {
    if (exception.kind !== "changed" || !isMove(exception)) continue;
    const date = exception.date;
    if (!input.existing.has(date) && !newMoveAllowed(input, exception, date, horizonEnd, now)) continue;
    out.push({ date, event: moveEvent(input.stem, series, exception) });
  }
  return out;
}

function newMoveAllowed(
  input: FeedMoveEventsInput,
  exception: Extract<CalendarFeedSeriesException, { kind: "changed" }>,
  date: string,
  horizonEnd: string,
  now: Date
): boolean {
  if (!input.allowNew || date < input.today || !isRuleDate(input.rule, date)) return false;
  const row = input.rows.get(date);
  if (row) {
    if (row.starts_at.getTime() <= now.getTime()) return false;
  } else if (date > horizonEnd || new Date(generatedSnapshot(input.rule, date).startsAt).getTime() <= now.getTime()) {
    return false;
  }
  const window = input.window;
  return !window || (exception.startDate >= window.startDate && exception.startDate <= window.endDate);
}

function moveEvent(
  stem: string,
  series: CalendarFeedSeries,
  exception: Extract<CalendarFeedSeriesException, { kind: "changed" }>
): CalendarEvent {
  return calendarEventSchema.parse({
    externalEventId: feedMoveEventId(stem, exception.date),
    calendarId: null,
    title: feedTitle(exception.title),
    description: null,
    startsAt: zonedDateTime(exception.startDate, exception.localStartTime, series.timezone).toISOString(),
    endsAt: zonedDateTime(exception.endDate, exception.localEndTime, series.timezone).toISOString(),
    allDay: false,
    timezone: null,
    location: feedLocation(exception.location),
    status: "confirmed",
    seriesId: null,
    recurring: false,
    updatedAt: null
  });
}

/**
 * Names a replacement's record as the feed's: the series, the original date and the `feedMoveOf` the commit writes onto
 * the link. Its create, link or delete is also half of the date's pair (`feedMove`, `feedMoveSize`); a change to the time
 * of a replacement already on the plan leaves the original date alone and is no pair. `known` is every replacement the
 * read or the plan has (id to original date).
 */
export function tagMoveRecord(
  record: ImportRecord,
  known: ReadonlyMap<string, string>,
  eventPrefix: string
): ImportRecord {
  if (!record.importKey.startsWith(eventPrefix)) return record;
  const id = record.importKey.slice(eventPrefix.length);
  const date = known.get(id);
  if (!date) return record;
  const stem = feedStemOf(id);
  const half = record.operation === "create" || record.operation === "link" || record.operation === "delete";
  return {
    ...record,
    relationships: {
      ...record.relationships,
      feedSeries: stem,
      feedDate: date,
      feedMoveOf: date,
      ...(half ? { feedMove: feedMovePairId(stem, date), feedMoveSize: "2" } : {})
    }
  };
}

/**
 * A move's two records stand or fall together. A date record whose replacement is not in this batch (the new day is
 * outside the read, the replacement was declined, the read was partial) is dropped, so the original is never cancelled
 * alone; a replacement's delete without the date's record is dropped, so the original is never left cancelled with no
 * meeting; a replacement's create without a date record (the original is already cancelled) stands as an ordinary create.
 * A replacement's delete that `orphanNote` explains (the feed cancelled the date, or the repeating event ended or vanished:
 * there is no revert to pair it with, and the meeting really is going) is not dropped but kept as a held record with that
 * note, so a cancelled moved meeting never lingers on the plan unseen. Records that are not half of a pair pass through.
 */
export function keepWholeMovePairs(
  records: readonly ImportRecord[],
  eventPrefix: string,
  /** The note that keeps a replacement's lone delete as a held record (why it is going), or null to drop it as before. */
  orphanNote?: (record: ImportRecord) => string | null
): ImportRecord[] {
  const pairs = new Map<string, { date: ImportRecord[]; replacement: ImportRecord[] }>();
  for (const record of records) {
    const pair = record.relationships.feedMove;
    if (!pair) continue;
    const entry = pairs.get(pair) ?? { date: [], replacement: [] };
    (record.importKey.startsWith(eventPrefix) ? entry.replacement : entry.date).push(record);
    pairs.set(pair, entry);
  }
  const out: ImportRecord[] = [];
  for (const record of records) {
    const pair = record.relationships.feedMove;
    const entry = pair ? pairs.get(pair) : undefined;
    if (!pair || !entry) {
      out.push(record);
      continue;
    }
    const whole = entry.date.length > 0 && entry.replacement.length > 0;
    if (whole) out.push(record);
    else if (record.importKey.startsWith(eventPrefix)) {
      const { feedMove: _pair, feedMoveSize: _size, ...rest } = record.relationships;
      if (record.operation !== "delete") out.push({ ...record, relationships: rest });
      else {
        const note = orphanNote?.(record);
        if (note) out.push({ ...record, relationships: rest, warnings: [...record.warnings, note] });
      }
    }
  }
  return out;
}
