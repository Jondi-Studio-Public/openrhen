import {
  commitmentOccurrenceRowId,
  commitmentRepeatFallsOn,
  monthAnchorSchema,
  repeatWeekdaysSchema,
  sourceLabel,
  zonedDateTime,
  type CommitmentRepeat,
  type ImportRecord
} from "@openrhen/contracts";
import type { CalendarFeedSeries, CalendarFeedSeriesException } from "@openrhen/contracts/integrations/calendar-feed";
import type { Sql } from "../sql-pool";
import { importField, savedPlaceMatching, type LocationRow } from "./calendar-diff-core";
import { CALENDAR_FEED_PROVIDER, FEED_FRAME, feedLocation, feedTitle } from "./calendar-profiles/calendar-feed";

/**
 * The calendar feed's date lifecycle (build plan PR 8): what a rule-backed series does about its changed dates. A date
 * the feed cancels or changes is one stored row of the rule (`schedule_source = 'custom'`, under the id the planner
 * would give that date), and the link remembers what the feed last said of it under `occurrences[<date>]`, so the
 * three-way rule the one-off diff applies tells a field the owner edited from one the feed is changing now.
 *
 * Pure apart from the three SQL helpers at the end. The pass itself (`feedSeriesPass`) calls `feedDateRecords`.
 */

/** `calendar_feed:occ:<ruleId>:<YYYY-MM-DD>`: the import key of one date of a rule (65 characters). */
export const FEED_OCC_PREFIX = `${CALENDAR_FEED_PROVIDER}:occ:`;
export const feedOccKey = (ruleId: string, date: string): string => `${FEED_OCC_PREFIX}${ruleId}:${date}`;
/** Exception rows are inserted only this far ahead; the planner's horizon is 180 days, and the margin keeps the edge row from being pruned. */
export const FEED_EXCEPTION_HORIZON_DAYS = 170;

/** The rule columns a date needs, as `FeedRuleLinkRow` reads them. */
export interface FeedDateRule {
  recurrence_rule_id: string;
  version: number;
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

/** One stored date of a rule, as the loader reads it. */
export interface FeedDateRow {
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

/** What a date holds and the feed controls (or the owner may edit): the unit the three-way compares and the link remembers. */
export interface DateSnapshot {
  title: string;
  startsAt: string;
  endsAt: string;
  status: string;
  location: string | null;
  setupBeforeMinutes: number;
  transitionAfterMinutes: number;
}

const snapshotKeys = [
  "title",
  "startsAt",
  "endsAt",
  "status",
  "location",
  "setupBeforeMinutes",
  "transitionAfterMinutes"
] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hhmm = (value: unknown) => String(value ?? "").slice(0, 5);

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The rule's repeat read back from its columns, or null when they do not form one. */
export function ruleRepeat(
  rule: Pick<
    FeedDateRule,
    "interval_unit" | "interval_days" | "interval_weeks" | "weekdays" | "interval_months" | "month_anchor"
  >
): CommitmentRepeat | null {
  if (rule.interval_unit === "weeks") {
    const weekdays = repeatWeekdaysSchema.safeParse(rule.weekdays);
    return weekdays.success && Number(rule.interval_weeks) > 0
      ? { unit: "weeks", intervalWeeks: Number(rule.interval_weeks), weekdays: weekdays.data }
      : null;
  }
  if (rule.interval_unit === "months") {
    const anchor = monthAnchorSchema.safeParse(rule.month_anchor);
    return anchor.success && Number(rule.interval_months) > 0
      ? { unit: "months", intervalMonths: Number(rule.interval_months), anchor: anchor.data }
      : null;
  }
  return Number(rule.interval_days) > 0 ? { unit: "days", intervalDays: Number(rule.interval_days) } : null;
}

/** Whether `date` is one of the rule's own dates today: on its repeat, on or after its start, not past its end. */
export function isRuleDate(rule: FeedDateRule, date: string): boolean {
  const repeat = ruleRepeat(rule);
  if (!repeat || date < rule.start_date || (rule.end_date !== null && date > rule.end_date)) return false;
  return commitmentRepeatFallsOn(repeat, rule.start_date, date);
}

/** The date as stored. */
export function rowSnapshot(row: FeedDateRow): DateSnapshot {
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

/** The date as the rule itself would generate it (what the planner writes for an unedited date). */
export function generatedSnapshot(rule: FeedDateRule, date: string): DateSnapshot {
  const start = zonedDateTime(date, hhmm(rule.local_start_time), rule.timezone);
  let end = zonedDateTime(date, hhmm(rule.local_end_time), rule.timezone);
  if (end <= start) end = zonedDateTime(addDays(date, 1), hhmm(rule.local_end_time), rule.timezone);
  return {
    title: rule.title,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    status: "confirmed",
    location: rule.location,
    setupBeforeMinutes: rule.setup_before_minutes,
    transitionAfterMinutes: rule.transition_after_minutes
  };
}

/** Whether a changed date stays on its own local day (an edit in place) rather than moving to another (a move). */
export const isMove = (exception: CalendarFeedSeriesException): boolean =>
  exception.kind === "changed" && exception.startDate !== exception.date;

/**
 * What the feed asks of a date, over `base` (the date as it is now). A cancel changes the status; an in-place change
 * replaces title, place and times. A move to another day cancels the original date.
 */
export function askedSnapshot(
  exception: CalendarFeedSeriesException,
  base: DateSnapshot,
  timezone: string
): DateSnapshot | null {
  // A date moved to another day is cancelled on its own day; the meeting itself is a one-off event (calendar-feed-moves.ts).
  if (exception.kind === "cancelled" || isMove(exception)) return { ...base, status: "cancelled" };
  return {
    ...base,
    title: feedTitle(exception.title),
    location: feedLocation(exception.location),
    startsAt: zonedDateTime(exception.startDate, exception.localStartTime, timezone).toISOString(),
    endsAt: zonedDateTime(exception.endDate, exception.localEndTime, timezone).toISOString(),
    status: "confirmed"
  };
}

/** The three-way merge of one date: `prior` is what the feed last wrote (or the date itself while nobody has edited it). */
export function mergeDate(current: DateSnapshot, asked: DateSnapshot, prior: Record<string, unknown>) {
  const wanted: Record<string, unknown> = { ...current };
  const conflicts: string[] = [];
  for (const name of snapshotKeys) {
    if (same(asked[name], prior[name])) continue;
    if (!same(current[name], prior[name]) && !same(asked[name], current[name])) conflicts.push(name);
    else wanted[name] = asked[name];
  }
  return { wanted: wanted as unknown as DateSnapshot, conflicts };
}

/**
 * The wording of a held conflict. The import validation keeps only the explanations it recognises (a conflict whose
 * errors it does not recognise is turned back into an ordinary update, which would overwrite the owner), and it
 * recognises a calendar source's by "changed in both <label> and ".
 */
/**
 * The relationships the review reads for a conflicted calendar record: `<prefix>ConflictFields` and `<prefix>Remote:<field>`,
 * where the prefix is the feed connection's relationship prefix (its id), as the per-instance path writes them.
 */
export const FEED_RELATIONSHIP_PREFIX = "calendar_feed";
export function conflictRelationships(
  fields: readonly string[],
  remote: (name: string) => unknown
): Record<string, string> {
  if (!fields.length) return {};
  return {
    [`${FEED_RELATIONSHIP_PREFIX}ConflictFields`]: fields.join("|"),
    ...Object.fromEntries(
      fields.map((name) => [`${FEED_RELATIONSHIP_PREFIX}Remote:${name}`, JSON.stringify(remote(name))])
    )
  };
}

export const feedConflictText = (subject: string, tail = "Choose which to keep."): string =>
  `${subject} changed in both ${sourceLabel(CALENDAR_FEED_PROVIDER)} and OpenRhen. ${tail}`;
const conflictText = (name: string) => feedConflictText(name);

function dateFields(snapshot: DateSnapshot, evidence: string[], scheduleSource: "custom" | "inherit") {
  const fields: ImportRecord["fields"] = Object.fromEntries(
    snapshotKeys.map((name) => [name, importField(snapshot[name], evidence)])
  );
  fields.scheduleSource = importField(scheduleSource, evidence);
  return fields;
}

/** The stored entries of `occurrences` on a link snapshot: date to what the feed last wrote for it. */
export function storedDates(snapshot: Record<string, unknown> | null): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const byDate = snapshot?.occurrences;
  if (!byDate || typeof byDate !== "object") return out;
  for (const [date, entry] of Object.entries(byDate as Record<string, unknown>))
    if (entry && typeof entry === "object") out.set(date, entry as Record<string, unknown>);
  return out;
}

/**
 * Whether the sync must hold a feed record for review even though it would otherwise apply on its own (the adapter's
 * `holds` hook). The series pass names itself on its records (`feedSeries`, and `feedMove` on a moved meeting's halves);
 * of those only a plain date cancel applies on its own. A per-instance event carries neither, so it is left as it was.
 */
export function feedHolds(record: Pick<ImportRecord, "relationships">): boolean {
  const rel = record.relationships;
  if (rel.feedSeries === undefined && rel.feedMove === undefined) return false;
  return !(rel.feedCancel === "true" && rel.feedMove === undefined);
}

export interface FeedDateInput {
  stem: string;
  series: CalendarFeedSeries;
  rule: FeedDateRule;
  /** The link's `last_remote_snapshot`. */
  snapshot: Record<string, unknown> | null;
  /** The rule's stored dates by local date. */
  rows: ReadonlyMap<string, FeedDateRow>;
  today: string;
  now: Date;
  locations: readonly LocationRow[];
  /** Dates whose moved meeting already exists as a one-off event on the plan: a record for one is a half of a move pair. */
  moveDates?: ReadonlySet<string>;
}

/** The id a moved date's two records share, so the review and the commit keep them together. */
export const feedMovePairId = (stem: string, date: string): string => `mv:${stem}:${date}`;

/**
 * Whether a date's record is half of a move pair: the feed moves the date and its meeting is not yet a one-off event
 * (the date's cancel goes with the replacement's create), or the feed no longer moves it and the replacement is still
 * there (the date's revert or in-place change goes with the replacement's removal). A date whose state already matches
 * its replacement (the owner edited it, say) is not a pair; its record stands alone.
 */
const isMoveDate = (input: Pick<FeedDateInput, "series" | "moveDates">, date: string): boolean =>
  input.series.exceptions.some((exception) => exception.date === date && isMove(exception)) !==
  (input.moveDates?.has(date) === true);

function baseRecord(
  input: FeedDateInput,
  date: string,
  fields: ImportRecord["fields"],
  extra: Partial<ImportRecord> & { relationships: Record<string, string | null> }
): ImportRecord {
  return {
    id: crypto.randomUUID(),
    importKey: feedOccKey(input.rule.recurrence_rule_id, date),
    entityType: "fixed_commitment",
    operation: "update",
    expectedVersion: null,
    matchedEntityId: null,
    fields,
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: 0,
    ...extra,
    relationships: {
      feedSeries: input.stem,
      feedRule: input.rule.recurrence_rule_id,
      feedDate: date,
      ...(isMoveDate(input, date) ? { feedMove: feedMovePairId(input.stem, date), feedMoveSize: "2" } : {}),
      ...extra.relationships
    }
  };
}

/**
 * The records for every date of one rule that differs from the feed. A cancel that has no conflict is `feedCancel` (the
 * sync applies it on its own); everything else is held. Dates before today and dates already under way are left alone.
 */
export function feedDateRecords(input: FeedDateInput): { records: ImportRecord[] } {
  const { series, rule, rows, today, now } = input;
  const horizonEnd = addDays(today, FEED_EXCEPTION_HORIZON_DAYS);
  const priors = storedDates(input.snapshot);
  const exceptions = new Map(series.exceptions.map((exception) => [exception.date, exception]));
  const dates = [...new Set([...exceptions.keys(), ...priors.keys()])].filter((date) => date >= today).sort();
  const records: ImportRecord[] = [];
  for (const date of dates) {
    const exception = exceptions.get(date);
    const prior = priors.get(date);
    const row = rows.get(date);
    if (row && row.starts_at.getTime() <= now.getTime()) continue;
    if (exception) {
      if (!row && date > horizonEnd) continue;
      if (!isRuleDate(rule, date)) continue;
      const current = row ? rowSnapshot(row) : generatedSnapshot(rule, date);
      if (!row && new Date(current.startsAt).getTime() <= now.getTime()) continue;
      const asked = askedSnapshot(exception, current, series.timezone)!;
      const evidence = [
        isMove(exception)
          ? "Moved to another day in the calendar feed"
          : exception.kind === "cancelled"
            ? "Cancelled for this date in the calendar feed"
            : "Changed for this date in the calendar feed"
      ];
      const cancel = exception.kind === "cancelled" || isMove(exception);
      if (!row) {
        if (same(asked, current)) continue;
        const fields = dateFields(asked, evidence, "custom");
        if (asked.location !== current.location)
          fields.locationId = savedPlaceMatching.field(asked.location, input.locations);
        else if (rule.location_id) fields.locationId = importField(rule.location_id, evidence);
        records.push(
          baseRecord(input, date, fields, {
            operation: "create",
            relationships: { feedInsert: "true", ...(cancel ? { feedCancel: "true" } : {}) }
          })
        );
        continue;
      }
      // A still-inherit date has no owner edits, so it is its own prior; a custom date with nothing remembered was edited by the owner.
      const known: Record<string, unknown> | null =
        row.schedule_source !== "custom" ? (current as unknown as Record<string, unknown>) : (prior ?? null);
      if (known === null) {
        if (same(asked, current)) continue;
        // Nothing remembers what the feed said, so every field the feed would change is a choice: keep the plan's value or take the feed's.
        const names = snapshotKeys.filter((name) => !same(asked[name], current[name]));
        records.push(
          baseRecord(input, date, dateFields(current, evidence, "custom"), {
            operation: "conflict",
            expectedVersion: row.version,
            matchedEntityId: row.id,
            relationships: {
              feedOccurrence: row.id,
              ...(cancel ? { feedCancel: "true" } : {}),
              ...conflictRelationships(names, (name) => asked[name as keyof DateSnapshot])
            },
            errors: names.map((name) => feedConflictText(name))
          })
        );
        continue;
      }
      const { wanted, conflicts } = mergeDate(current, asked, known);
      if (!conflicts.length && same(wanted, current)) continue;
      const fields = dateFields(wanted, evidence, "custom");
      if (wanted.location !== current.location)
        fields.locationId = savedPlaceMatching.field(wanted.location, input.locations);
      records.push(
        baseRecord(input, date, fields, {
          operation: conflicts.length ? "conflict" : "update",
          expectedVersion: row.version,
          matchedEntityId: row.id,
          relationships: {
            feedOccurrence: row.id,
            ...(cancel ? { feedCancel: "true" } : {}),
            ...conflictRelationships(conflicts, (name) => asked[name as keyof DateSnapshot])
          },
          errors: conflicts.map(conflictText)
        })
      );
      continue;
    }
    // No exception now, but the feed once asked for one here: put the date back with the series, unless the owner changed it since.
    if (!prior || !row) continue;
    if (row.schedule_source !== "custom" && row.status === "confirmed") continue;
    const current = rowSnapshot(row);
    const generated = generatedSnapshot(rule, date);
    const evidence = ["Back to the series: the calendar feed no longer changes this date"];
    const edited = snapshotKeys.some((name) => !same(current[name], prior[name]));
    // An edited date keeps the owner's values until each field is chosen; it stays the owner's (custom) either way.
    const names = edited ? snapshotKeys.filter((name) => !same(generated[name], current[name])) : [];
    const conflict = edited && names.length > 0;
    const fields = dateFields(conflict ? current : generated, evidence, conflict ? "custom" : "inherit");
    if (rule.location_id) fields.locationId = importField(rule.location_id, evidence);
    records.push(
      baseRecord(input, date, fields, {
        operation: conflict ? "conflict" : "update",
        expectedVersion: row.version,
        matchedEntityId: row.id,
        relationships: {
          feedOccurrence: row.id,
          feedRevert: "true",
          ...(conflict ? conflictRelationships(names, (name) => generated[name as keyof DateSnapshot]) : {})
        },
        errors: conflict
          ? names.map((name) => feedConflictText(name, "The feed no longer changes it. Choose which to keep."))
          : []
      })
    );
  }
  return { records };
}

/**
 * Inserts one stored date of a rule under the id the planner would give it (`commitmentOccurrenceRowId`, never the raw
 * `ruleId:date`: any other id collides on the `(recurrence_rule_id, local_date)` unique index at the next replan), with
 * every NOT NULL column filled as the planner's own insert does. A date the planner generated meanwhile (still inherit) is overwritten
 * with the exception, which is what the feed asked for; a row already custom (the owner's edit, or an earlier exception) is
 * never overwritten. Returns the row's id.
 */
export async function insertFeedDate(
  sql: Sql,
  userId: string,
  ruleId: string,
  date: string,
  snapshot: DateSnapshot,
  locationId: string | null
): Promise<string> {
  const id = commitmentOccurrenceRowId(ruleId, date);
  await sql`
    INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status,location,location_id,setup_before_minutes,transition_after_minutes,presence,presence_source,recurrence_rule_id,local_date,project_id,routine_source,routine_preset_id,share_to_calendar,share_source,schedule_source,lateness_matters,transport_mode,contact_id)
    SELECT ${id},r.user_id,${snapshot.title},${new Date(snapshot.startsAt)},${new Date(snapshot.endsAt)},${snapshot.status},${snapshot.location},${locationId},${snapshot.setupBeforeMinutes},${snapshot.transitionAfterMinutes},COALESCE(r.presence,'blocking'),'inherit',r.id,${date}::date,r.project_id,r.routine_source,r.routine_preset_id,r.share_to_calendar,'inherit','custom',r.lateness_matters,r.transport_mode,r.contact_id
    FROM commitment_recurrence_rules r WHERE r.id=${ruleId} AND r.user_id=${userId}
    ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,status=EXCLUDED.status,location=EXCLUDED.location,location_id=EXCLUDED.location_id,setup_before_minutes=EXCLUDED.setup_before_minutes,transition_after_minutes=EXCLUDED.transition_after_minutes,schedule_source='custom',version=commitments.version+1,updated_at=CURRENT_TIMESTAMP WHERE commitments.schedule_source <> 'custom'
  `;
  return id;
}

/**
 * Writes the link's `occurrences` in one statement: entries for `set`, none for `drop`, and every entry before the rule's
 * local today removed (a past exception is pruned on any touch, including a rule-only change). The cut-off is read in the
 * rule's own zone. Without a link nothing is written.
 */
export async function touchFeedDates(
  sql: Sql,
  userId: string,
  linkId: string,
  change: { set?: Record<string, Record<string, unknown>>; drop?: readonly string[] } = {}
): Promise<void> {
  const set = change.set ?? {};
  const drop = [...(change.drop ?? []), ...Object.keys(set)];
  await sql`
    UPDATE calendar_event_links l SET
      last_remote_snapshot = l.last_remote_snapshot || jsonb_build_object('occurrences',
        COALESCE((
          SELECT jsonb_object_agg(e.key, e.value)
          FROM jsonb_each(COALESCE(l.last_remote_snapshot->'occurrences', '{}'::jsonb)) AS e(key, value)
          WHERE e.key >= ((CURRENT_TIMESTAMP AT TIME ZONE r.timezone)::date)::text AND NOT (${sql.json(drop as never)}::jsonb @> to_jsonb(e.key))
        ), '{}'::jsonb) || ${sql.json(set as never)}::jsonb),
      updated_at = CURRENT_TIMESTAMP
    FROM commitment_recurrence_rules r
    WHERE r.id = l.recurrence_rule_id AND l.user_id=${userId} AND l.provider=${CALENDAR_FEED_PROVIDER} AND l.frame_id=${FEED_FRAME} AND l.external_event_id=${linkId}
  `;
}
