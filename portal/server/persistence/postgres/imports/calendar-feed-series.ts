import {
  commitmentRepeatFallsOn,
  zonedDateTime,
  type CalendarEvent,
  type CommitmentRepeat,
  type ImportRecord
} from "@openrhen/contracts";
import type { CalendarFeedSeries } from "@openrhen/contracts/integrations/calendar-feed";
import type { Sql } from "../sql-pool";
import {
  applySeriesLocationDefaults,
  importField,
  savedPlaceMatching,
  type BufferDefaults,
  type LocationRow
} from "./calendar-diff-core";
import {
  CALENDAR_FEED_PROVIDER,
  FEED_FRAME,
  FEED_MAX_GENERATION,
  FEED_SERIES_PREFIX,
  feedGenerationName,
  feedLocation,
  feedTitle
} from "./calendar-profiles/calendar-feed";
import {
  addDays,
  conflictRelationships,
  feedConflictText,
  feedDateRecords,
  isMove,
  ruleRepeat,
  storedDates,
  touchFeedDates,
  type FeedDateRow
} from "./calendar-feed-dates";
import { feedMoveEvents } from "./calendar-feed-moves";
import { localDateIn } from "./source-match-records";

/** A feed rule link joined onto its rule. Dates and times are read as text. */
export interface FeedRuleLinkRow {
  external_event_id: string;
  recurrence_rule_id: string;
  last_remote_snapshot: Record<string, unknown> | null;
  version: number;
  status: string;
  title: string;
  timezone: string;
  start_date: string;
  end_date: string | null;
  interval_unit: string;
  interval_days: number | null;
  interval_weeks: number | null;
  weekdays: number[] | null;
  interval_months: number | null;
  month_anchor: string | null;
  local_start_time: string;
  local_end_time: string;
  location: string | null;
  location_id: string | null;
  setup_before_minutes: number;
  transition_after_minutes: number;
}

/** One materialised date of a feed rule (the date lifecycle reads these; dates already under way are skipped there). */
export type FeedOccurrenceRow = FeedDateRow;

/** The rule columns `FeedRuleLinkRow` reads, as text where Postgres would hand back a Date. */
const FEED_RULE_COLUMNS = `r.version, r.status, r.title, r.timezone, r.start_date::text AS start_date, r.end_date::text AS end_date, r.interval_unit::text AS interval_unit, r.interval_days, r.interval_weeks, r.weekdays, r.interval_months, r.month_anchor::text AS month_anchor, r.local_start_time::text AS local_start_time, r.local_end_time::text AS local_end_time, r.location, r.location_id, r.setup_before_minutes, r.transition_after_minutes`;

/** What a feed rule link remembers and the diff compares. */
export interface FeedRuleSnapshot {
  title: string;
  startDate: string;
  endDate: string | null;
  repeat: CommitmentRepeat;
  localStartTime: string;
  localEndTime: string;
  location: string | null;
}

/** The rule's columns as the flat fields a link snapshot and a rule record carry (the repeat spread over its columns). */
function flatFeedRule(rule: FeedRuleSnapshot) {
  const { repeat } = rule;
  return {
    title: rule.title,
    startDate: rule.startDate,
    endDate: rule.endDate,
    intervalUnit: repeat.unit,
    intervalDays: repeat.unit === "days" ? repeat.intervalDays : null,
    intervalWeeks: repeat.unit === "weeks" ? repeat.intervalWeeks : null,
    weekdays: repeat.unit === "weeks" ? repeat.weekdays : null,
    intervalMonths: repeat.unit === "months" ? repeat.intervalMonths : null,
    monthAnchor: repeat.unit === "months" ? repeat.anchor : null,
    localStartTime: rule.localStartTime.slice(0, 5),
    localEndTime: rule.localEndTime.slice(0, 5),
    location: rule.location
  };
}

/**
 * The calendar feed's series pass (build plan PR 7, series design v3 as amended): a repeating feed UID the proxy
 * described exactly (`attributes.series`) becomes one `fixed_commitment_recurrence` record, keyed
 * `calendar_feed:series:<stem>`, and is linked to its rule by one `calendar_event_links` row (`series:<stem>` on the
 * `feed` frame). It is a pass of its own: the per-instance diff never sees these events (`seriesStemsOf` sets them
 * aside), `seriesKey` stays null, and it neither groups nor classifies series (`classifySeries` is bypassed: a series
 * create is one held decision, matched to nothing). The stem is the encoded UID (`idPrefix`), the same string the event
 * ids start with.
 *
 * Scope (PR 7 and PR 8): a linked rule is followed. Its changed time, title, place, repeat, zone, `UNTIL` or `COUNT` is one
 * held update (`feedRuleUpdateRecord`), its dates are the date lifecycle's (`calendar-feed-dates.ts`: cancels apply on
 * their own, every other change is held, exception rows are written under the planner's own id), and its end (a cancelled
 * master, a UID gone from a read that can say so, a shape the feed no longer describes) is only ever a held proposal. A
 * partial read proposes cancels only. A date moved to another day is a held item until the `feedMove` pair is built.
 * - PR 9 (shape change, generations, ended rules): a rule that is `ended` is left alone and nothing is proposed for
 *   its UID, so a rule the owner ended is never recreated. The generation `.N` key, `endedBy`, revival and the words of
 *   the shape-change card are PR 9's; the held end carries `feedReason` and `feedReasonKind` for it.
 *
 * Absence is read only with `absenceKnown` (a complete, non-empty read with nothing unreadable that could be the UID)
 * and a rule date expected well inside the window; the window alone never ends a rule.
 */

/**
 * The import key of a rule: `calendar_feed:series:<stem>` for the first generation of a UID's rule, `<stem>.N` for the
 * Nth (a rule the feed ended and later brought back is a new rule, never the old one reopened).
 */
export const feedSeriesKey = (stem: string, generation = 1): string =>
  `${FEED_SERIES_PREFIX}${feedGenerationName(stem, generation)}`;
/**
 * The link's `external_event_id` for a rule. It never collides with one of the UID's own events: the proxy escapes a UID
 * that begins `series:` (`encodeUid`), and the portal leaves out one that still does (`prepareFeedRead`).
 */
export const feedSeriesLinkId = (stem: string, generation = 1): string =>
  `series:${feedGenerationName(stem, generation)}`;
/**
 * The dismissal a declined series is remembered under: the encoded UID, so it covers every generation of the rule and
 * is not compared to a title (a rename in the feed does not bring a declined series back).
 */
export const feedSeriesDismissalId = (stem: string): string => `series:${stem}`;

/** Who ended a rule: the feed's own end (a cancelled or vanished UID), the owner, or a shape change the owner approved. */
export type FeedEndedBy = "feed" | "owner" | "shape";

/** The stem and generation a rule link stands for, or null for a link that is not a series link. */
export function ruleLinkIdentity(
  link: Pick<FeedRuleLinkRow, "external_event_id" | "last_remote_snapshot">
): { stem: string; generation: number } | null {
  const snapshot = link.last_remote_snapshot;
  // A later generation (and any rule written since) names its stem; an older link is generation 1 of the id's own stem.
  if (typeof snapshot?.feedStem === "string" && snapshot.feedStem)
    return { stem: snapshot.feedStem, generation: Math.max(1, Number(snapshot.feedGeneration) || 1) };
  return link.external_event_id.startsWith("series:")
    ? { stem: link.external_event_id.slice("series:".length), generation: 1 }
    : null;
}

/** The stem a rule link names, or null for a link that is not a series link. */
export const stemOfRuleLink = (link: Pick<FeedRuleLinkRow, "external_event_id" | "last_remote_snapshot">) =>
  ruleLinkIdentity(link)?.stem ?? null;

/** Who ended the rule, as the link remembers it; null when it was never recorded (an ended rule with none was the owner's). */
export function ruleLinkEndedBy(link: Pick<FeedRuleLinkRow, "last_remote_snapshot">): FeedEndedBy | null {
  const value = link.last_remote_snapshot?.endedBy;
  return value === "feed" || value === "owner" || value === "shape" ? value : null;
}

/** The kind of held end the owner chose to keep ("Keep" on the card), or null. */
export function ruleLinkKeep(link: Pick<FeedRuleLinkRow, "last_remote_snapshot">): FeedRuleEndKind | null {
  const value = link.last_remote_snapshot?.feedKeep;
  return value === "cancelled" || value === "gone" || value === "shape" ? value : null;
}

/** What the descriptor says of the rule, bounded the way the plan keeps feed titles and places. */
export function feedRuleSnapshot(series: CalendarFeedSeries): FeedRuleSnapshot {
  return {
    title: feedTitle(series.title),
    startDate: series.startDate,
    endDate: series.endDate,
    repeat: series.repeat,
    localStartTime: series.localStartTime,
    localEndTime: series.localEndTime,
    location: feedLocation(series.location)
  };
}

/**
 * The link snapshot: the rule's flat fields at the top level (no nested `rule` key), plus `timezone`, and
 * `occurrences` always an object (empty until PR 8 records dates). The feed's snapshot reader reads `timezone`, so a
 * zone change is a change to the rule.
 */
export function feedLinkSnapshot(
  series: CalendarFeedSeries,
  generation = 1,
  stem: string = series.idPrefix
): Record<string, unknown> {
  const flat = flatFeedRule(feedRuleSnapshot(series));
  return { ...flat, timezone: series.timezone, feedStem: stem, feedGeneration: generation, occurrences: {} };
}

const repeatFieldNames = [
  "intervalUnit",
  "intervalDays",
  "intervalWeeks",
  "weekdays",
  "intervalMonths",
  "monthAnchor"
] as const;
const comparedNames = [
  "title",
  "startDate",
  "endDate",
  "repeat",
  "localStartTime",
  "localEndTime",
  "location",
  "timezone"
] as const;
type ComparedName = (typeof comparedNames)[number];
type RuleView = FeedRuleSnapshot & { timezone: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hhmm = (value: unknown) => String(value ?? "").slice(0, 5);

/** A repeat in one key order with its weekdays sorted, so two readings of the same repeat compare equal. */
function canonRepeat(repeat: CommitmentRepeat): CommitmentRepeat {
  if (repeat.unit === "weeks")
    return { unit: "weeks", intervalWeeks: repeat.intervalWeeks, weekdays: [...repeat.weekdays].sort((a, b) => a - b) };
  if (repeat.unit === "months") return { unit: "months", intervalMonths: repeat.intervalMonths, anchor: repeat.anchor };
  return { unit: "days", intervalDays: repeat.intervalDays };
}

/** The rule as the stored row has it now. */
function ruleView(row: FeedRuleLinkRow): RuleView {
  return {
    title: row.title,
    startDate: row.start_date,
    endDate: row.end_date,
    repeat: canonRepeat(ruleRepeat(row) ?? { unit: "days", intervalDays: 1 }),
    localStartTime: hhmm(row.local_start_time),
    localEndTime: hhmm(row.local_end_time),
    location: row.location,
    timezone: row.timezone
  };
}

/** The rule as the feed says it now. */
function descriptorView(series: CalendarFeedSeries): RuleView {
  const snapshot = feedRuleSnapshot(series);
  return {
    ...snapshot,
    repeat: canonRepeat(snapshot.repeat),
    localStartTime: hhmm(snapshot.localStartTime),
    localEndTime: hhmm(snapshot.localEndTime),
    timezone: series.timezone
  };
}

/** What the link last recorded of the feed's rule, field by field; a field it cannot read is left out (read as never changed by the feed). */
function storedView(raw: Record<string, unknown> | null): Partial<RuleView> {
  if (!raw) return {};
  const repeat = ruleRepeat({
    interval_unit: String(raw.intervalUnit ?? ""),
    interval_days: raw.intervalDays as number | null,
    interval_weeks: raw.intervalWeeks as number | null,
    weekdays: raw.weekdays as number[] | null,
    interval_months: raw.intervalMonths as number | null,
    month_anchor: raw.monthAnchor as string | null
  });
  return {
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    ...(typeof raw.startDate === "string" ? { startDate: raw.startDate } : {}),
    ...("endDate" in raw ? { endDate: typeof raw.endDate === "string" ? raw.endDate : null } : {}),
    ...(repeat ? { repeat: canonRepeat(repeat) } : {}),
    ...(typeof raw.localStartTime === "string" ? { localStartTime: hhmm(raw.localStartTime) } : {}),
    ...(typeof raw.localEndTime === "string" ? { localEndTime: hhmm(raw.localEndTime) } : {}),
    ...("location" in raw ? { location: typeof raw.location === "string" ? raw.location : null } : {}),
    ...(typeof raw.timezone === "string" ? { timezone: raw.timezone } : {})
  };
}

function ruleRecordFields(view: RuleView, evidence: string[]): ImportRecord["fields"] {
  const flat = flatFeedRule(view);
  return {
    title: importField(flat.title, evidence),
    timezone: importField(view.timezone, evidence),
    startDate: importField(flat.startDate, evidence),
    endDate: importField(flat.endDate, evidence),
    intervalUnit: importField(flat.intervalUnit, evidence),
    intervalDays: importField(flat.intervalDays, evidence),
    intervalWeeks: importField(flat.intervalWeeks, evidence),
    weekdays: importField(flat.weekdays, evidence),
    intervalMonths: importField(flat.intervalMonths, evidence),
    monthAnchor: importField(flat.monthAnchor, evidence),
    localStartTime: importField(flat.localStartTime, evidence),
    localEndTime: importField(flat.localEndTime, evidence),
    location: importField(flat.location, evidence)
  };
}

/**
 * The whole series changed from now on, as one held rule update (time, title, place, repeat, zone, UNTIL or COUNT
 * together), or a conflict when a field the feed changes now was also edited on the plan since the feed last set it.
 * The three-way reads the link's snapshot (`prior`), the rule row (`current`) and the descriptor (`next`); a field the
 * snapshot cannot supply reads as never edited by the owner. Null when the feed asks for nothing the rule lacks.
 */
export function feedRuleUpdateRecord(
  stem: string,
  series: CalendarFeedSeries,
  link: FeedRuleLinkRow,
  args: Pick<FeedSeriesPassInput, "host" | "locations">
): ImportRecord | null {
  const next = descriptorView(series);
  const current = ruleView(link);
  const prior = { ...current, ...storedView(link.last_remote_snapshot) } as RuleView;
  const chosen = { ...current } as Record<ComparedName, unknown>;
  const conflicts: ComparedName[] = [];
  let changed = false;
  for (const name of comparedNames) {
    if (same(next[name], prior[name])) continue;
    if (same(next[name], current[name])) continue;
    changed = true;
    if (!same(current[name], prior[name])) conflicts.push(name);
    else chosen[name] = next[name];
  }
  if (!changed) return null;
  const evidence = [
    conflicts.length
      ? `Changed in the calendar feed${args.host ? ` · ${args.host}` : ""}; some fields also changed in OpenRhen`
      : `Updated in the calendar feed${args.host ? ` · ${args.host}` : ""}`
  ];
  const fields = ruleRecordFields(chosen as unknown as RuleView, evidence);
  const generation = ruleLinkIdentity(link)?.generation ?? 1;
  // The buffers are the rule's own, unchanged (the review checks a rule record for them).
  fields.setupBeforeMinutes = importField(link.setup_before_minutes, evidence);
  fields.transitionAfterMinutes = importField(link.transition_after_minutes, evidence);
  // The review resolves a conflict per record field, and a repeat is several (unit, weekdays, ...): name the ones that differ.
  const flatNext = { ...flatFeedRule(next), timezone: next.timezone };
  const flatNow = { ...flatFeedRule(current), timezone: current.timezone };
  const conflictFields = conflicts.flatMap((name) =>
    name === "repeat" ? repeatFieldNames.filter((field) => !same(flatNext[field], flatNow[field])) : [name]
  );
  if (!conflicts.includes("location") && !same(next.location, current.location))
    fields.locationId = savedPlaceMatching.field(next.location, args.locations);
  return {
    id: crypto.randomUUID(),
    importKey: feedSeriesKey(stem, generation),
    entityType: "fixed_commitment_recurrence",
    operation: conflicts.length ? "conflict" : "update",
    expectedVersion: link.version,
    matchedEntityId: link.recurrence_rule_id,
    fields,
    relationships: {
      feedSeries: stem,
      feedRuleUpdate: "true",
      ...conflictRelationships(conflictFields, (name) => flatNext[name as keyof typeof flatNext])
    },
    errors: conflictFields.map((name) => feedConflictText(name)),
    warnings: [],
    removed: false,
    sortOrder: 0
  };
}

/**
 * Why a held rule end is proposed. The card text travels in `relationships.feedReason`, and the review shows it as the
 * record's label (`import-record-card.tsx`).
 */
export type FeedRuleEndKind = "cancelled" | "gone" | "shape";

/**
 * The words of a held end. `reason` is for the person reading the review: what the feed did, what leaving the row ticked
 * does and what removing it does. `nextCall` is for an agent working through the batch: the exact calls that do either
 * (`PUT /api/imports/{batchId}` with the same records and `removed: true` on this one to keep it, then
 * `POST /api/imports/{batchId}/commit-ready`). `summary` is the short line the field evidence carries.
 */
function endReason(
  kind: FeedRuleEndKind,
  title: string,
  detail: string | undefined
): { reason: string; summary: string; nextCall: string } {
  const what: Record<FeedRuleEndKind, string> = {
    cancelled: `The calendar feed cancelled the repeating event "${title}".`,
    gone: `The repeating event "${title}" is no longer in the calendar feed.`,
    shape: `The calendar feed changed how "${title}" repeats, in a way OpenRhen cannot follow${detail ? ` (${detail})` : ""}.`
  };
  const ends =
    kind === "shape"
      ? "Ending it removes the dates still to come, because the feed's new shape is not imported, so those meetings leave your plan; the dates before today stay. Keeping it leaves those meetings on your plan as they are, no longer following the feed."
      : "Ending it removes the dates still to come; the dates before today stay.";
  return {
    summary: what[kind].slice(0, 480),
    reason: `${what[kind]} ${ends} Leave this row ticked and commit to end it. To keep it as it is on your plan instead, remove this row (Keep it) and commit: OpenRhen remembers that and does not ask again until the feed changes it back.`,
    nextCall:
      "To end it: leave this record's removed false and POST /api/imports/{batchId}/commit-ready with { expectedVersion: <the batch version> }. To keep it: PUT /api/imports/{batchId} with the same records and this one's removed set to true (and expectedVersion), then POST /api/imports/{batchId}/commit-ready. {batchId} is the id of the open import batch for source type calendar_feed (GET /api/imports lists it)."
  };
}

/** A held end of the rule. Never applied on its own; approving it is the existing rule-end delete (past dates stay). */
export function feedRuleEndRecord(
  stem: string,
  link: FeedRuleLinkRow,
  kind: FeedRuleEndKind,
  detail?: string
): ImportRecord {
  const { reason, summary, nextCall } = endReason(kind, link.title, detail);
  return {
    id: crypto.randomUUID(),
    importKey: feedSeriesKey(stem, ruleLinkIdentity(link)?.generation ?? 1),
    entityType: "fixed_commitment_recurrence",
    operation: "delete",
    expectedVersion: link.version,
    matchedEntityId: link.recurrence_rule_id,
    fields: ruleRecordFields(ruleView(link), [summary]),
    relationships: { feedSeries: stem, feedReason: reason, feedReasonKind: kind, feedNextCall: nextCall },
    errors: [],
    warnings: [
      "Confirming this row ends the repeating entry. Its future dates are cancelled (restorable from Review > Closed); past dates stay."
    ],
    removed: false,
    sortOrder: 0
  };
}

/**
 * The rule links of the feed and the rule's stored dates from two days back on (the date lifecycle skips the ones already
 * under way; a date further back is the planner's and the owner's).
 */
export async function loadFeedSeries(
  sql: Sql,
  userId: string
): Promise<{ ruleLinks: FeedRuleLinkRow[]; occurrences: FeedOccurrenceRow[] }> {
  const ruleLinks = await sql<FeedRuleLinkRow[]>`
    SELECT l.external_event_id, l.recurrence_rule_id, l.last_remote_snapshot, ${sql.unsafe(FEED_RULE_COLUMNS)}
    FROM calendar_event_links l JOIN commitment_recurrence_rules r ON r.id=l.recurrence_rule_id
    WHERE l.user_id=${userId} AND l.provider=${CALENDAR_FEED_PROVIDER} AND l.frame_id=${FEED_FRAME}
  `;
  const occurrences = ruleLinks.length
    ? await sql<FeedOccurrenceRow[]>`
        SELECT id, recurrence_rule_id, local_date::text AS local_date, title, starts_at, ends_at, status, location, location_id, setup_before_minutes, transition_after_minutes, schedule_source, version
        FROM commitments
        WHERE user_id=${userId} AND recurrence_rule_id IN ${sql(ruleLinks.map((row) => row.recurrence_rule_id))} AND starts_at>CURRENT_TIMESTAMP - INTERVAL '2 days'
      `
    : [];
  return { ruleLinks, occurrences };
}

export interface FeedSeriesPassInput {
  /** The usable rule descriptor of each represented series, by stem. */
  series: ReadonlyMap<string, CalendarFeedSeries>;
  /** Every stem the read set aside as a series (usable or not). */
  seriesStems: ReadonlySet<string>;
  /** Stems of one-off links whose UID is now a set-aside series (`splitSeriesOwnedLinks`). */
  ownedLinkStems: ReadonlySet<string>;
  ruleLinks: readonly FeedRuleLinkRow[];
  /** `calendar_event_dismissals` rows of the feed (`title` is a kept date's fingerprint). */
  dismissals: readonly { external_event_id: string; title?: string }[];
  /** The owner's local date today (a series that ended before it is not proposed). */
  today: string;
  host: string | null;
  locations: readonly LocationRow[];
  defaults?: BufferDefaults | undefined;
  /** The rules' stored dates (`loadFeedSeries`). */
  occurrences?: readonly FeedOccurrenceRow[];
  /** The moment of the read (dates already under way are not changed). Defaults to now. */
  now?: Date | undefined;
  /** The read's window as local dates, inclusive of the first and exclusive of the last (a rule must expect an instance well inside it to be called gone). */
  window?: { startDate: string; endDate: string } | undefined;
  /** Every UID stem that has an event of any kind in this read. */
  presentStems?: ReadonlySet<string> | undefined;
  /** Whether the read can speak for this UID being absent (the transport was complete and nothing was left unreadable that could be it). */
  absenceKnown?: ((stem: string) => boolean) | undefined;
  /**
   * Whether the whole feed was read. On a partial read only cancels are proposed (a partial read can only miss cancels):
   * no rule update, revert or in-place date change is built from descriptors that may be missing exceptions. A function
   * judges one stem (a skipped or unreadable event of that UID makes only that UID's read partial). Default true.
   */
  trusted?: boolean | ((stem: string) => boolean) | undefined;
  /** Original dates whose moved meeting is already a one-off event on the plan, by stem (`splitSeriesOwnedLinks`). */
  moveDates?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  /** The latest start of the one-off links a set-aside series has, by stem (`splitSeriesOwnedLinks`): an adopting rule begins after it. */
  ownedLatestStart?: ReadonlyMap<string, string> | undefined;
  /** Why the proxy could not describe an unrepresentable series, by stem (words the shape-change card). */
  unrepresentableReasons?: ReadonlyMap<string, string> | undefined;
}

export interface FeedSeriesPassResult {
  records: ImportRecord[];
  /** New series left unproposed (none now: a new series with changed dates is created and its dates are inserted with it). */
  pending: number;
  /** Rules whose feed side changed in a way the pass left to the owner without a record (also a one-off link whose UID became a series). */
  changed: number;
  /** The one-off events that stand for dates the feed moved to another day; the per-instance diff reads them with the read's own events. */
  moveEvents: Array<{ stem: string; date: string; event: CalendarEvent }>;
  /** Links (by `external_event_id`) whose kept end no longer applies: the caller clears their `feedKeep`. */
  clearKeep: string[];
}

/** One series create: the rule's columns from the descriptor, the place matched, the buffers defaulted. */
function seriesCreateRecord(
  stem: string,
  series: CalendarFeedSeries,
  args: Pick<FeedSeriesPassInput, "host" | "locations" | "defaults">,
  /** A later generation, or a rule that begins later than the feed's own first date (a revival or an adoption). */
  begin: { generation?: number; startDate?: string; note?: string; warning?: string } = {}
): ImportRecord {
  const generation = begin.generation ?? 1;
  const snapshot = feedRuleSnapshot(series);
  const flat = { ...flatFeedRule(snapshot), ...(begin.startDate ? { startDate: begin.startDate } : {}) };
  const evidence = [
    `Calendar feed${args.host ? ` · ${args.host}` : ""} · repeating event${begin.note ? ` · ${begin.note}` : ""}`.slice(
      0,
      480
    )
  ];
  const place = snapshot.location;
  const record: ImportRecord = {
    id: crypto.randomUUID(),
    importKey: feedSeriesKey(stem, generation),
    entityType: "fixed_commitment_recurrence",
    operation: "create",
    expectedVersion: null,
    matchedEntityId: null,
    fields: {
      title: importField(flat.title, evidence),
      timezone: importField(series.timezone, evidence),
      startDate: importField(flat.startDate, evidence),
      endDate: importField(flat.endDate, evidence),
      intervalUnit: importField(flat.intervalUnit, evidence),
      intervalDays: importField(flat.intervalDays, evidence),
      intervalWeeks: importField(flat.intervalWeeks, evidence),
      weekdays: importField(flat.weekdays, evidence),
      intervalMonths: importField(flat.intervalMonths, evidence),
      monthAnchor: importField(flat.monthAnchor, evidence),
      localStartTime: importField(flat.localStartTime, evidence),
      localEndTime: importField(flat.localEndTime, evidence),
      location: importField(place, evidence)
    },
    // The note travels in a relationship: validation rebuilds a create's `warnings`, which would drop it.
    relationships: {
      feedSeries: stem,
      ...(generation > 1 ? { feedGeneration: String(generation) } : {}),
      ...(begin.warning ? { feedNote: begin.warning } : {})
    },
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: 0
  };
  return applySeriesLocationDefaults(
    record,
    savedPlaceMatching.row(place, args.locations),
    savedPlaceMatching.field(place, args.locations),
    args.defaults
  );
}

/**
 * Whether the rule should have produced an instance well inside the window (not on its first or last local day, and not a
 * date the feed is known to cancel), so that the UID being missing from a complete read is evidence and not the window.
 */
function expectedInWindow(link: FeedRuleLinkRow, window: { startDate: string; endDate: string }): boolean {
  const repeat = ruleRepeat(link);
  if (!repeat) return false;
  const cancelled = new Set(
    [...storedDates(link.last_remote_snapshot)]
      .filter(([, entry]) => entry.status === "cancelled")
      .map(([date]) => date)
  );
  let date = addDays(window.startDate, 1);
  for (let step = 0; step < 120 && date < addDays(window.endDate, -1); step += 1, date = addDays(date, 1)) {
    if (date < link.start_date || (link.end_date !== null && date > link.end_date) || cancelled.has(date)) continue;
    if (commitmentRepeatFallsOn(repeat, link.start_date, date)) return true;
  }
  return false;
}

/**
 * The first date on or after `from` the series really holds a meeting on: a date of its repeat, inside its bounds, that the
 * feed neither cancels nor moves to another day. Null when there is none (a bounded series that has run out).
 */
export function firstRealInstance(series: CalendarFeedSeries, from: string, after?: Date): string | null {
  const off = new Set(series.exceptions.filter((e) => e.kind === "cancelled" || isMove(e)).map((e) => e.date));
  let date = from < series.startDate ? series.startDate : from;
  for (let step = 0; step < 1100; step += 1, date = addDays(date, 1)) {
    if (series.endDate !== null && date > series.endDate) return null;
    if (off.has(date) || !commitmentRepeatFallsOn(series.repeat, series.startDate, date)) continue;
    // A date whose meeting has already started is not a start: the old generation's row for it is still on the plan, and a
    // new rule starting there would put a second row beside it.
    if (after && zonedDateTime(date, series.localStartTime, series.timezone).getTime() <= after.getTime()) continue;
    return date;
  }
  return null;
}

/**
 * The series pass over one read, pure: the held series creates, and for a rule already on the plan its held update, its
 * date records (cancels the sync may apply on its own, every other change held) and its held end. Never reads or writes
 * the database; the caller loads `ruleLinks` and `occurrences` (`loadFeedSeries`) and stores the records.
 *
 * A rule ends only as a held proposal: the master cancelled, or the UID absent from a read that can speak for absence and
 * from which the rule should have produced an instance, or a shape the feed no longer describes (the shape-change card).
 * Absence is never read from the window alone. An end the owner kept (`feedKeep`) is not proposed again until the
 * condition goes away. A rule the feed itself ended and that returns is a new generation (`.N+1`) starting at its first
 * real instance from today; one the owner or a shape change ended is never recreated (their decline covers every
 * generation). A UID that already has one-off events on the plan is adopted by a rule that begins after the last of them.
 */
export function feedSeriesPass(input: FeedSeriesPassInput): FeedSeriesPassResult {
  // The newest generation of each UID's rule is the one that is followed (or, when ended, judged for a revival).
  const byStem = new Map<string, FeedRuleLinkRow>();
  const generationOf = new Map<string, number>();
  for (const link of input.ruleLinks) {
    const identity = ruleLinkIdentity(link);
    if (!identity || identity.generation < (generationOf.get(identity.stem) ?? 0)) continue;
    byStem.set(identity.stem, link);
    generationOf.set(identity.stem, identity.generation);
  }
  const declined = new Set(input.dismissals.map((row) => row.external_event_id));
  const keptDates = new Map<string, Map<string, string>>();
  for (const row of input.dismissals) {
    const match = /^occ:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(row.external_event_id);
    if (!match || row.title === undefined) continue;
    const dates = keptDates.get(match[1]!) ?? new Map<string, string>();
    dates.set(match[2]!, row.title);
    keptDates.set(match[1]!, dates);
  }
  const rowsByRule = new Map<string, Map<string, FeedOccurrenceRow>>();
  for (const row of input.occurrences ?? []) {
    const byDate = rowsByRule.get(row.recurrence_rule_id) ?? new Map<string, FeedOccurrenceRow>();
    byDate.set(row.local_date, row);
    rowsByRule.set(row.recurrence_rule_id, byDate);
  }
  const now = input.now ?? new Date();
  const records: ImportRecord[] = [];
  const changed = new Set<string>(input.ownedLinkStems);
  const moveEvents: FeedSeriesPassResult["moveEvents"] = [];
  const clearKeep: string[] = [];
  let pending = 0;
  for (const stem of [...new Set([...input.series.keys(), ...byStem.keys()])].sort()) {
    const series = input.series.get(stem);
    const link = byStem.get(stem);
    if (link) {
      // The UID has a rule, so its one-off events are the rule's business and are no longer an unadopted series.
      changed.delete(stem);
      const generation = generationOf.get(stem) ?? 1;
      if (link.status !== "active") {
        // An ended rule is never reopened. Only one the feed itself ended is replaced, by the next generation, and only
        // while the owner has not declined the UID (a rule the owner or a shape change ended writes that decline).
        if (
          ruleLinkEndedBy(link) === "feed" &&
          series &&
          series.status !== "cancelled" &&
          generation < FEED_MAX_GENERATION &&
          !declined.has(feedSeriesDismissalId(stem))
        ) {
          const start = firstRealInstance(series, input.today, now);
          if (start)
            records.push(
              seriesCreateRecord(stem, series, input, {
                generation: generation + 1,
                startDate: start,
                note: "back in the feed",
                warning: `This repeating event was ended because the calendar feed dropped it, and it is back. It starts again on ${start}; the dates before then are not recreated.`
              })
            );
        }
        continue;
      }
      // What the owner chose to keep stays kept only while the condition that raised it holds.
      const keep = ruleLinkKeep(link);
      const clearUnless = (kind: FeedRuleEndKind | null) => {
        if (keep && keep !== kind) clearKeep.push(link.external_event_id);
      };
      const endUnlessKept = (kind: FeedRuleEndKind, detail?: string) => {
        if (keep !== kind) records.push(feedRuleEndRecord(stem, link, kind, detail));
      };
      if (series) {
        if (series.status === "cancelled") {
          clearUnless("cancelled");
          if (link.end_date === null || link.end_date >= input.today) endUnlessKept("cancelled");
          continue;
        }
        clearUnless(null);
        const trusted = typeof input.trusted === "function" ? input.trusted(stem) : input.trusted !== false;
        const existingMoves = input.moveDates?.get(stem) ?? new Set<string>();
        const update = trusted ? feedRuleUpdateRecord(stem, series, link, input) : null;
        if (update) records.push(update);
        const dated = feedDateRecords({
          stem,
          series,
          rule: link,
          snapshot: link.last_remote_snapshot,
          rows: rowsByRule.get(link.recurrence_rule_id) ?? new Map(),
          today: input.today,
          now,
          locations: input.locations,
          kept: keptDates.get(link.recurrence_rule_id) ?? new Map(),
          ...(existingMoves.size ? { moveDates: existingMoves } : {})
        });
        for (const { event, date } of feedMoveEvents({
          stem,
          series,
          rule: link,
          rows: rowsByRule.get(link.recurrence_rule_id) ?? new Map(),
          existing: existingMoves,
          today: input.today,
          now,
          window: input.window,
          allowNew: trusted
        }))
          moveEvents.push({ stem, date, event });
        records.push(
          ...(trusted
            ? dated.records
            : dated.records.filter(
                (r) => r.relationships.feedCancel === "true" && r.relationships.feedMove === undefined
              ))
        );
        continue;
      }
      // The UID is still in the read as a series the feed no longer describes (became unrepresentable, or its
      // descriptor could not be read): the shape-change card, a held end with the proxy's reason.
      if (input.seriesStems.has(stem)) {
        clearUnless("shape");
        endUnlessKept("shape", input.unrepresentableReasons?.get(stem));
        continue;
      }
      // Gone from the feed: only when the read can say so, nothing of the UID is in it, and the rule has not simply ended.
      if (input.presentStems?.has(stem)) {
        clearUnless(null);
        continue;
      }
      if (
        input.window &&
        input.absenceKnown?.(stem) === true &&
        (link.end_date === null || link.end_date >= input.today) &&
        expectedInWindow(link, input.window)
      ) {
        clearUnless("gone");
        endUnlessKept("gone");
      }
      continue;
    }
    if (!series) continue;
    // A rule the owner deleted outright leaves no link, but the decline written when its stale key was found (and the one
    // an owner-ended or shape-ended rule writes) covers it, every generation.
    if (declined.has(feedSeriesDismissalId(stem))) continue;
    // A cancelled master that was never imported, or a series that has already ended, is nothing to add.
    if (series.status === "cancelled") continue;
    if (series.endDate !== null && series.endDate < input.today) continue;
    // The UID has one-off events on the plan: a rule from the feed's own first date would materialise on top of them.
    // Adoption: the rule begins on the first real instance after the last of them (and not before today), so the events
    // already there stay as the history they are and nothing is doubled. They are not followed afterwards.
    if (input.ownedLinkStems.has(stem)) {
      const latest = input.ownedLatestStart?.get(stem);
      const lastDay = latest ? localDateIn(new Date(latest), series.timezone) : null;
      const from = lastDay !== null && lastDay >= input.today ? addDays(lastDay, 1) : input.today;
      const start = firstRealInstance(series, from, now);
      if (!start) continue;
      changed.delete(stem);
      records.push(
        seriesCreateRecord(stem, series, input, {
          startDate: start,
          note: "adopting events already on your plan",
          warning: `This repeating event already has single events on your plan${lastDay ? ` (the last on ${lastDay})` : ""}. The repeating entry starts on ${start}, after them, so nothing is doubled; the single events stay as they are and are not followed any more.`
        })
      );
      continue;
    }
    records.push(seriesCreateRecord(stem, series, input));
  }
  return { records, pending, changed: changed.size, moveEvents, clearKeep };
}

/**
 * After a series create is written: upserts the rule's link with the flat snapshot the next diff compares to, read from
 * the batch's own source descriptor (never the record, which a review can edit). Keyed `series:<stem>` on the `feed`
 * frame; never `linkSourceToRule` or `seriesLinkTarget`, whose snapshot is an array. A re-link keeps the dates already
 * recorded under `occurrences`.
 */
export async function linkCalendarFeedRule(
  sql: Sql,
  userId: string,
  ruleId: string,
  args: { stem: string; series: CalendarFeedSeries; generation?: number }
): Promise<void> {
  const generation = args.generation ?? 1;
  const snapshot = feedLinkSnapshot(args.series, generation, args.stem);
  const { occurrences: _dates, ...compared } = snapshot;
  const linkId = feedSeriesLinkId(args.stem, generation);
  const hash = JSON.stringify(compared);
  await sql`
    INSERT INTO calendar_event_links(user_id,provider,role,frame_id,external_event_id,recurrence_rule_id,profile_label,last_remote_snapshot,last_remote_hash,last_seen_at)
    VALUES(${userId},${CALENDAR_FEED_PROVIDER},'secondary',${FEED_FRAME},${linkId},${ruleId},'Calendar feed',${sql.json(snapshot as never)},${hash},CURRENT_TIMESTAMP)
    ON CONFLICT(user_id,provider,frame_id,external_event_id) DO UPDATE SET recurrence_rule_id=EXCLUDED.recurrence_rule_id,commitment_id=NULL,profile_label=EXCLUDED.profile_label,last_remote_snapshot=EXCLUDED.last_remote_snapshot || jsonb_build_object('occurrences', COALESCE(calendar_event_links.last_remote_snapshot->'occurrences', '{}'::jsonb)),last_remote_hash=EXCLUDED.last_remote_hash,last_seen_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
  `;
  // Any touch of the link drops the exceptions that are now in the past (own SQL: the upsert above carries them forward).
  await touchFeedDates(sql, userId, ruleId);
}
