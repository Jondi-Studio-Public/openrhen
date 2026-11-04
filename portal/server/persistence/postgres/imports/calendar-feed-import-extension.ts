import { userPreferences } from "@openrhen/database";
import type { ImportRecord, PreviewImport } from "@openrhen/contracts";
import type { CalendarFeedSeries } from "@openrhen/contracts/integrations/calendar-feed";
import type { Row } from "../db-row";
import { ensureUser } from "../state-store";
import type { PostgresImportStore } from "../import-store";
import {
  calendarDiffRecords,
  profileFor,
  type CalendarDiffInput,
  type CalendarDismissalRow,
  type CalendarLinkRow
} from "./calendar-diff";
import type { LocationRow } from "./calendar-diff-core";
import {
  CALENDAR_FEED_PROVIDER,
  FEED_EVENT_PREFIX,
  FEED_FRAME,
  FEED_SERIES_PREFIX,
  applyFeedDemotions,
  feedCommitmentCollisions,
  feedGenerationOfKey,
  feedReadComplete,
  feedStemOf,
  feedSyncSourceText,
  limitFeedRecords,
  linkCalendarFeedCommitment,
  splitSeriesOwnedLinks,
  type FeedNotImported,
  type FeedSource,
  type PreparedFeedRead
} from "./calendar-profiles/calendar-feed";
import {
  FEED_EXCEPTION_HORIZON_DAYS,
  FEED_OCC_PREFIX,
  addDays,
  askedSnapshot,
  generatedSnapshot,
  insertFeedDate,
  isMove,
  isRuleDate,
  rowSnapshot,
  touchFeedDates,
  type FeedDateRow
} from "./calendar-feed-dates";
import {
  feedSeriesPass,
  linkCalendarFeedRule,
  loadFeedSeries,
  ruleLinkIdentity,
  type FeedRuleLinkRow
} from "./calendar-feed-series";
import { forgetKeptEnds, recordFeedChoices, repairStaleFeedKeys, settleRuleEnds } from "./calendar-feed-lifecycle";
import { keepWholeMovePairs, linkMoveDate, tagMoveRecord } from "./calendar-feed-moves";
import { detachStartedOccurrences } from "../recurrence-commands";
import { registerImportExtension, type ImportRecordContext } from "./import-extensions";
import { registerStoreMethods } from "./store-methods";
import { localDateIn } from "./source-match-records";
import { loadCommitmentLinks, loadMatchContext, matchWindow } from "./source-links";

// The calendar feed is a core connection, not a private one: this module is imported by the import store and the
// commit (beside, not inside, `private/index.ts`), so it registers in a build whose private seam is empty.

declare module "./import-extensions" {
  interface ExtensionLinkSources {
    calendar_feed: FeedSource;
  }
}

interface DiffFeedArgs {
  timezone: string;
  /** The window that was read: inclusive lower and exclusive upper instant. */
  timeMin: string;
  timeMax: string;
  prepared: PreparedFeedRead;
}

declare module "../import-store" {
  interface PostgresImportStore {
    /**
     * The sync's diff for the calendar feed: the non-recurring events' creates, updates, conflicts and removals, and the
     * series pass's held rule creates, together inside the batch ceilings, with a way to build a preview from any
     * subset of the records.
     */
    diffCalendarFeed(args: DiffFeedArgs): Promise<{
      records: ImportRecord[];
      previewFor: (records: ImportRecord[]) => PreviewImport;
      notImported: FeedNotImported;
    }>;
  }
}

/** The rows a feed diff reads besides the events themselves. */
async function feedDiffContext(store: PostgresImportStore, userId: string, args: DiffFeedArgs) {
  const { sql } = store;
  const defaults = await sql<
    Row<typeof userPreferences, "default_setup_buffer_minutes" | "default_transition_buffer_minutes">[]
  >`SELECT default_setup_buffer_minutes,default_transition_buffer_minutes FROM user_preferences WHERE user_id=${userId}`;
  const locations = await sql<
    LocationRow[]
  >`SELECT * FROM condition_definitions WHERE user_id=${userId} AND kind='location' AND status='active'`;
  const presetSteps = await sql<
    any[]
  >`SELECT s.* FROM routine_preset_steps s JOIN routine_presets p ON p.id=s.preset_id WHERE p.user_id=${userId} AND p.status='active' ORDER BY s.preset_id,s.sequence`;
  const presetDependencies = await sql<
    any[]
  >`SELECT d.step_id,d.depends_on_step_id FROM routine_preset_step_dependencies d JOIN routine_preset_steps s ON s.id=d.step_id JOIN routine_presets p ON p.id=s.preset_id WHERE p.user_id=${userId}`;
  // Only one-off links: a link to a rule (the series pass) has no commitment to join and is never read as absent here.
  const links = await sql<CalendarLinkRow[]>`
    SELECT l.*, fc.title, fc.starts_at, fc.ends_at, fc.status, fc.location, fc.setup_before_minutes, fc.transition_after_minutes, fc.version
    FROM calendar_event_links l JOIN commitments fc ON fc.id=l.commitment_id
    WHERE l.user_id=${userId} AND l.provider=${CALENDAR_FEED_PROVIDER} AND l.frame_id=${FEED_FRAME}
  `;
  // The per-instance path never groups (`seriesKey` is null), so it reads none; the series pass has its own loader.
  const importedSeriesKeys = new Set<string>();
  const dismissals = await sql<
    CalendarDismissalRow[]
  >`SELECT external_event_id,title,starts_at FROM calendar_event_dismissals WHERE user_id=${userId} AND provider=${CALENDAR_FEED_PROVIDER}`;
  const matchContext = await loadMatchContext(sql, {
    userId,
    ...matchWindow(
      localDateIn(new Date(args.timeMin), args.timezone),
      localDateIn(new Date(args.timeMax), args.timezone)
    ),
    timezone: args.timezone
  });
  const commitmentLinks = await loadCommitmentLinks(sql, {
    userId,
    commitmentIds: links.map((row) => row.commitment_id)
  });
  return {
    links,
    importedSeriesKeys,
    dismissals,
    matchContext,
    commitmentLinks,
    locations,
    presetSteps,
    presetDependencies,
    defaults: defaults[0]
  };
}

registerStoreMethods({
  async diffCalendarFeed(this: PostgresImportStore, args: DiffFeedArgs) {
    const userId = await ensureUser(this.sql);
    const { prepared } = args;
    // Rows an owner's deletion left behind (a rule, a moved meeting's replacement) are cleared first, so the proposals
    // below resolve against what exists; a deleted rule also declines its UID.
    await repairStaleFeedKeys(this.sql, userId, [...prepared.series.keys(), ...prepared.seriesStems]);
    const loaded = await feedDiffContext(this, userId, args);
    const profile = profileFor(CALENDAR_FEED_PROVIDER);
    // A one-off link whose UID is now a set-aside series is the series pass's: out of the per-instance diff, so it is
    // neither read as absent nor holds the read incomplete.
    const {
      links: oneOffLinks,
      ownedStems,
      moveDates,
      ownedLatestStart
    } = splitSeriesOwnedLinks(loaded.links, prepared.seriesStems);
    const context = { ...loaded, links: oneOffLinks };
    const host = prepared.host ?? "";
    const base = {
      timezone: args.timezone,
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      // The host names the frame in the review evidence, whatever calendar id (if any) an event carries.
      calendarNames: {
        "": host,
        ...Object.fromEntries(prepared.events.flatMap((e) => (e.calendarId ? [[e.calendarId, host]] : [])))
      },
      ...context
    };
    const loadedSeries = await loadFeedSeries(this.sql, userId);
    const { occurrences } = loadedSeries;
    // A rule found ended with no record of who ended it was the owner's: written down, and its UID declined.
    const ruleLinks = await settleRuleEnds(this.sql, userId, loadedSeries.ruleLinks);
    const seriesDismissals = await this.sql<
      CalendarDismissalRow[]
    >`SELECT external_event_id,title,starts_at FROM calendar_event_dismissals WHERE user_id=${userId} AND provider=${CALENDAR_FEED_PROVIDER}`;
    // The UID of every event of any kind in this read, and whether the read can speak for a UID being absent: the whole
    // transport complete and nothing left unreadable that could be it (a series rule ends only on that evidence).
    const presentStems = new Set([
      ...prepared.events.map((event) => feedStemOf(event.externalEventId)),
      ...prepared.seriesStems
    ]);
    const hidden = new Set<string | null>([...prepared.skippedPrefixes, ...prepared.unreadableStems]);
    // An empty valid read (no event of any kind) says nothing about any UID: a series rule is never ended by it.
    const nonEmpty = prepared.rawEventCount > 0 || prepared.events.length > 0 || prepared.series.size > 0;
    const absenceKnown = (stem: string) =>
      nonEmpty && prepared.transportComplete && !prepared.readIncomplete && !hidden.has(null) && !hidden.has(stem);
    const seriesOut = feedSeriesPass({
      series: prepared.series,
      seriesStems: prepared.seriesStems,
      ownedLinkStems: ownedStems,
      ruleLinks,
      dismissals: seriesDismissals,
      today: localDateIn(new Date(), args.timezone),
      host: prepared.host,
      locations: context.locations,
      defaults: context.defaults,
      occurrences,
      now: new Date(),
      window: {
        startDate: localDateIn(new Date(args.timeMin), args.timezone),
        endDate: localDateIn(new Date(args.timeMax), args.timezone)
      },
      presentStems,
      absenceKnown,
      moveDates,
      ownedLatestStart,
      unrepresentableReasons: prepared.unrepresentableReasons,
      trusted: (stem: string) =>
        prepared.transportComplete && !prepared.readIncomplete && !hidden.has(null) && !hidden.has(stem)
    });
    // A kept end whose condition has gone (the feed changed it back) is forgotten, so a later change asks again.
    await forgetKeptEnds(this.sql, userId, seriesOut.clearKeep);
    // The meetings of dates the feed moved to another day are one-off events beside the read's own.
    const events = [...prepared.events, ...seriesOut.moveEvents.map((move) => move.event)];
    const eventsById = new Map(events.map((event) => [event.externalEventId, event]));
    // Every replacement the read or the plan has, by id, so its record can be named as half of a pair.
    const replacements = new Map<string, string>(
      seriesOut.moveEvents.map((move) => [move.event.externalEventId, move.date])
    );
    for (const link of loaded.links) {
      const from = linkMoveDate(link.last_remote_snapshot);
      if (from) replacements.set(link.external_event_id, from);
    }
    const tagged = (records: ImportRecord[]) =>
      records.map((record) => tagMoveRecord(record, replacements, FEED_EVENT_PREFIX));
    // A moved meeting whose date was cancelled in the feed, or whose repeating event ended or vanished, has its
    // replacement removed with no revert of the date to pair with: the removal stays a held record with this note
    // instead of vanishing, so the meeting is never dropped from the plan without the owner seeing it.
    const orphanNote = (record: ImportRecord): string | null => {
      const id = record.importKey.slice(FEED_EVENT_PREFIX.length);
      const date = replacements.get(id);
      if (!date) return null;
      const stem = feedStemOf(id);
      const series = prepared.series.get(stem);
      const link = ruleLinks.find((row) => ruleLinkIdentity(row)?.stem === stem);
      let cause: string | null = null;
      if (series?.status === "cancelled") cause = "The calendar feed cancelled this whole repeating event.";
      else if (series?.exceptions.some((e) => e.date === date && e.kind === "cancelled"))
        cause = "The calendar feed cancelled this date after moving it.";
      else if (!series && !prepared.seriesStems.has(stem) && link && link.status !== "active")
        cause = "The repeating entry it belongs to has ended and the feed no longer has it.";
      else if (!series && !prepared.seriesStems.has(stem) && !presentStems.has(stem))
        cause = "The repeating event it belongs to is no longer in the calendar feed.";
      return cause
        ? `${cause} The original day (${date}) was cancelled when this meeting was moved and stays cancelled, so removing the moved meeting leaves nothing on your plan for it. Leave this row ticked to delete the moved meeting, or remove this row to keep it.`
        : null;
    };
    const build = (complete: boolean): ImportRecord[] => {
      const input: CalendarDiffInput = { ...base, events, complete };
      const records = calendarDiffRecords(input, profile);
      // Two feed events matching one plan commitment would both link and abort the commit: only one keeps the match.
      const demote = feedCommitmentCollisions(records);
      if (!demote.size)
        return keepWholeMovePairs([...tagged(records), ...seriesOut.records], FEED_EVENT_PREFIX, orphanNote);
      const plain = calendarDiffRecords(
        {
          ...input,
          only: "new",
          matchContext: undefined,
          events: events.filter((event) => demote.has(`${FEED_EVENT_PREFIX}${event.externalEventId}`))
        },
        profile
      );
      const byKey = new Map(plain.map((record) => [record.importKey, record]));
      return keepWholeMovePairs(
        [...tagged(applyFeedDemotions(records, demote, byKey)), ...seriesOut.records],
        FEED_EVENT_PREFIX,
        orphanNote
      );
    };
    const startOf = (record: ImportRecord): string => {
      if (record.importKey.startsWith(FEED_OCC_PREFIX)) return record.relationships.feedDate ?? "";
      if (record.importKey.startsWith(FEED_SERIES_PREFIX))
        return (
          prepared.series.get(record.relationships.feedSeries ?? record.importKey.slice(FEED_SERIES_PREFIX.length))
            ?.startDate ?? ""
        );
      if (!record.importKey.startsWith(FEED_EVENT_PREFIX)) return "";
      const id = record.importKey.slice(FEED_EVENT_PREFIX.length);
      const own = eventsById.get(id)?.startsAt;
      if (own) return new Date(own).toISOString();
      const link = context.links.find((row) => row.external_event_id === id);
      const prior = link?.last_remote_snapshot?.startsAt;
      return typeof prior === "string" ? prior : "";
    };
    const textFor = (subset: readonly ImportRecord[]) =>
      feedSyncSourceText({ events, records: subset, series: prepared.series });

    let complete = feedReadComplete(prepared, context.links, args);
    let { kept, dropped } = limitFeedRecords(build(complete), startOf, textFor);
    if (dropped > 0 && complete) {
      // Past the ceilings the read cannot be called complete: no absence delete is proposed, whichever records are kept.
      complete = false;
      ({ kept, dropped } = limitFeedRecords(build(false), startOf, textFor));
    }
    const records = kept.map((record, index) => ({ ...record, sortOrder: index }));
    // A record for one date of a rule names a row the planner materialised, not something an import created, so its key
    // is mapped here for `resolveOperations` to match it as an update of that row (it can't wait for the commit: the
    // preview resolves operations now, and an unmapped key reads as a create). A date with no row yet (inserted at the
    // commit) must have no stale mapping, which would resolve as an update of a row that does not exist.
    for (const record of records) {
      const rowId = record.relationships.feedOccurrence;
      if (rowId)
        await this
          .sql`INSERT INTO import_entity_keys (user_id, entity_type, import_key, entity_id) VALUES (${userId}, 'fixed_commitment', ${record.importKey}, ${rowId}) ON CONFLICT (user_id, entity_type, import_key) DO UPDATE SET entity_id=EXCLUDED.entity_id, updated_at=CURRENT_TIMESTAMP`;
      else if (record.relationships.feedInsert)
        await this
          .sql`DELETE FROM import_entity_keys WHERE user_id=${userId} AND entity_type='fixed_commitment' AND import_key=${record.importKey}`;
    }
    return {
      records,
      notImported: {
        ...prepared.notImported,
        seriesPending: seriesOut.pending,
        seriesChanged: seriesOut.changed,
        droppedForSize: dropped
      },
      previewFor: (subset: ImportRecord[]): PreviewImport => ({
        sourceType: CALENDAR_FEED_PROVIDER,
        inputKind: "calendar_updates",
        timezone: args.timezone,
        templateVersion: "1",
        records: subset.map((record, index) => ({ ...record, sortOrder: index })),
        source: { text: textFor(subset) }
      })
    };
  }
});

const FEED_RULE_COLUMNS_SQL = `r.id AS recurrence_rule_id, r.version, r.title, r.timezone, r.start_date::text AS start_date, r.end_date::text AS end_date, r.interval_unit::text AS interval_unit, r.interval_days, r.interval_weeks, r.weekdays, r.interval_months, r.month_anchor::text AS month_anchor, r.local_start_time::text AS local_start_time, r.local_end_time::text AS local_end_time, r.location, r.location_id, r.setup_before_minutes, r.transition_after_minutes`;

/**
 * A series create: inserts the exceptions the descriptor already holds for the dates that matter. A cancelled date or a
 * change in place becomes a stored row of the rule (custom, under the planner's own id) inside the 170-day horizon, with
 * its entry on the link's `occurrences` written in the same transaction, so the next sync sees nothing to do. A move to
 * another day and a date past the horizon stay pending and are proposed (or inserted) on a later sync.
 */
async function insertCreatedExceptions(
  sql: ImportRecordContext["sql"],
  userId: string,
  ruleId: string,
  series: CalendarFeedSeries
): Promise<void> {
  if (!series.exceptions.length) return;
  const rules = await sql<Array<FeedRuleLinkRow & { recurrence_rule_id: string }>>`
    SELECT ${sql.unsafe(FEED_RULE_COLUMNS_SQL)} FROM commitment_recurrence_rules r WHERE r.id=${ruleId}
  `;
  const rule = rules[0];
  if (!rule) return;
  const now = new Date();
  const today = localDateIn(now, rule.timezone);
  const horizonEnd = addDays(today, FEED_EXCEPTION_HORIZON_DAYS);
  const set: Record<string, Record<string, unknown>> = {};
  for (const exception of series.exceptions) {
    const date = exception.date;
    if (date < today || date > horizonEnd || isMove(exception) || !isRuleDate(rule, date)) continue;
    const generated = generatedSnapshot(rule, date);
    if (new Date(generated.startsAt).getTime() <= now.getTime()) continue;
    const asked = askedSnapshot(exception, generated, rule.timezone)!;
    await insertFeedDate(sql, userId, ruleId, date, asked, asked.location === rule.location ? rule.location_id : null);
    set[date] = asked as unknown as Record<string, unknown>;
  }
  await touchFeedDates(sql, userId, ruleId, { set });
}

/**
 * A record for one date of a rule, once its row is written: a date with no row yet is replaced by the row the planner
 * would own (the generic commit made a plain commitment under a random id), and the link remembers what the feed said of
 * the date, from the batch's own descriptor (never the record, which the review can edit). A revert forgets the date.
 */
async function afterFeedDate(context: ImportRecordContext): Promise<void> {
  const { sql, userId, record, value } = context;
  const rel = record.relationships;
  const stem = rel.feedSeries;
  const date = rel.feedDate;
  const ruleId = rel.feedRule;
  if (!stem || !date || !ruleId) return;
  let rowId = context.id;
  if (rel.feedInsert === "true") {
    await sql`DELETE FROM commitments WHERE id=${context.id} AND user_id=${userId} AND recurrence_rule_id IS NULL`;
    const locationId = value("locationId");
    rowId = await insertFeedDate(
      sql,
      userId,
      ruleId,
      date,
      {
        title: String(value("title")),
        startsAt: new Date(String(value("startsAt"))).toISOString(),
        endsAt: new Date(String(value("endsAt"))).toISOString(),
        status: String(value("status") ?? "confirmed"),
        location: (value("location") as string | null) ?? null,
        setupBeforeMinutes: Number(value("setupBeforeMinutes") ?? 0),
        transitionAfterMinutes: Number(value("transitionAfterMinutes") ?? 0)
      },
      typeof locationId === "string" && locationId ? locationId : null
    );
  }
  if (rel.feedRevert === "true") {
    await touchFeedDates(sql, userId, ruleId, { drop: [date] });
    return;
  }
  const series = (context.linkSource as FeedSource).series?.[stem];
  const exception = series?.exceptions.find((candidate) => candidate.date === date);
  const rows = await sql<FeedDateRow[]>`
    SELECT id, recurrence_rule_id, local_date::text AS local_date, title, starts_at, ends_at, status, location, location_id, setup_before_minutes, transition_after_minutes, schedule_source, version
    FROM commitments WHERE id=${rowId} AND user_id=${userId}
  `;
  if (!rows[0]) return;
  const committed = rowSnapshot(rows[0]);
  const entry = (series && exception ? askedSnapshot(exception, committed, series.timezone) : null) ?? committed;
  await touchFeedDates(sql, userId, ruleId, { set: { [date]: entry as unknown as Record<string, unknown> } });
}

registerImportExtension({
  id: CALENDAR_FEED_PROVIDER,
  sourceTypes: [CALENDAR_FEED_PROVIDER],
  linkImportKey: (_provider, _frameId, externalEventId) => `${FEED_EVENT_PREFIX}${externalEventId}`,
  async beforeRecord(context) {
    // A feed rule's change reaches only dates still to come: past and under-way dates are detached first, so the replan
    // leaves them as they were.
    if (
      context.type === "fixed_commitment_recurrence" &&
      context.record.operation === "update" &&
      context.record.importKey.startsWith(FEED_SERIES_PREFIX)
    )
      await detachStartedOccurrences(context.sql, context.userId, context.id);
  },
  async afterRecord(context) {
    const { sql, userId, id, type, record } = context;
    const source = context.linkSource as FeedSource;
    // A series create or update: the rule is linked from the descriptor the batch kept, by the stem its key carries.
    if (type === "fixed_commitment_recurrence" && record.importKey.startsWith(FEED_SERIES_PREFIX)) {
      // The record names its stem; its key says which generation of that UID's rule it is (a stem is never read out of a key).
      const stem = record.relationships.feedSeries ?? record.importKey.slice(FEED_SERIES_PREFIX.length);
      const generation = feedGenerationOfKey(record.importKey, stem);
      const series = source.series?.[stem];
      // Without the descriptor the rule would be written unlinked, and the next run would propose it again.
      if (!series || generation === null)
        throw new Error("The repeating event's description is missing from its import batch.");
      await linkCalendarFeedRule(sql, userId, id, { stem, series, generation });
      if (record.operation === "create") await insertCreatedExceptions(sql, userId, id, series);
      return;
    }
    if (type === "fixed_commitment" && record.importKey.startsWith(FEED_OCC_PREFIX)) {
      await afterFeedDate(context);
      return;
    }
    if (!(type === "fixed_commitment" && record.importKey.startsWith(FEED_EVENT_PREFIX))) return;
    const externalId = record.importKey.slice(FEED_EVENT_PREFIX.length);
    const event = source.events[externalId];
    if (event) await linkCalendarFeedCommitment(sql, userId, id, externalId, event, record.operation === "link");
    // The replacement of a moved date remembers which date it replaces, so the next sync pairs it with that date.
    const movedFrom = record.relationships.feedMoveOf;
    if (event && movedFrom)
      await sql`
        UPDATE calendar_event_links SET last_remote_snapshot = COALESCE(last_remote_snapshot, '{}'::jsonb) || ${sql.json({ feedMoveOf: movedFrom })}::jsonb
        WHERE user_id=${userId} AND provider=${CALENDAR_FEED_PROVIDER} AND frame_id=${FEED_FRAME} AND external_event_id=${externalId}
      `;
  },
  // A link the commitment guard skipped must not leave the commit's key map pointing the event at that commitment: a
  // later create of the same event would then resolve as an update of it. A date inserted by the commit has no key of
  // its own either (the generic commit mapped it to a row it replaced; the diff maps it again once the row exists).
  async afterCommit(tx, { userId, ready, records, linkSource }) {
    // Who ended a rule, which end the owner kept, which dates the owner kept as they are.
    await recordFeedChoices(tx, userId, { records, ready, linkSource });
    const keys = ready
      .filter(
        (record) =>
          record.entityType === "fixed_commitment" &&
          record.operation === "link" &&
          record.importKey.startsWith(FEED_EVENT_PREFIX)
      )
      .map((record) => record.importKey);
    for (const key of keys)
      await tx`
        DELETE FROM import_entity_keys
        WHERE user_id=${userId} AND entity_type='fixed_commitment' AND import_key=${key}
          AND NOT EXISTS (
            SELECT 1 FROM calendar_event_links
            WHERE user_id=${userId} AND provider=${CALENDAR_FEED_PROVIDER} AND external_event_id=${key.slice(FEED_EVENT_PREFIX.length)}
          )
      `;
    const inserted = ready
      .filter((record) => record.entityType === "fixed_commitment" && record.relationships.feedInsert === "true")
      .map((record) => record.importKey);
    if (inserted.length)
      await tx`DELETE FROM import_entity_keys WHERE user_id=${userId} AND entity_type='fixed_commitment' AND import_key IN ${tx(inserted)}`;
    return undefined;
  }
});
