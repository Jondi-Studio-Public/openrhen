import { userPreferences } from "@openrhen/database";
import type { ImportRecord, PreviewImport } from "@openrhen/contracts";
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
  feedReadComplete,
  feedSyncSourceText,
  limitFeedRecords,
  linkCalendarFeedCommitment,
  splitSeriesOwnedLinks,
  type FeedNotImported,
  type FeedSource,
  type PreparedFeedRead
} from "./calendar-profiles/calendar-feed";
import { feedSeriesPass, linkCalendarFeedRule, loadFeedSeries } from "./calendar-feed-series";
import { registerImportExtension } from "./import-extensions";
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
    const loaded = await feedDiffContext(this, userId, args);
    const profile = profileFor(CALENDAR_FEED_PROVIDER);
    const { prepared } = args;
    // A one-off link whose UID is now a set-aside series is the series pass's: out of the per-instance diff, so it is
    // neither read as absent nor holds the read incomplete.
    const { links: oneOffLinks, ownedStems } = splitSeriesOwnedLinks(loaded.links, prepared.seriesStems);
    const context = { ...loaded, links: oneOffLinks };
    const eventsById = new Map(prepared.events.map((event) => [event.externalEventId, event]));
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
    const { ruleLinks } = await loadFeedSeries(this.sql, userId);
    const seriesOut = feedSeriesPass({
      series: prepared.series,
      seriesStems: prepared.seriesStems,
      ownedLinkStems: ownedStems,
      ruleLinks,
      dismissals: context.dismissals,
      today: localDateIn(new Date(), args.timezone),
      host: prepared.host,
      locations: context.locations,
      defaults: context.defaults
    });
    const build = (complete: boolean): ImportRecord[] => {
      const input: CalendarDiffInput = { ...base, events: prepared.events, complete };
      const records = calendarDiffRecords(input, profile);
      // Two feed events matching one plan commitment would both link and abort the commit: only one keeps the match.
      const demote = feedCommitmentCollisions(records);
      if (!demote.size) return [...records, ...seriesOut.records];
      const plain = calendarDiffRecords(
        {
          ...input,
          only: "new",
          matchContext: undefined,
          events: prepared.events.filter((event) => demote.has(`${FEED_EVENT_PREFIX}${event.externalEventId}`))
        },
        profile
      );
      const byKey = new Map(plain.map((record) => [record.importKey, record]));
      return [...applyFeedDemotions(records, demote, byKey), ...seriesOut.records];
    };
    const startOf = (record: ImportRecord): string => {
      if (record.importKey.startsWith(FEED_SERIES_PREFIX))
        return prepared.series.get(record.importKey.slice(FEED_SERIES_PREFIX.length))?.startDate ?? "";
      if (!record.importKey.startsWith(FEED_EVENT_PREFIX)) return "";
      const id = record.importKey.slice(FEED_EVENT_PREFIX.length);
      const own = eventsById.get(id)?.startsAt;
      if (own) return new Date(own).toISOString();
      const link = context.links.find((row) => row.external_event_id === id);
      const prior = link?.last_remote_snapshot?.startsAt;
      return typeof prior === "string" ? prior : "";
    };
    const textFor = (subset: readonly ImportRecord[]) =>
      feedSyncSourceText({ events: prepared.events, records: subset, series: prepared.series });

    let complete = feedReadComplete(prepared, context.links, args);
    let { kept, dropped } = limitFeedRecords(build(complete), startOf, textFor);
    if (dropped > 0 && complete) {
      // Past the ceilings the read cannot be called complete: no absence delete is proposed, whichever records are kept.
      complete = false;
      ({ kept, dropped } = limitFeedRecords(build(false), startOf, textFor));
    }
    const records = kept.map((record, index) => ({ ...record, sortOrder: index }));
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

registerImportExtension({
  id: CALENDAR_FEED_PROVIDER,
  sourceTypes: [CALENDAR_FEED_PROVIDER],
  linkImportKey: (_provider, _frameId, externalEventId) => `${FEED_EVENT_PREFIX}${externalEventId}`,
  async afterRecord({ sql, userId, id, type, record, linkSource }) {
    const source = linkSource as FeedSource;
    // A series create: the rule is linked from the descriptor the batch kept, by the stem its key carries.
    if (type === "fixed_commitment_recurrence" && record.importKey.startsWith(FEED_SERIES_PREFIX)) {
      const stem = record.importKey.slice(FEED_SERIES_PREFIX.length);
      const series = source.series?.[stem];
      // Without the descriptor the rule would be written unlinked, and the next run would propose it again.
      if (!series) throw new Error("The repeating event's description is missing from its import batch.");
      await linkCalendarFeedRule(sql, userId, id, { stem, series });
      return;
    }
    if (!(type === "fixed_commitment" && record.importKey.startsWith(FEED_EVENT_PREFIX))) return;
    const externalId = record.importKey.slice(FEED_EVENT_PREFIX.length);
    const event = source.events[externalId];
    if (event) await linkCalendarFeedCommitment(sql, userId, id, externalId, event, record.operation === "link");
  },
  // A link the commitment guard skipped must not leave the commit's key map pointing the event at that commitment: a
  // later create of the same event would then resolve as an update of it.
  async afterCommit(tx, { userId, ready }) {
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
    return undefined;
  }
});
