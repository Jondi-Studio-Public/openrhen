import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { CalendarEvent, ImportRecord, PreviewImport } from "@openrhen/contracts";
import { commitmentOccurrenceId, commitmentRepeatFallsOn, zonedDateTime } from "@openrhen/contracts";
import { integrationDatabaseName, persistDerivedState } from "@openrhen/database";
import { PostgresImportStore } from "../import-store";
import { FEED_EVENT_PREFIX, FEED_SERIES_MAX_STEM } from "./calendar-profiles/calendar-feed";
import { feedLinkSnapshot, feedSeriesKey, linkCalendarFeedRule, loadFeedSeries } from "./calendar-feed-series";
import {
  FEED_TIMEZONE,
  FEED_WINDOW,
  feedEvent,
  feedSeries,
  feedSeriesEvents,
  preparedFeed
} from "./calendar-feed-test-support";

/**
 * The calendar feed's series pass against a real database (build plan PR 7): a represented series becomes one held rule
 * create, is committed and linked, and the next diff over what was written proposes nothing; the planner's persist
 * materialises its dates from the rule; a decline by UID persists; and a series that later changes in the feed is
 * counted and left alone. Its own `_test` database, so it belongs to `corepack pnpm test:integration`.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_calendar_feed_series");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) throw new Error("TEST_DATABASE_NAME must end in _test");
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let store: PostgresImportStore;
let userId: string;

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
    if (!existing[0]?.exists) await admin.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
  } finally {
    await admin.end();
  }
  const migrationSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "../platform/database/drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  store = new PostgresImportStore(sql);
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users, portal_state, jobs RESTART IDENTITY CASCADE");
  const { ensureUser } = await import("../state-store");
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

type Prepared = ReturnType<typeof preparedFeed>;
const diffOf = (prepared: Prepared) => store.diffCalendarFeed({ timezone: FEED_TIMEZONE, ...FEED_WINDOW, prepared });
const feedOf = (events: CalendarEvent[], extras: Record<string, unknown> = {}) => preparedFeed(events, extras);

/** Reviews and commits the records the way the sync's held batch does: preview, then commit what is ready. */
async function commit(
  diff: { records: ImportRecord[]; previewFor: (records: ImportRecord[]) => PreviewImport },
  records: ImportRecord[] = diff.records
) {
  const batch = await store.preview(diff.previewFor(records));
  return store.commitReady(batch.id, batch.version);
}

const rules = () =>
  sql<
    {
      id: string;
      title: string;
      timezone: string;
      start_date: string;
      end_date: string | null;
      weekdays: number[] | null;
      local_start_time: string;
      status: string;
      version: number;
    }[]
  >`SELECT id, title, timezone, start_date::text, end_date::text, weekdays, local_start_time::text, status, version FROM commitment_recurrence_rules ORDER BY title`;
const ruleLinks = () =>
  sql<
    {
      external_event_id: string;
      frame_id: string;
      role: string;
      profile_label: string;
      recurrence_rule_id: string | null;
      commitment_id: string | null;
      last_remote_snapshot: Record<string, unknown>;
      last_remote_hash: string;
    }[]
  >`SELECT external_event_id, frame_id, role, profile_label, recurrence_rule_id, commitment_id, last_remote_snapshot, last_remote_hash FROM calendar_event_links WHERE provider='calendar_feed' AND recurrence_rule_id IS NOT NULL ORDER BY external_event_id`;
const oneOffLinks = () =>
  sql<
    { external_event_id: string }[]
  >`SELECT external_event_id FROM calendar_event_links WHERE provider='calendar_feed' AND commitment_id IS NOT NULL ORDER BY external_event_id`;
const dismissals = () =>
  sql<
    { external_event_id: string; title: string }[]
  >`SELECT external_event_id, title FROM calendar_event_dismissals WHERE provider='calendar_feed' ORDER BY external_event_id`;
const commitmentCount = async () =>
  Number((await sql<{ n: string }[]>`SELECT count(*) AS n FROM commitments WHERE user_id=${userId}`)[0]!.n);

/** Approves the series `stem` as the sync's held batch is: one diff, one commit. Returns the rule's id. */
async function approve(series = feedSeries("weekly"), extra: CalendarEvent[] = []) {
  const diff = await diffOf(feedOf([...feedSeriesEvents(series.idPrefix, series), ...extra]));
  const created = diff.records.filter((record) => record.importKey === feedSeriesKey(series.idPrefix));
  expect(created).toHaveLength(1);
  await commit(diff);
  const found = (await ruleLinks()).find((link) => link.external_event_id === `series:${series.idPrefix}`);
  return found!.recurrence_rule_id!;
}

/**
 * The engine stores each generated date under a uuid it derives from `<ruleId>:<date>` (`deterministicUuid` in
 * engine-core, private to it; the contracts function only builds the raw string). This stands in for it: stable per
 * rule and date, which is all the persist needs.
 */
const occurrenceRowId = (ruleId: string, date: string) => {
  const hex = createHash("sha1").update(commitmentOccurrenceId(ruleId, date)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/**
 * What the planner derives for a rule and persists (`persistDerivedState`): one repeat row per date the rule falls on,
 * with the id the engine builds, from today for `days` days. The engine itself is a separate package the portal may
 * not import, so this builds the same rows from the contracts functions it uses.
 */
async function replan(ruleId: string, days = 28, now = new Date()) {
  const [rule] = await sql<
    {
      title: string;
      timezone: string;
      start_date: string;
      end_date: string | null;
      local_start_time: string;
      local_end_time: string;
    }[]
  >`SELECT title, timezone, start_date::text, end_date::text, local_start_time::text, local_end_time::text FROM commitment_recurrence_rules WHERE id=${ruleId}`;
  const repeat = { unit: "weeks" as const, intervalWeeks: 1, weekdays: [2] };
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(now.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    if (date < rule!.start_date || (rule!.end_date && date > rule!.end_date)) continue;
    if (!commitmentRepeatFallsOn(repeat, rule!.start_date, date)) continue;
    rows.push({
      id: occurrenceRowId(ruleId, date),
      recurrenceRuleId: ruleId,
      localDate: date,
      startsAt: zonedDateTime(date, rule!.local_start_time.slice(0, 5), rule!.timezone).toISOString(),
      endsAt: zonedDateTime(date, rule!.local_end_time.slice(0, 5), rule!.timezone).toISOString(),
      title: rule!.title,
      status: "confirmed",
      presence: "blocking"
    });
  }
  await persistDerivedState(sql, userId, {
    inputVersion: "v1",
    calculatedAt: now.toISOString(),
    derivedState: { sleepPlans: [], occurrences: [], routineSteps: [], commitmentRepeats: rows }
  } as never);
  return rows;
}

describe("an approved series", () => {
  it("is one held rule create, committed with its link, and the next sync proposes nothing", async () => {
    const events = [feedEvent("solo-uid", { title: "Dentist" }), ...feedSeriesEvents("weekly")];
    const diff = await diffOf(feedOf(events));
    expect(diff.records.map((r) => [r.importKey, r.entityType, r.operation])).toEqual([
      [`${FEED_EVENT_PREFIX}solo-uid`, "fixed_commitment", "create"],
      ["calendar_feed:series:weekly", "fixed_commitment_recurrence", "create"]
    ]);
    expect(diff.notImported).toEqual({
      unrepresentableSeries: 0,
      seriesPending: 0,
      seriesChanged: 0,
      unreadable: 0,
      droppedForSize: 0
    });
    // Only the descriptor sized text: the batch source carries the series, by stem, for the commit to link from.
    const source = JSON.parse(diff.previewFor(diff.records).source.text!);
    expect(source.series.weekly).toEqual(feedSeries("weekly"));

    const { batch } = await commit(diff);
    expect(batch.status).toBe("committed");

    const [rule] = await rules();
    expect(rule).toMatchObject({
      title: "Series weekly",
      timezone: FEED_TIMEZONE,
      start_date: "2026-11-10",
      end_date: null,
      weekdays: [2],
      local_start_time: "09:00:00",
      status: "active"
    });
    const keys = await sql<
      { entity_type: string; entity_id: string }[]
    >`SELECT entity_type, entity_id FROM import_entity_keys WHERE import_key='calendar_feed:series:weekly'`;
    expect(keys).toEqual([{ entity_type: "fixed_commitment_recurrence", entity_id: rule!.id }]);

    const links = await ruleLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      external_event_id: "series:weekly",
      frame_id: "feed",
      role: "secondary",
      profile_label: "Calendar feed",
      recurrence_rule_id: rule!.id,
      commitment_id: null
    });
    // The flat snapshot: rule fields at the top level, the zone, and an occurrences object. Never nested, never an array.
    expect(links[0]!.last_remote_snapshot).toEqual(feedLinkSnapshot(feedSeries("weekly")));
    expect(Array.isArray(links[0]!.last_remote_snapshot)).toBe(false);
    expect(links[0]!.last_remote_snapshot).not.toHaveProperty("rule");
    expect(links[0]!.last_remote_snapshot.occurrences).toEqual({});

    // The unrelated one-off is linked as before; nothing was written for the series' own instances.
    expect((await oneOffLinks()).map((l) => l.external_event_id)).toEqual(["solo-uid"]);
    expect(await commitmentCount()).toBe(1);

    // The same read again: zero records, not even a count.
    const again = await diffOf(feedOf(events));
    expect(again.records).toEqual([]);
    expect(again.notImported).toMatchObject({ seriesPending: 0, seriesChanged: 0, unreadable: 0 });
    // And the rule and its link are exactly as they were (a no-op follow does not touch them).
    expect((await rules())[0]!.version).toBe(rule!.version);
    expect((await ruleLinks())[0]!.last_remote_snapshot).toEqual(links[0]!.last_remote_snapshot);
  });

  it("keeps working at the longest stem a key carries, and past it is counted rather than imported", async () => {
    const stem = "u".repeat(FEED_SERIES_MAX_STEM);
    const ruleId = await approve(feedSeries(stem));
    expect(feedSeriesKey(stem).length).toBeLessThanOrEqual(120);
    expect((await ruleLinks())[0]).toMatchObject({ external_event_id: `series:${stem}`, recurrence_rule_id: ruleId });
    expect((await diffOf(feedOf(feedSeriesEvents(stem)))).records).toEqual([]);

    const tooLong = "v".repeat(FEED_SERIES_MAX_STEM + 1);
    const diff = await diffOf(feedOf(feedSeriesEvents(tooLong)));
    expect(diff.records).toEqual([]);
    expect(diff.notImported).toMatchObject({ unreadable: 1, seriesPending: 0 });
  });

  it("is materialised by the planner from the rule, and the next sync still proposes nothing", async () => {
    const ruleId = await approve();
    expect(await commitmentCount()).toBe(0);

    const now = new Date();
    const rows = await replan(ruleId, 28, now);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const stored = await sql<
      {
        id: string;
        recurrence_rule_id: string;
        local_date: string;
        title: string;
        starts_at: Date;
        schedule_source: string;
      }[]
    >`SELECT id, recurrence_rule_id, local_date::text, title, starts_at, schedule_source FROM commitments WHERE recurrence_rule_id=${ruleId} ORDER BY starts_at`;
    expect(stored.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(stored.every((row) => row.title === "Series weekly" && row.schedule_source === "inherit")).toBe(true);
    // 09:00 in the feed zone on a Tuesday, whichever daylight-saving offset the date has.
    expect(stored[0]!.starts_at.toISOString()).toBe(
      zonedDateTime(stored[0]!.local_date, "09:00", FEED_TIMEZONE).toISOString()
    );

    // The materialised dates are the rule's, not the feed's: no link, no per-instance proposal, no change.
    const again = await diffOf(feedOf(feedSeriesEvents("weekly")));
    expect(again.records).toEqual([]);
    expect(again.notImported).toMatchObject({ seriesChanged: 0, seriesPending: 0 });
    expect(await oneOffLinks()).toEqual([]);

    // The loader reads the link joined to its rule and the dates still to come, never one already started.
    await sql`INSERT INTO commitments(user_id,title,starts_at,ends_at,status,recurrence_rule_id,local_date) VALUES(${userId},'Past',${new Date(now.getTime() - 86_400_000 * 14)},${new Date(now.getTime() - 86_400_000 * 14 + 3_600_000)},'confirmed',${ruleId},${new Date(now.getTime() - 86_400_000 * 14).toISOString().slice(0, 10)})`;
    const loaded = await loadFeedSeries(sql, userId);
    expect(loaded.ruleLinks.map((l) => [l.external_event_id, l.status, l.recurrence_rule_id])).toEqual([
      ["series:weekly", "active", ruleId]
    ]);
    expect(loaded.occurrences.map((o) => o.id).sort()).toEqual(rows.map((row) => row.id as string).sort());
    expect(loaded.occurrences.every((o) => o.starts_at.getTime() > now.getTime() - 1000)).toBe(true);
  });
});

describe("a declined series", () => {
  it("is remembered by UID when the batch is discarded, and not proposed again even renamed", async () => {
    const diff = await diffOf(feedOf(feedSeriesEvents("decline-me", feedSeries("decline-me", { title: "Yoga" }))));
    const batch = await store.preview(diff.previewFor(diff.records));
    expect(await store.delete(batch.id, { recordDismissals: true })).toBe(true);
    expect(await dismissals()).toEqual([{ external_event_id: "series:decline-me", title: "Yoga" }]);
    expect(await rules()).toEqual([]);
    expect(
      (await diffOf(feedOf(feedSeriesEvents("decline-me", feedSeries("decline-me", { title: "Yoga" }))))).records
    ).toEqual([]);
    expect(
      (await diffOf(feedOf(feedSeriesEvents("decline-me", feedSeries("decline-me", { title: "Pilates now" }))))).records
    ).toEqual([]);
    // A different UID is its own decision.
    expect((await diffOf(feedOf(feedSeriesEvents("other")))).records).toHaveLength(1);
  });

  it("is remembered by UID when the record is left unticked on a commit", async () => {
    const events = [feedEvent("plain"), ...feedSeriesEvents("skip-me")];
    const diff = await diffOf(feedOf(events));
    const records = diff.records.map((record) =>
      record.importKey === "calendar_feed:series:skip-me" ? { ...record, removed: true } : record
    );
    await commit(diff, records);
    expect(await rules()).toEqual([]);
    expect((await dismissals()).map((d) => d.external_event_id)).toEqual(["series:skip-me"]);
    expect((await diffOf(feedOf(events))).records).toEqual([]);
  });
});

describe("a rule-backed series that changes in the feed (this change alone, before the date lifecycle)", () => {
  const changes: [string, Partial<ReturnType<typeof feedSeries>>][] = [
    ["an EXDATE", { exceptions: [{ kind: "cancelled", date: "2026-11-17" }] }],
    [
      "an override",
      {
        exceptions: [
          {
            kind: "changed",
            date: "2026-11-17",
            title: "Moved",
            location: "",
            startDate: "2026-11-17",
            localStartTime: "11:00",
            endDate: "2026-11-17",
            localEndTime: "12:00"
          }
        ]
      }
    ],
    ["an UNTIL", { endDate: "2026-12-29" }],
    ["a cancelled master", { status: "cancelled" }],
    ["a new start time", { localStartTime: "09:30" }],
    ["a new zone", { timezone: "Australia/Perth" }]
  ];

  it.each(changes)(
    "gains %s: nothing is written, the rule and its link stay as they were, and the run counts it",
    async (_name, over) => {
      const ruleId = await approve();
      await replan(ruleId);
      const before = {
        rule: (await rules())[0],
        link: (await ruleLinks())[0],
        plan: await commitmentCount()
      };
      const diff = await diffOf(feedOf(feedSeriesEvents("weekly", feedSeries("weekly", over))));
      expect(diff.records).toEqual([]);
      expect(diff.notImported).toMatchObject({ seriesChanged: 1, seriesPending: 0 });
      expect((await rules())[0]).toEqual(before.rule);
      expect((await ruleLinks())[0]).toEqual(before.link);
      expect(await commitmentCount()).toBe(before.plan);
      // Back to what was approved: steady again.
      expect((await diffOf(feedOf(feedSeriesEvents("weekly")))).notImported.seriesChanged).toBe(0);
    }
  );

  it("gains an unrepresentable shape: the rule is left, the UID's instances are not imported one by one, and it is counted", async () => {
    await approve();
    const diff = await diffOf(
      feedOf(
        feedSeriesEvents("weekly").map((event) => ({ ...event, attributes: {} })),
        { unrepresentableSeries: [{ idPrefix: "weekly", reason: "shape unsupported" }] }
      )
    );
    expect(diff.records).toEqual([]);
    expect(diff.notImported).toMatchObject({ seriesChanged: 1, unrepresentableSeries: 1 });
    expect((await rules())[0]!.status).toBe("active");
  });

  it("is not read as gone when its UID has no event in the window: no rule end is proposed from absence", async () => {
    await approve();
    const diff = await diffOf(feedOf([feedEvent("elsewhere")]));
    expect(diff.records.map((r) => r.importKey)).toEqual([`${FEED_EVENT_PREFIX}elsewhere`]);
    expect(diff.notImported.seriesChanged).toBe(0);
    expect((await rules())[0]!.status).toBe("active");
  });

  it("is not created when it already has changed dates (they could not be applied): counted pending, nothing proposed", async () => {
    const withDate = feedSeries("dated", { exceptions: [{ kind: "cancelled", date: "2026-11-17" }] });
    const diff = await diffOf(feedOf([...feedSeriesEvents("dated", withDate), ...feedSeriesEvents("clean")]));
    expect(diff.records.map((r) => r.importKey)).toEqual(["calendar_feed:series:clean"]);
    expect(diff.notImported).toMatchObject({ seriesPending: 1, seriesChanged: 0 });
  });

  it("is never recreated once the owner has ended its rule", async () => {
    const ruleId = await approve();
    await sql`UPDATE commitment_recurrence_rules SET status='ended', version=version+1 WHERE id=${ruleId}`;
    const diff = await diffOf(feedOf(feedSeriesEvents("weekly")));
    expect(diff.records).toEqual([]);
    expect(diff.notImported).toMatchObject({ seriesChanged: 0, seriesPending: 0 });
    const changed = await diffOf(feedOf(feedSeriesEvents("weekly", feedSeries("weekly", { title: "Renamed" }))));
    expect(changed.records).toEqual([]);
  });

  it("does not take the owner's edit of the rule for a feed change", async () => {
    const ruleId = await approve();
    await sql`UPDATE commitment_recurrence_rules SET title='My own name', location='Home', version=version+1 WHERE id=${ruleId}`;
    const diff = await diffOf(feedOf(feedSeriesEvents("weekly")));
    expect(diff.records).toEqual([]);
    expect(diff.notImported.seriesChanged).toBe(0);
  });
});

describe("a read that is complete only when it can be", () => {
  it("proposes the removal of an absent linked event though an unrelated event was skipped, which used to hold every read incomplete", async () => {
    await commit(await diffOf(feedOf([feedEvent("a"), feedEvent("b", { title: "Other" })])));
    const diff = await diffOf(feedOf([feedEvent("a"), feedEvent("x".repeat(200))]));
    expect(diff.notImported.unreadable).toBe(1);
    expect(diff.records.map((r) => [r.importKey, r.operation])).toEqual([[`${FEED_EVENT_PREFIX}b`, "delete"]]);
  });

  it("proposes nothing when the skipped event shares its UID with a link, or has no id", async () => {
    await commit(await diffOf(feedOf([feedEvent("a"), feedEvent("b", { title: "Other" })])));
    // 'b' appears twice: the repeat is skipped, and 'b' is linked, so the read cannot be called complete.
    const repeated = await diffOf(feedOf([feedEvent("a"), feedEvent("a")]));
    expect(repeated.records).toEqual([]);
    const unidentifiable = await diffOf(
      feedOf([feedEvent("a")], { unrepresentableSeries: [{ idPrefix: null, reason: "no uid" }] })
    );
    expect(unidentifiable.records).toEqual([]);
  });

  it("leaves the one-off links behind a UID that became a series alone, and no longer lets them hold the read incomplete", async () => {
    await commit(await diffOf(feedOf([feedEvent("a"), feedEvent("gone", { title: "Gone" })])));
    // 'a' now repeats: a rule would materialise on top of its one-off commitment, so no series create is proposed;
    // the one-off link stays, and the run counts it.
    const diff = await diffOf(feedOf(feedSeriesEvents("a")));
    expect(diff.records.map((r) => [r.importKey, r.operation])).toEqual([[`${FEED_EVENT_PREFIX}gone`, "delete"]]);
    expect(diff.notImported.seriesChanged).toBe(1);
    expect((await oneOffLinks()).map((l) => l.external_event_id)).toEqual(["a", "gone"]);
    expect(await rules()).toEqual([]);
  });
});

describe("the series pass's own reads and writes", () => {
  it("keeps the dates a link already records when it is linked again", async () => {
    const ruleId = await approve();
    const dates = { "2026-11-17": { status: "cancelled" } };
    await sql`UPDATE calendar_event_links SET last_remote_snapshot = last_remote_snapshot || ${sql.json({ occurrences: dates } as never)} WHERE recurrence_rule_id=${ruleId}`;
    await linkCalendarFeedRule(sql, userId, ruleId, {
      stem: "weekly",
      series: feedSeries("weekly", { title: "Renamed" })
    });
    const snapshot = (await ruleLinks())[0]!.last_remote_snapshot;
    expect(snapshot.occurrences).toEqual(dates);
    expect(snapshot.title).toBe("Renamed");
  });

  it("reads only links on the feed frame", async () => {
    await approve();
    const other = await sql<{ id: string }[]>`
      INSERT INTO commitment_recurrence_rules(user_id,title,timezone,start_date,interval_days,local_start_time,local_end_time)
      VALUES(${userId},'Elsewhere','Australia/Sydney','2026-11-10',7,'09:00','10:00') RETURNING id`;
    await sql`INSERT INTO calendar_event_links(user_id,provider,role,frame_id,external_event_id,recurrence_rule_id,profile_label,last_remote_snapshot,last_remote_hash) VALUES(${userId},'calendar_feed','secondary','not-feed','series:elsewhere',${other[0]!.id},'x','{}'::jsonb,'x')`;
    const loaded = await loadFeedSeries(sql, userId);
    expect(loaded.ruleLinks.map((l) => l.external_event_id)).toEqual(["series:weekly"]);
  });
});

describe("two events that match one commitment on the plan (the collision guard, persisted)", () => {
  it("links the first and demotes a possible match for the same commitment to a plain create; the commit succeeds", async () => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO commitments(user_id,title,starts_at,ends_at,status) VALUES(${userId},'Team sync','2026-11-10T01:00:00.000Z','2026-11-10T02:00:00.000Z','confirmed') RETURNING id`;
    const planId = rows[0]!.id;
    const second = feedEvent("b", { title: "Quarterly review" });
    // On its own the second event is only a possible match for the commitment...
    const alone = await diffOf(feedOf([second]));
    expect(alone.records[0]).toMatchObject({ operation: "conflict", relationships: { sourceMatchKind: "possible" } });
    // ...and once the first event has linked it, there is no second link to make.
    const diff = await diffOf(feedOf([feedEvent("a", { title: "Team sync" }), second, ...feedSeriesEvents("kept")]));
    const byKey = Object.fromEntries(diff.records.map((r) => [r.importKey.slice(FEED_EVENT_PREFIX.length), r]));
    expect(byKey.a).toMatchObject({ operation: "link", matchedEntityId: planId });
    expect(byKey.b!.operation).toBe("create");
    expect(byKey.b!.relationships.sourceMatchKind).toBeUndefined();
    // The series create still reaches the batch on the demotion path.
    expect(diff.records.some((r) => r.importKey === "calendar_feed:series:kept")).toBe(true);
    await commit(diff);
    const links = await sql<
      { external_event_id: string; commitment_id: string }[]
    >`SELECT external_event_id, commitment_id FROM calendar_event_links WHERE provider='calendar_feed' AND commitment_id IS NOT NULL ORDER BY external_event_id`;
    expect(links.map((l) => [l.external_event_id, l.commitment_id === planId])).toEqual([
      ["a", true],
      ["b", false]
    ]);
    expect(await commitmentCount()).toBe(2);
  });
});
