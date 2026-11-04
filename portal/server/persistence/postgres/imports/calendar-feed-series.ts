import type { CommitmentRepeat, ImportRecord } from "@openrhen/contracts";
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
  FEED_SERIES_PREFIX,
  feedLocation,
  feedTitle
} from "./calendar-profiles/calendar-feed";

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
}

/** One materialised, not-yet-started date of a feed rule (read now, applied by the date lifecycle later). */
export interface FeedOccurrenceRow {
  id: string;
  recurrence_rule_id: string;
  local_date: string;
  title: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
  location: string | null;
  location_id: string | null;
  setup_before_minutes: number;
  transition_after_minutes: number;
  schedule_source: string;
  version: number;
}

/** The rule columns `FeedRuleLinkRow` reads, as text where Postgres would hand back a Date. */
const FEED_RULE_COLUMNS = `r.version, r.status, r.title, r.timezone, r.start_date::text AS start_date, r.end_date::text AS end_date, r.interval_unit::text AS interval_unit, r.interval_days, r.interval_weeks, r.weekdays, r.interval_months, r.month_anchor::text AS month_anchor, r.local_start_time::text AS local_start_time, r.local_end_time::text AS local_end_time, r.location`;

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
 * Scope of this change: a series with no changed dates, created and then followed. What is not here is left as a seam
 * and made safe, not silent:
 *
 * - PR 8 (date lifecycle, rule updates, series gone): a linked rule whose feed side changed (an EXDATE or override, a
 *   new `UNTIL`, a new time or title, a cancelled master) is NOT applied. Nothing is written for it, the rule keeps
 *   materialising from its old shape, and the run counts it in `notImported.seriesChanged`. A new series that already
 *   has changed dates is not created (its dates could not be applied) and is counted in `seriesPending`.
 * - PR 9 (shape change, generations, ended rules): a rule that is `ended` is left alone and nothing is proposed for
 *   its UID, so a rule the owner ended is never recreated. The generation `.N` key, `endedBy` and revival are PR 9's.
 *
 * Absence is never read here: a UID with no event in the window carries no descriptor, so "not in this read" cannot
 * be told from "gone" (the PR 5 note), and no rule end is proposed from it.
 */

export const feedSeriesKey = (stem: string): string => `${FEED_SERIES_PREFIX}${stem}`;
/** The link's `external_event_id` for a rule (a series never collides with one of the UID's own events). */
export const feedSeriesLinkId = (stem: string): string => `series:${stem}`;
// Known limit (not fixed): a one-off event whose UID is literally `series:<stem>` would share this link id (the unique
// key is provider, frame and external id), so linking one over the other would replace it. Real UIDs do not look like
// this; a later change can prefix one-off link ids if it ever matters.
/**
 * The dismissal a declined series is remembered under: the encoded UID, so it covers every generation of the rule and
 * is not compared to a title (a rename in the feed does not bring a declined series back).
 */
export const feedSeriesDismissalId = (stem: string): string => `series:${stem}`;

/** The stem a rule link names, or null for a link that is not a series link. */
export function stemOfRuleLink(link: Pick<FeedRuleLinkRow, "external_event_id">): string | null {
  return link.external_event_id.startsWith("series:") ? link.external_event_id.slice("series:".length) : null;
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
export function feedLinkSnapshot(series: CalendarFeedSeries): Record<string, unknown> {
  const flat = flatFeedRule(feedRuleSnapshot(series));
  return { ...flat, timezone: series.timezone, occurrences: {} };
}

const comparedKeys = [
  "title",
  "startDate",
  "endDate",
  "intervalUnit",
  "intervalDays",
  "intervalWeeks",
  "weekdays",
  "intervalMonths",
  "monthAnchor",
  "localStartTime",
  "localEndTime",
  "location",
  "timezone"
] as const;

const pick = (snapshot: Record<string, unknown>) => JSON.stringify(comparedKeys.map((key) => snapshot[key] ?? null));

/**
 * Whether the feed still says what the link last recorded: every rule field and the zone equal, no changed date, and
 * the master not cancelled. It reads the link's snapshot, not the rule row, so an owner's edit of the rule is not a
 * feed change. Anything unreadable reads as changed (counted, never written).
 */
export function feedSeriesUnchanged(series: CalendarFeedSeries, link: Pick<FeedRuleLinkRow, "last_remote_snapshot">) {
  if (series.status === "cancelled" || series.exceptions.length > 0) return false;
  const stored = link.last_remote_snapshot;
  if (!stored) return false;
  const stale = stored.occurrences;
  if (stale && typeof stale === "object" && Object.keys(stale).length > 0) return false;
  return pick(stored) === pick(feedLinkSnapshot(series));
}

/** The rule links of the feed and the rule's dates still to come: the series pass's own loader. */
export async function loadFeedSeries(
  sql: Sql,
  userId: string
): Promise<{ ruleLinks: FeedRuleLinkRow[]; occurrences: FeedOccurrenceRow[] }> {
  const ruleLinks = await sql<FeedRuleLinkRow[]>`
    SELECT l.external_event_id, l.recurrence_rule_id, l.last_remote_snapshot, ${sql.unsafe(FEED_RULE_COLUMNS)}
    FROM calendar_event_links l JOIN commitment_recurrence_rules r ON r.id=l.recurrence_rule_id
    WHERE l.user_id=${userId} AND l.provider=${CALENDAR_FEED_PROVIDER} AND l.frame_id=${FEED_FRAME}
  `;
  // The dates a later change (PR 8) cancels or changes are the ones not yet started.
  const occurrences = ruleLinks.length
    ? await sql<FeedOccurrenceRow[]>`
        SELECT id, recurrence_rule_id, local_date::text AS local_date, title, starts_at, ends_at, status, location, location_id, setup_before_minutes, transition_after_minutes, schedule_source, version
        FROM commitments
        WHERE user_id=${userId} AND recurrence_rule_id IN ${sql(ruleLinks.map((row) => row.recurrence_rule_id))} AND starts_at>CURRENT_TIMESTAMP
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
  /** `calendar_event_dismissals` rows of the feed. */
  dismissals: readonly { external_event_id: string }[];
  /** The owner's local date today (a series that ended before it is not proposed). */
  today: string;
  host: string | null;
  locations: readonly LocationRow[];
  defaults?: BufferDefaults | undefined;
}

export interface FeedSeriesPassResult {
  records: ImportRecord[];
  /** New series left unproposed because they already have changed dates (PR 8 applies those). */
  pending: number;
  /** Rules already on the plan whose feed side changed and was not applied (also a one-off link whose UID became a series). */
  changed: number;
}

/** One series create: the rule's columns from the descriptor, the place matched, the buffers defaulted. */
function seriesCreateRecord(
  stem: string,
  series: CalendarFeedSeries,
  args: Pick<FeedSeriesPassInput, "host" | "locations" | "defaults">
): ImportRecord {
  const snapshot = feedRuleSnapshot(series);
  const flat = flatFeedRule(snapshot);
  const evidence = [`Calendar feed${args.host ? ` · ${args.host}` : ""} · repeating event`];
  const place = snapshot.location;
  const record: ImportRecord = {
    id: crypto.randomUUID(),
    importKey: feedSeriesKey(stem),
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
    relationships: { feedSeries: stem },
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
 * The series pass over one read, pure: the held series creates, and the counts of what it left alone. Never reads or
 * writes the database; the caller loads `ruleLinks` (`loadFeedSeries`) and stores the records.
 */
export function feedSeriesPass(input: FeedSeriesPassInput): FeedSeriesPassResult {
  const byStem = new Map<string, FeedRuleLinkRow>();
  for (const link of input.ruleLinks) {
    const stem = stemOfRuleLink(link);
    if (stem !== null) byStem.set(stem, link);
  }
  const declined = new Set(input.dismissals.map((row) => row.external_event_id));
  const records: ImportRecord[] = [];
  const changed = new Set<string>(input.ownedLinkStems);
  let pending = 0;
  for (const stem of [...input.series.keys()].sort()) {
    const series = input.series.get(stem)!;
    const link = byStem.get(stem);
    if (link) {
      // An ended rule is the owner's (or a later change's) and is never recreated here.
      if (link.status === "active" && !feedSeriesUnchanged(series, link)) changed.add(stem);
      continue;
    }
    // Known limit (not fixed): when the owner deletes a rule outright, its link goes with it (cascade) but its
    // `import_entity_keys` row stays, so the UID reaches here as "no link" and the proposed create resolves as an update
    // of a rule that no longer exists, which the review shows as a confusing conflict. Ending the rule (status
    // `ended`) is the supported way and is handled above; a later change should clear the stale key on delete.
    if (declined.has(feedSeriesDismissalId(stem))) continue;
    // The UID has one-off commitments on the plan: a rule would materialise on top of them, so it is not proposed.
    // Counted as changed (the series is not followed) until a later change decides how to adopt it.
    if (input.ownedLinkStems.has(stem)) continue;
    // A cancelled master that was never imported, or a series that has already ended, is nothing to add.
    if (series.status === "cancelled") continue;
    if (series.endDate !== null && series.endDate < input.today) continue;
    if (series.exceptions.length > 0) {
      pending += 1;
      continue;
    }
    records.push(seriesCreateRecord(stem, series, input));
  }
  // A rule whose UID is still in the read as a series, but with no usable descriptor (it became unrepresentable, or
  // its descriptor could not be read): the shape changed under it, which PR 9 words as a card. Counted, not applied.
  for (const [stem, link] of byStem)
    if (link.status === "active" && input.seriesStems.has(stem) && !input.series.has(stem)) changed.add(stem);
  return { records, pending, changed: changed.size };
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
  args: { stem: string; series: CalendarFeedSeries }
): Promise<void> {
  const snapshot = feedLinkSnapshot(args.series);
  const { occurrences: _dates, ...compared } = snapshot;
  const hash = JSON.stringify(compared);
  await sql`
    INSERT INTO calendar_event_links(user_id,provider,role,frame_id,external_event_id,recurrence_rule_id,profile_label,last_remote_snapshot,last_remote_hash,last_seen_at)
    VALUES(${userId},${CALENDAR_FEED_PROVIDER},'secondary',${FEED_FRAME},${feedSeriesLinkId(args.stem)},${ruleId},'Calendar feed',${sql.json(snapshot as never)},${hash},CURRENT_TIMESTAMP)
    ON CONFLICT(user_id,provider,frame_id,external_event_id) DO UPDATE SET recurrence_rule_id=EXCLUDED.recurrence_rule_id,commitment_id=NULL,profile_label=EXCLUDED.profile_label,last_remote_snapshot=EXCLUDED.last_remote_snapshot || jsonb_build_object('occurrences', COALESCE(calendar_event_links.last_remote_snapshot->'occurrences', '{}'::jsonb)),last_remote_hash=EXCLUDED.last_remote_hash,last_seen_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
  `;
}
