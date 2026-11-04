import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import type { CalendarEvent, CalendarSyncResult, ImportRecord } from "@openrhen/contracts";
import { commitmentOccurrenceRowId, commitmentRepeatFallsOn, zonedDateTime } from "@openrhen/contracts";
import type { CalendarFeedSeries } from "@openrhen/contracts/integrations/calendar-feed";
import { integrationDatabaseName, persistDerivedState } from "@openrhen/database";
import { PostgresImportStore } from "../import-store";
import { FEED_EXCEPTION_HORIZON_DAYS, addDays, insertFeedDate } from "./calendar-feed-dates";
import { feedEvent, feedSeries, preparedFeed } from "./calendar-feed-test-support";

/**
 * The calendar feed's date lifecycle against a real database, end to end through `runCalendarSync` (the real
 * `applyDiff`, the real import commit, the real persist of the planner's rows): cancels apply on their own and spend the
 * delete budget, everything else waits in one review batch, exception rows are written under the planner's own id, and
 * what the owner edited is never overwritten. Its own `_test` database, so it belongs to `corepack pnpm test:integration`.
 *
 * Dates are relative to the real clock (the sync reads from now forward): the series is a weekly Tuesday that starts on
 * the first Tuesday at least three days away.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_calendar_feed_dates");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) throw new Error("TEST_DATABASE_NAME must end in _test");
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

const ZONE = "Australia/Sydney";
const STEM = "wk";
const today = () => new Date().toISOString().slice(0, 10);
function firstTuesdayFrom(date: string): string {
  let day = date;
  while (new Date(`${day}T00:00:00Z`).getUTCDay() !== 2) day = addDays(day, 1);
  return day;
}
const T0 = firstTuesdayFrom(addDays(today(), 3));
/** The nth Tuesday of the series, counting the first as 0. */
const week = (n: number) => addDays(T0, 7 * n);

let sql: postgres.Sql;
let store: PostgresImportStore;
let userId: string;
let runCalendarSync: typeof import("./../../../imports/calendar-sync").runCalendarSync;
let calendarFeedAdapter: typeof import("./../../../imports/calendar-feed-adapter").calendarFeedAdapter;

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
  vi.stubEnv("DATABASE_URL", testUrl.toString());
  vi.stubEnv("OUTBOUND_PROXY_URL", "");
  vi.stubEnv("OUTBOUND_PROXY_TOKEN", "");
  vi.stubEnv("CALENDAR_SYNC_PROVIDERS", "calendar_feed");
  vi.stubEnv("APP_TIMEZONE", ZONE);
  ({ runCalendarSync } = await import("./../../../imports/calendar-sync"));
  ({ calendarFeedAdapter } = await import("./../../../imports/calendar-feed-adapter"));
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users, portal_state, jobs RESTART IDENTITY CASCADE");
  const { ensureUser } = await import("../state-store");
  userId = await ensureUser(sql);
  delete process.env.CALENDAR_SYNC_MAX_DELETES;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await sql?.end();
});

const compact = (date: string) => date.replaceAll("-", "");
function seriesOf(over: Partial<CalendarFeedSeries> = {}): CalendarFeedSeries {
  return feedSeries(STEM, { startDate: T0, ...over });
}
function readOf(series: CalendarFeedSeries | null, extras: Record<string, unknown> = {}, more: CalendarEvent[] = []) {
  // The proxy emits an event for each instance that is not an EXDATE, so the first event of the UID is the first live date.
  const cancelled = new Set(series?.exceptions.filter((e) => e.kind === "cancelled").map((e) => e.date));
  let first = series?.startDate ?? "";
  while (cancelled.has(first)) first = addDays(first, 7);
  const events = series
    ? [
        feedEvent(`${STEM}#${compact(first)}`, {
          title: series.title,
          recurring: true,
          seriesId: STEM,
          startsAt: zonedDateTime(first, series.localStartTime, series.timezone).toISOString(),
          endsAt: zonedDateTime(first, series.localEndTime, series.timezone).toISOString(),
          attributes: { series }
        })
      ]
    : [];
  return preparedFeed([...events, ...more], extras);
}

/** One sync through the real `runCalendarSync` and `applyDiff`, with the feed adapter's holds and a fixed read. */
async function sync(prepared: ReturnType<typeof readOf>): Promise<CalendarSyncResult & Record<string, any>> {
  const adapter = {
    ...calendarFeedAdapter,
    async read(args: { timeMin: string; timeMax: string; timezone: string }) {
      return {
        status: "read" as const,
        eventCount: prepared.rawEventCount,
        diff: (importStore: PostgresImportStore) =>
          importStore.diffCalendarFeed({
            timezone: args.timezone,
            timeMin: args.timeMin,
            timeMax: args.timeMax,
            prepared
          })
      };
    }
  };
  return (await runCalendarSync({ provider: "calendar_feed", trigger: "manual", adapter })) as never;
}

/** The review batch the last sync left open, and a way to commit what is ready in it (the owner ticking "apply"). */
async function openBatch() {
  const open = await store.openBatches("calendar_feed");
  expect(open.length).toBeLessThanOrEqual(1);
  return open[0] ? (await store.get(open[0].id))! : null;
}
async function approveReview() {
  const batch = (await openBatch())!;
  expect(batch).not.toBeNull();
  return store.commitReady(batch.id, batch.version);
}

/** Creates the series through the sync and approves it, then lets the planner materialise it for `days` days. */
async function createSeries(series = seriesOf(), days = 60) {
  const result = await sync(readOf(series));
  expect(result.heldForReview).toBeGreaterThanOrEqual(1);
  await approveReview();
  const link = (await ruleLinks()).find((row) => row.external_event_id === `series:${STEM}`)!;
  if (days > 0) await replan(link.recurrence_rule_id!, days);
  return link.recurrence_rule_id!;
}

const rules = () =>
  sql<
    {
      id: string;
      title: string;
      timezone: string;
      end_date: string | null;
      local_start_time: string;
      status: string;
      version: number;
    }[]
  >`SELECT id, title, timezone, end_date::text, local_start_time::text, status, version FROM commitment_recurrence_rules`;
const ruleLinks = () =>
  sql<
    {
      external_event_id: string;
      recurrence_rule_id: string | null;
      last_remote_snapshot: Record<string, any>;
    }[]
  >`SELECT external_event_id, recurrence_rule_id, last_remote_snapshot FROM calendar_event_links WHERE provider='calendar_feed' AND recurrence_rule_id IS NOT NULL`;
const dateRow = async (ruleId: string, date: string) =>
  (
    await sql<
      {
        id: string;
        title: string;
        starts_at: Date;
        ends_at: Date;
        status: string;
        location: string | null;
        schedule_source: string;
        presence: string;
        presence_source: string;
        local_date: string;
        version: number;
      }[]
    >`SELECT id, title, starts_at, ends_at, status, location, schedule_source, presence, presence_source, local_date::text, version FROM commitments WHERE recurrence_rule_id=${ruleId} AND local_date=${date}::date`
  )[0];
const rowCount = async (ruleId: string) =>
  Number((await sql<{ n: string }[]>`SELECT count(*) AS n FROM commitments WHERE recurrence_rule_id=${ruleId}`)[0]!.n);

/**
 * What the planner derives and persists for the rule (`persistDerivedState`): a row per Tuesday under the contracts id,
 * from now for `days` days, which the real persist upserts (a detached row keeps its own values) and prunes.
 */
async function replan(ruleId: string, days = 60, now = new Date()) {
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
      id: commitmentOccurrenceRowId(ruleId, date),
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

const cancelOn = (date: string) => ({ kind: "cancelled" as const, date });
const changeOn = (date: string, over: Record<string, unknown> = {}) => ({
  kind: "changed" as const,
  date,
  title: "Retimed",
  location: "Room 9",
  startDate: date,
  localStartTime: "14:00",
  endDate: date,
  localEndTime: "15:30",
  ...over
});

describe("a series created with changed dates", () => {
  it("inserts a cancelled row and a changed row under the planner's own id, with the snapshot, and the next sync is steady", async () => {
    const series = seriesOf({ exceptions: [cancelOn(week(1)), changeOn(week(2))] });
    const result = await sync(readOf(series));
    expect(result).toMatchObject({ status: "needs_review", heldForReview: 1 });
    await approveReview();

    const [rule] = await rules();
    const cancelled = (await dateRow(rule!.id, week(1)))!;
    const changed = (await dateRow(rule!.id, week(2)))!;
    expect(cancelled).toMatchObject({
      id: commitmentOccurrenceRowId(rule!.id, week(1)),
      status: "cancelled",
      schedule_source: "custom",
      presence: "blocking",
      presence_source: "inherit",
      local_date: week(1)
    });
    expect(changed).toMatchObject({
      id: commitmentOccurrenceRowId(rule!.id, week(2)),
      title: "Retimed",
      location: "Room 9",
      status: "confirmed",
      schedule_source: "custom"
    });
    expect(changed.starts_at.toISOString()).toBe(zonedDateTime(week(2), "14:00", ZONE).toISOString());
    expect(changed.ends_at.toISOString()).toBe(zonedDateTime(week(2), "15:30", ZONE).toISOString());
    const snapshot = (await ruleLinks())[0]!.last_remote_snapshot;
    expect(Object.keys(snapshot.occurrences).sort()).toEqual([week(1), week(2)]);
    expect(snapshot.occurrences[week(1)].status).toBe("cancelled");

    // Steady: the same read proposes nothing, and nothing is written.
    const before = await rowCount(rule!.id);
    expect(await sync(readOf(series))).toMatchObject({ status: "synced", heldForReview: 0, committedBatchId: null });
    expect(await rowCount(rule!.id)).toBe(before);
  });

  it("survives the planner's real persist: the rows stay detached and cancelled, with one row per date", async () => {
    const series = seriesOf({ exceptions: [cancelOn(week(1)), changeOn(week(2))] });
    await sync(readOf(series));
    await approveReview();
    const [rule] = await rules();
    const rows = await replan(rule!.id, 90);
    await replan(rule!.id, 90);
    expect(await dateRow(rule!.id, week(1))).toMatchObject({ status: "cancelled", schedule_source: "custom" });
    expect(await dateRow(rule!.id, week(2))).toMatchObject({ title: "Retimed", schedule_source: "custom" });
    expect(await rowCount(rule!.id)).toBe(rows.length);
    expect((await sync(readOf(series))).heldForReview).toBe(0);
  });

  it("inserts only dates inside 170 days and survives a persist over the 180-day horizon; later dates are inserted when they enter it", async () => {
    // The Tuesdays either side of the insert horizon.
    const edge = addDays(today(), FEED_EXCEPTION_HORIZON_DAYS);
    let inside = week(0);
    while (addDays(inside, 7) <= edge) inside = addDays(inside, 7);
    const outside = addDays(inside, 7);
    const series = seriesOf({ exceptions: [cancelOn(inside), cancelOn(outside)] });
    await sync(readOf(series));
    await approveReview();
    const [rule] = await rules();
    expect(await dateRow(rule!.id, inside)).toMatchObject({ status: "cancelled" });
    expect(await dateRow(rule!.id, outside)).toBeUndefined();
    expect(Object.keys((await ruleLinks())[0]!.last_remote_snapshot.occurrences)).toEqual([inside]);
    // The planner materialises out to its own 180 days: its row for the outside date appears as an ordinary inherit row,
    // the exception row inside the horizon is untouched, and no unique index complains.
    await replan(rule!.id, 181);
    expect(await dateRow(rule!.id, inside)).toMatchObject({ status: "cancelled", schedule_source: "custom" });
    expect(await dateRow(rule!.id, outside)).toMatchObject({ status: "confirmed", schedule_source: "inherit" });
    // The next sync sees a row for the outside date now, and cancels it (on its own: it is a plain cancel).
    const next = await sync(readOf(series));
    expect(next).toMatchObject({ status: "synced", heldForReview: 0, updated: 1 });
    expect(await dateRow(rule!.id, outside)).toMatchObject({ status: "cancelled", schedule_source: "custom" });
  });
});

describe("a date cancelled later in the feed", () => {
  it("applies on its own, writes the row detached and cancelled, remembers it, and is steady afterwards", async () => {
    const ruleId = await createSeries();
    const result = await sync(readOf(seriesOf({ exceptions: [cancelOn(week(1))] })));
    expect(result).toMatchObject({
      status: "synced",
      updated: 1,
      heldForReview: 0,
      committedBatchId: expect.any(String)
    });
    expect(await dateRow(ruleId, week(1))).toMatchObject({
      status: "cancelled",
      schedule_source: "custom",
      id: commitmentOccurrenceRowId(ruleId, week(1))
    });
    expect((await ruleLinks())[0]!.last_remote_snapshot.occurrences[week(1)]).toMatchObject({ status: "cancelled" });
    // The rest of the series is untouched and the planner keeps the cancel.
    expect(await dateRow(ruleId, week(2))).toMatchObject({ status: "confirmed", schedule_source: "inherit" });
    await replan(ruleId);
    expect(await dateRow(ruleId, week(1))).toMatchObject({ status: "cancelled" });
    expect(await sync(readOf(seriesOf({ exceptions: [cancelOn(week(1))] })))).toMatchObject({
      status: "synced",
      heldForReview: 0,
      committedBatchId: null
    });
  });

  it("is inserted by the commit, as at series create, when the planner has not made the date yet", async () => {
    const ruleId = await createSeries(seriesOf(), 0);
    expect(await rowCount(ruleId)).toBe(0);
    const result = await sync(readOf(seriesOf({ exceptions: [cancelOn(week(3))] })));
    expect(result).toMatchObject({ status: "synced", updated: 0, heldForReview: 0 });
    expect(result.committedBatchId).toEqual(expect.any(String));
    const row = (await dateRow(ruleId, week(3)))!;
    expect(row).toMatchObject({
      id: commitmentOccurrenceRowId(ruleId, week(3)),
      status: "cancelled",
      schedule_source: "custom"
    });
    expect(await rowCount(ruleId)).toBe(1);
    // The planner's persist over the same rule collides on nothing, and keeps the cancel.
    await replan(ruleId, 60);
    expect(await dateRow(ruleId, week(3))).toMatchObject({ status: "cancelled" });
    // No stale key is left behind for the inserted row to be matched through, and the next sync is steady.
    expect(await sync(readOf(seriesOf({ exceptions: [cancelOn(week(3))] })))).toMatchObject({
      heldForReview: 0,
      committedBatchId: null
    });
  });

  it("is held, with nothing cancelled, when more cancels than CALENDAR_SYNC_MAX_DELETES arrive in one run", async () => {
    process.env.CALENDAR_SYNC_MAX_DELETES = "2";
    const ruleId = await createSeries();
    const result = await sync(
      readOf(seriesOf({ exceptions: [cancelOn(week(1)), cancelOn(week(2)), cancelOn(week(3))] }))
    );
    expect(result).toMatchObject({ status: "needs_review", updated: 0, heldForReview: 3, committedBatchId: null });
    for (const n of [1, 2, 3]) expect(await dateRow(ruleId, week(n))).toMatchObject({ status: "confirmed" });
    // The review applies all three.
    await approveReview();
    for (const n of [1, 2, 3]) expect(await dateRow(ruleId, week(n))).toMatchObject({ status: "cancelled" });
    // Two cancels are within the budget of two and apply on their own.
    const small = await sync(
      readOf(
        seriesOf({
          exceptions: [cancelOn(week(1)), cancelOn(week(2)), cancelOn(week(3)), cancelOn(week(4)), cancelOn(week(5))]
        })
      )
    );
    expect(small).toMatchObject({ status: "synced", updated: 2, heldForReview: 0 });
  });

  it("is a conflict, never an overwrite, when the owner changed the date and nothing remembers what the feed said", async () => {
    const ruleId = await createSeries();
    await sql`UPDATE commitments SET title='My own title', schedule_source='custom', version=version+1 WHERE recurrence_rule_id=${ruleId} AND local_date=${week(1)}::date`;
    const result = await sync(readOf(seriesOf({ exceptions: [cancelOn(week(1))] })));
    expect(result).toMatchObject({ status: "needs_review", heldForReview: 1, committedBatchId: null });
    const batch = (await openBatch())!;
    expect(batch.records[0]).toMatchObject({ operation: "conflict" });
    expect(await dateRow(ruleId, week(1))).toMatchObject({ title: "My own title", status: "confirmed" });
  });
});

describe("a date the feed changes, and one it stops changing", () => {
  it("holds a change in place for review, applies it on approval, keeps an owner's other edits, and records it", async () => {
    const ruleId = await createSeries();
    const series = seriesOf({ exceptions: [changeOn(week(1))] });
    const result = await sync(readOf(series));
    expect(result).toMatchObject({ status: "needs_review", heldForReview: 1, updated: 0, committedBatchId: null });
    expect(await dateRow(ruleId, week(1))).toMatchObject({
      title: "Series weekly".replace("weekly", STEM),
      schedule_source: "inherit"
    });
    await approveReview();
    expect(await dateRow(ruleId, week(1))).toMatchObject({
      title: "Retimed",
      location: "Room 9",
      schedule_source: "custom"
    });
    expect((await dateRow(ruleId, week(1)))!.starts_at.toISOString()).toBe(
      zonedDateTime(week(1), "14:00", ZONE).toISOString()
    );
    expect((await ruleLinks())[0]!.last_remote_snapshot.occurrences[week(1)]).toMatchObject({ title: "Retimed" });
    expect(await sync(readOf(series))).toMatchObject({ status: "synced", heldForReview: 0 });

    // The owner retitles the date; the feed later changes only the place: the place applies, the owner's title stays.
    await sql`UPDATE commitments SET title='Owner title', version=version+1 WHERE recurrence_rule_id=${ruleId} AND local_date=${week(1)}::date`;
    const later = seriesOf({ exceptions: [changeOn(week(1), { location: "Room 12" })] });
    expect(await sync(readOf(later))).toMatchObject({ status: "needs_review", heldForReview: 1 });
    await approveReview();
    expect(await dateRow(ruleId, week(1))).toMatchObject({ title: "Owner title", location: "Room 12" });
  });

  it("reverts a cancelled date as a held record when the EXDATE is removed, and never overwrites an owner edit", async () => {
    const ruleId = await createSeries();
    await sync(readOf(seriesOf({ exceptions: [cancelOn(week(1))] })));
    expect(await dateRow(ruleId, week(1))).toMatchObject({ status: "cancelled" });

    // The EXDATE is gone: an un-cancel is held, not applied on its own.
    const result = await sync(readOf(seriesOf()));
    expect(result).toMatchObject({ status: "needs_review", heldForReview: 1, updated: 0, committedBatchId: null });
    expect(await dateRow(ruleId, week(1))).toMatchObject({ status: "cancelled" });
    await approveReview();
    expect(await dateRow(ruleId, week(1))).toMatchObject({ status: "confirmed", schedule_source: "inherit" });
    expect((await ruleLinks())[0]!.last_remote_snapshot.occurrences[week(1)]).toBeUndefined();
    await replan(ruleId);
    expect(await dateRow(ruleId, week(1))).toMatchObject({ status: "confirmed", title: "Series wk" });
    expect(await sync(readOf(seriesOf()))).toMatchObject({ status: "synced", heldForReview: 0 });

    // Owner edit: cancel again, then the owner retitles, then the feed drops the EXDATE.
    await sync(readOf(seriesOf({ exceptions: [cancelOn(week(2))] })));
    await sql`UPDATE commitments SET title='Owner title', version=version+1 WHERE recurrence_rule_id=${ruleId} AND local_date=${week(2)}::date`;
    const conflict = await sync(readOf(seriesOf()));
    expect(conflict).toMatchObject({ status: "needs_review", heldForReview: 1 });
    expect((await openBatch())!.records[0]).toMatchObject({ operation: "conflict" });
    expect(await dateRow(ruleId, week(2))).toMatchObject({ status: "cancelled", title: "Owner title" });
  });
});

describe("a rule update", () => {
  it("is one held update for time, title and place together, applied on approval with past dates detached", async () => {
    const ruleId = await createSeries();
    // A past occurrence that is still on the rule's own values.
    const past = addDays(week(0), -14);
    await sql`INSERT INTO commitments(id,user_id,title,starts_at,ends_at,status,recurrence_rule_id,local_date,schedule_source) VALUES(${commitmentOccurrenceRowId(ruleId, past)},${userId},'Series wk',now() - interval '13 days',now() - interval '13 days' + interval '1 hour','confirmed',${ruleId},${past}::date,'inherit')`;
    const series = seriesOf({ localStartTime: "09:30", localEndTime: "10:30", title: "Renamed", location: "Room 4" });
    const result = await sync(readOf(series));
    expect(result).toMatchObject({ status: "needs_review", heldForReview: 1, updated: 0, committedBatchId: null });
    expect((await rules())[0]).toMatchObject({ title: "Series wk", local_start_time: "09:00:00" });
    expect((await openBatch())!.records).toHaveLength(1);

    await approveReview();
    expect((await rules())[0]).toMatchObject({ title: "Renamed", local_start_time: "09:30:00" });
    // The past date is detached so the replan does not rewrite it.
    expect((await dateRow(ruleId, past))!.schedule_source).toBe("custom");
    const snapshot = (await ruleLinks())[0]!.last_remote_snapshot;
    expect(snapshot).toMatchObject({ title: "Renamed", localStartTime: "09:30", location: "Room 4" });
    expect(await sync(readOf(series))).toMatchObject({ status: "synced", heldForReview: 0, committedBatchId: null });
  });

  it("carries an UNTIL end and a zone change, and prunes past exceptions on a change that touches only the rule", async () => {
    const ruleId = await createSeries();
    const stale = addDays(today(), -30);
    await sql`UPDATE calendar_event_links SET last_remote_snapshot = last_remote_snapshot || ${sql.json({ occurrences: { [stale]: { status: "cancelled" } } } as never)} WHERE recurrence_rule_id=${ruleId}`;
    const end = week(6);
    await sync(readOf(seriesOf({ endDate: end, timezone: "Australia/Perth" })));
    await approveReview();
    expect((await rules())[0]).toMatchObject({ end_date: end, timezone: "Australia/Perth" });
    const snapshot = (await ruleLinks())[0]!.last_remote_snapshot;
    expect(snapshot).toMatchObject({ endDate: end, timezone: "Australia/Perth" });
    expect(snapshot.occurrences[stale]).toBeUndefined();
    await replan(ruleId);
    expect(await dateRow(ruleId, week(7))).toBeUndefined();
    expect(await sync(readOf(seriesOf({ endDate: end, timezone: "Australia/Perth" })))).toMatchObject({
      heldForReview: 0
    });
  });

  it("is a conflict, not an overwrite, when the owner edited the title and the feed changed it too", async () => {
    const ruleId = await createSeries();
    await sql`UPDATE commitment_recurrence_rules SET title='Owner title', version=version+1 WHERE id=${ruleId}`;
    const result = await sync(readOf(seriesOf({ title: "Feed title" })));
    expect(result).toMatchObject({ status: "needs_review", heldForReview: 1 });
    expect((await openBatch())!.records[0]).toMatchObject({ operation: "conflict" });
    expect((await rules())[0]).toMatchObject({ title: "Owner title" });
    // A field only the feed changed still goes through when the owner edited another one.
    const other = await sync(readOf(seriesOf({ localStartTime: "09:30" })));
    expect(other.heldForReview).toBe(1);
    await approveReview();
    expect((await rules())[0]).toMatchObject({ title: "Owner title", local_start_time: "09:30:00" });
  });
});

describe("a rule end from the feed", () => {
  it("is a held proposal for a cancelled master, applied only when the owner approves; past dates stay", async () => {
    const ruleId = await createSeries();
    const result = await sync(readOf(seriesOf({ status: "cancelled" })));
    expect(result).toMatchObject({ status: "needs_review", heldForReview: 1, deleted: 0, committedBatchId: null });
    expect((await rules())[0]).toMatchObject({ status: "active" });
    const record = (await openBatch())!.records[0]!;
    expect(record).toMatchObject({ operation: "delete", relationships: { feedReasonKind: "cancelled" } });
    expect(record.relationships.feedReason).toContain("cancelled");
    expect(await rowCount(ruleId)).toBeGreaterThan(0);
    await approveReview();
    expect((await rules())[0]).toMatchObject({ status: "ended" });
    // An ended rule is left alone from then on.
    expect(await sync(readOf(seriesOf({ status: "cancelled" })))).toMatchObject({ status: "synced", heldForReview: 0 });
  });

  it("is a held proposal when the UID is missing from a complete read that should have had it, and never from an incomplete one", async () => {
    await createSeries();
    for (const extras of [{ transportComplete: false }, { occurrenceCapHit: true, transportComplete: false }]) {
      const incomplete = await sync(readOf(null, extras, [feedEvent("other")]));
      expect((await rules())[0]!.status).toBe("active");
      // The unrelated event is a create to review; no rule end is among the held records.
      const batch = await openBatch();
      expect(batch?.records.map((r) => r.entityType) ?? []).not.toContain("fixed_commitment_recurrence");
      expect(incomplete.status).not.toBe("failed");
    }
    // A skipped event with no id could be this UID: not complete either.
    await sync(readOf(null, { skipped: [{ idPrefix: null, reason: "no uid" }] }, [feedEvent("other")]));
    expect((await openBatch())?.records.map((r) => r.entityType) ?? []).not.toContain("fixed_commitment_recurrence");

    const gone = await sync(readOf(null, {}, [feedEvent("other")]));
    expect(gone).toMatchObject({ status: "needs_review", deleted: 0 });
    const records = (await openBatch())!.records;
    const end = records.find((r) => r.entityType === "fixed_commitment_recurrence")!;
    expect(end).toMatchObject({ operation: "delete", relationships: { feedReasonKind: "gone" } });
    expect((await rules())[0]!.status).toBe("active");
    // The feed has it again: the proposal goes, nothing was applied.
    expect(await sync(readOf(seriesOf()))).toMatchObject({ heldForReview: 0 });
  });

  it("is a held end with its reason when the shape becomes unrepresentable, and ends nothing until approved", async () => {
    await createSeries();
    const result = await sync(
      preparedFeed([feedEvent(`${STEM}#${compact(T0)}`, { recurring: true, seriesId: STEM })], {
        unrepresentableSeries: [{ idPrefix: STEM, reason: "shape unsupported" }]
      })
    );
    expect(result).toMatchObject({ status: "needs_review", heldForReview: 1 });
    expect((await openBatch())!.records[0]).toMatchObject({
      operation: "delete",
      relationships: { feedReasonKind: "shape" }
    });
    expect((await rules())[0]!.status).toBe("active");
  });
});

describe("a read that cannot speak for the whole feed", () => {
  it("proposes no rule update and no revert from an incomplete read, but still applies a cancel", async () => {
    const ruleId = await createSeries();
    await sync(readOf(seriesOf({ exceptions: [cancelOn(week(1))] })));
    expect(await dateRow(ruleId, week(1))).toMatchObject({ status: "cancelled" });
    for (const extras of [{ transportComplete: false }, { skipped: [{ idPrefix: null, reason: "no uid" }] }]) {
      // The EXDATE is missing and the rule's time differs, but this read may be missing exceptions: nothing is proposed.
      const partial = await sync(readOf(seriesOf({ localStartTime: "09:30", localEndTime: "10:30" }), extras));
      expect(partial).toMatchObject({ heldForReview: 0 });
      expect(await openBatch()).toBeNull();
      expect(await dateRow(ruleId, week(1))).toMatchObject({ status: "cancelled" });
      expect((await rules())[0]).toMatchObject({ local_start_time: "09:00:00" });
    }
    // A cancel on a partial read is safe and still applies.
    const cancelled = await sync(
      readOf(seriesOf({ exceptions: [cancelOn(week(1)), cancelOn(week(2))] }), { transportComplete: false })
    );
    expect(cancelled).toMatchObject({ heldForReview: 0 });
    expect(await dateRow(ruleId, week(2))).toMatchObject({ status: "cancelled" });
    // The complete read then proposes the update and the revert.
    const complete = await sync(readOf(seriesOf({ localStartTime: "09:30", localEndTime: "10:30" })));
    expect(complete).toMatchObject({ status: "needs_review" });
    expect((await openBatch())!.records.length).toBeGreaterThanOrEqual(2);
  });

  it("never reads a series as gone from an empty valid read, nor when the feed cancels the dates before its first live one", async () => {
    await createSeries();
    expect(await sync(readOf(null, {}, []))).toMatchObject({ heldForReview: 0 });
    expect((await rules())[0]!.status).toBe("active");
    expect(await openBatch()).toBeNull();
    // The first five dates are now EXDATEs while the series goes on: cancels (a change), not a proposal to end the rule.
    const all = await sync(readOf(seriesOf({ exceptions: [0, 1, 2, 3, 4].map((n) => cancelOn(week(n))) })));
    expect(all.status).not.toBe("failed");
    const records = (await openBatch())?.records ?? [];
    expect(records.some((r) => r.relationships.feedReasonKind === "gone")).toBe(false);
    expect((await rules())[0]!.status).toBe("active");
  });
});

describe("a date the feed moves to another day", () => {
  const originalDate = () => week(1);
  const newDay = () => addDays(week(1), 2);
  const moveEx = (over: Record<string, unknown> = {}) =>
    changeOn(originalDate(), { title: "Moved meeting", startDate: newDay(), endDate: newDay(), ...over });
  const replacementId = () => `${STEM}#move${compact(originalDate())}`;
  const replacementLink = async () =>
    (
      await sql<
        { commitment_id: string | null; last_remote_snapshot: Record<string, any> }[]
      >`SELECT commitment_id, last_remote_snapshot FROM calendar_event_links WHERE provider='calendar_feed' AND external_event_id=${replacementId()}`
    )[0];
  const commitmentById = async (id: string) =>
    (
      await sql<
        { title: string; starts_at: Date; status: string; closed_by: string | null }[]
      >`SELECT title, starts_at, status, closed_by FROM commitments WHERE id=${id}`
    )[0];

  /** Creates the series, then has the feed move week 1 and approves the pair. */
  async function movedSeries() {
    const ruleId = await createSeries();
    const result = await sync(readOf(seriesOf({ exceptions: [moveEx()] })));
    expect(result).toMatchObject({ status: "needs_review", heldForReview: 2, committedBatchId: null });
    return ruleId;
  }

  it("holds the original's cancel and the replacement together, and writes both on approval", async () => {
    const ruleId = await movedSeries();
    const records = (await openBatch())!.records;
    expect(records).toHaveLength(2);
    const pairs = new Set(records.map((r) => r.relationships.feedMove));
    expect(pairs.size).toBe(1);
    expect([...pairs][0]).toBe(`mv:${STEM}:${originalDate()}`);
    expect(records.map((r) => r.operation).sort()).toEqual(["create", "update"].sort());
    // Nothing is cancelled or created before approval.
    expect(await dateRow(ruleId, originalDate())).toMatchObject({ status: "confirmed" });
    expect(await replacementLink()).toBeUndefined();

    await approveReview();
    expect(await dateRow(ruleId, originalDate())).toMatchObject({ status: "cancelled", schedule_source: "custom" });
    const link = (await replacementLink())!;
    expect(link.last_remote_snapshot.feedMoveOf).toBe(originalDate());
    expect(await commitmentById(link.commitment_id!)).toMatchObject({ title: "Moved meeting", status: "confirmed" });
    expect((await commitmentById(link.commitment_id!))!.starts_at.toISOString()).toBe(
      zonedDateTime(newDay(), "14:00", ZONE).toISOString()
    );
    // Steady: the replacement is not read as an old link or as absent, and the original stays cancelled.
    expect(await sync(readOf(seriesOf({ exceptions: [moveEx()] })))).toMatchObject({
      status: "synced",
      heldForReview: 0
    });
    expect(await openBatch()).toBeNull();
  });

  it("refuses to commit only one half of the pair", async () => {
    await movedSeries();
    const batch = (await openBatch())!;
    const half = batch.records.map((record, index) => ({ ...record, removed: index === 0 }));
    const edited = await store.update(batch.id, batch.version, half);
    await expect(store.commitReady(edited.id, edited.version)).rejects.toThrow(/go together/);
  });

  it("holds a change to the replacement's time on its own, and the rule still updates after a move", async () => {
    const ruleId = await movedSeries();
    await approveReview();
    // The feed shifts the moved meeting by an hour: an update of the replacement, not of the original.
    const later = seriesOf({ exceptions: [moveEx({ localStartTime: "15:00", localEndTime: "16:00" })] });
    const result = await sync(readOf(later));
    expect(result).toMatchObject({ status: "needs_review" });
    const kinds = (await openBatch())!.records.map((r) => [r.importKey.split(":")[1], r.operation]);
    expect(kinds).toEqual([["event", "update"]]);
    await approveReview();
    const link = (await replacementLink())!;
    expect((await commitmentById(link.commitment_id!))!.starts_at.toISOString()).toBe(
      zonedDateTime(newDay(), "15:00", ZONE).toISOString()
    );
    // And a rule-level change still arrives as the one held rule update, with the moved date left as it was.
    const retimed = seriesOf({
      title: "Renamed series",
      exceptions: [moveEx({ localStartTime: "15:00", localEndTime: "16:00" })]
    });
    expect(await sync(readOf(retimed))).toMatchObject({ status: "needs_review", heldForReview: 1 });
    expect((await openBatch())!.records[0]).toMatchObject({
      entityType: "fixed_commitment_recurrence",
      operation: "update"
    });
    expect(ruleId).toBeTruthy();
  });

  it("moves back: the revert of the original and the replacement's removal are one held pair", async () => {
    const ruleId = await movedSeries();
    await approveReview();
    const link = (await replacementLink())!;
    const result = await sync(readOf(seriesOf()));
    expect(result).toMatchObject({ status: "needs_review", heldForReview: 2, committedBatchId: null });
    const records = (await openBatch())!.records;
    expect(new Set(records.map((r) => r.relationships.feedMove)).size).toBe(1);
    expect(records.map((r) => r.operation).sort()).toEqual(["delete", "update"]);
    // Nothing happens before approval.
    expect(await dateRow(ruleId, originalDate())).toMatchObject({ status: "cancelled" });
    expect(await replacementLink()).toBeDefined();
    await approveReview();
    expect(await dateRow(ruleId, originalDate())).toMatchObject({ status: "confirmed", schedule_source: "inherit" });
    // The replacement is cancelled with its link kept, not deleted (an event that comes back reopens it).
    expect(await replacementLink()).toBeDefined();
    expect(await commitmentById(link.commitment_id!)).toMatchObject({ status: "cancelled", closed_by: "system" });
    expect(await sync(readOf(seriesOf()))).toMatchObject({ status: "synced", heldForReview: 0 });
  });

  it("moves back inside its own day: the date changes in place and the replacement is dropped, as one pair", async () => {
    const ruleId = await movedSeries();
    await approveReview();
    const inPlace = seriesOf({
      exceptions: [changeOn(originalDate(), { title: "Back home", localStartTime: "11:00", localEndTime: "12:00" })]
    });
    expect(await sync(readOf(inPlace))).toMatchObject({ status: "needs_review", heldForReview: 2 });
    expect(new Set((await openBatch())!.records.map((r) => r.relationships.feedMove)).size).toBe(1);
    await approveReview();
    expect(await dateRow(ruleId, originalDate())).toMatchObject({
      status: "confirmed",
      title: "Back home",
      schedule_source: "custom"
    });
    expect(await replacementLink()).toBeDefined();
    expect(await sync(readOf(inPlace))).toMatchObject({ status: "synced", heldForReview: 0 });
  });

  it("proposes no new replacement from an incomplete read, and does not delete an existing one", async () => {
    await createSeries();
    expect(await sync(readOf(seriesOf({ exceptions: [moveEx()] }), { transportComplete: false }))).toMatchObject({
      heldForReview: 0
    });
    await sync(readOf(seriesOf({ exceptions: [moveEx()] })));
    await approveReview();
    const partial = await sync(readOf(seriesOf(), { transportComplete: false }));
    expect(partial).toMatchObject({ heldForReview: 0 });
    expect(await replacementLink()).toBeDefined();
  });
});

describe("a moved meeting is never left half done", () => {
  const originalDate = () => week(1);
  const newDay = () => addDays(week(1), 2);
  const moveEx = (over: Record<string, unknown> = {}) =>
    changeOn(originalDate(), { title: "Moved meeting", startDate: newDay(), endDate: newDay(), ...over });
  const replacementId = () => `${STEM}#move${compact(originalDate())}`;
  const replacementLink = async () =>
    (
      await sql<
        { commitment_id: string | null }[]
      >`SELECT commitment_id FROM calendar_event_links WHERE provider='calendar_feed' AND external_event_id=${replacementId()}`
    )[0];
  const movedMeetings = async () =>
    Number(
      (
        await sql<
          { n: string }[]
        >`SELECT count(*) AS n FROM commitments WHERE title='Moved meeting' AND recurrence_rule_id IS NULL AND status<>'cancelled'`
      )[0]!.n
    );
  const batchShape = async () =>
    ((await openBatch())?.records ?? []).map(
      (r) => `${r.importKey.split(":")[1]}/${r.operation}/${r.relationships.feedMove ?? "-"}`
    );

  it("proposes neither half when the new day is outside the read, so the original is not cancelled alone", async () => {
    const ruleId = await createSeries();
    const far = addDays(week(1), 150);
    const result = await sync(readOf(seriesOf({ exceptions: [moveEx({ startDate: far, endDate: far })] })));
    expect(result).toMatchObject({ heldForReview: 0 });
    expect(await openBatch()).toBeNull();
    expect(await dateRow(ruleId, originalDate())).toMatchObject({ status: "confirmed" });
  });

  it("proposes no lone cancel after both halves were unticked and committed (the replacement is dismissed)", async () => {
    const ruleId = await createSeries();
    await sync(readOf(seriesOf({ exceptions: [moveEx()] })));
    const batch = (await openBatch())!;
    const edited = await store.update(
      batch.id,
      batch.version,
      batch.records.map((r) => ({ ...r, removed: true }))
    );
    await store.commit(edited.id, edited.version);
    expect(await sync(readOf(seriesOf({ exceptions: [moveEx()] })))).toMatchObject({ heldForReview: 0 });
    expect(await batchShape()).toEqual([]);
    expect(await dateRow(ruleId, originalDate())).toMatchObject({ status: "confirmed" });
    expect(await replacementLink()).toBeUndefined();
  });

  it("proposes no lone cancel after the batch was discarded", async () => {
    const ruleId = await createSeries();
    await sync(readOf(seriesOf({ exceptions: [moveEx()] })));
    await store.delete((await openBatch())!.id, { recordDismissals: true });
    expect(await sync(readOf(seriesOf({ exceptions: [moveEx()] })))).toMatchObject({ heldForReview: 0 });
    expect(await batchShape()).toEqual([]);
    expect(await dateRow(ruleId, originalDate())).toMatchObject({ status: "confirmed" });
    expect(await movedMeetings()).toBe(0);
  });

  it("builds no revert from a read where an event of this very UID was skipped, and keeps the move as it was", async () => {
    const ruleId = await createSeries();
    await sync(readOf(seriesOf({ exceptions: [moveEx()] })));
    await approveReview();
    const skipped = { skipped: [{ idPrefix: STEM, reason: "unreadable event" }] };
    expect(await sync(readOf(seriesOf(), skipped))).toMatchObject({ heldForReview: 0 });
    expect(await batchShape()).toEqual([]);
    expect(await dateRow(ruleId, originalDate())).toMatchObject({ status: "cancelled" });
    expect(await replacementLink()).toBeDefined();
    expect(await movedMeetings()).toBe(1);
  });

  it("builds no revert and no rule update for a UID with a skipped event, while another UID's skip does not stop it", async () => {
    const ruleId = await createSeries();
    await sync(readOf(seriesOf({ exceptions: [cancelOn(week(1))] })));
    const skipped = { skipped: [{ idPrefix: STEM, reason: "unreadable event" }] };
    expect(await sync(readOf(seriesOf({ localStartTime: "09:30", localEndTime: "10:30" }), skipped))).toMatchObject({
      heldForReview: 0
    });
    expect(await dateRow(ruleId, week(1))).toMatchObject({ status: "cancelled" });
    const other = { skipped: [{ idPrefix: "someone-else", reason: "unreadable event" }] };
    expect(await sync(readOf(seriesOf(), other))).toMatchObject({ status: "needs_review", heldForReview: 1 });
  });

  it("refuses to commit a lone half, however the batch is committed", async () => {
    await createSeries();
    await sync(readOf(seriesOf({ exceptions: [moveEx()] })));
    const batch = (await openBatch())!;
    const half = batch.records.map((r, i) => ({ ...r, removed: i === 0 }));
    const edited = await store.update(batch.id, batch.version, half);
    await expect(store.commit(edited.id, edited.version)).rejects.toThrow(/go together/);
    await expect(store.commitReady(edited.id, edited.version)).rejects.toThrow(/go together/);
    const lone = await store.update(batch.id, edited.version, batch.records.slice(0, 1));
    await expect(store.commitReady(lone.id, lone.version)).rejects.toThrow(/go together/);
  });

  it("does not delete the replacement alone when the series becomes unrepresentable after an approved move", async () => {
    const ruleId = await createSeries();
    await sync(readOf(seriesOf({ exceptions: [moveEx()] })));
    await approveReview();
    const result = await sync(
      preparedFeed([feedEvent(`${STEM}#${compact(T0)}`, { recurring: true, seriesId: STEM })], {
        unrepresentableSeries: [{ idPrefix: STEM, reason: "shape" }]
      })
    );
    expect(result).toMatchObject({ status: "needs_review", heldForReview: 1 });
    const shape = await batchShape();
    expect(shape).toHaveLength(1);
    expect(shape[0]).toMatch(/^series\/delete\/-$/);
    await approveReview();
    // The rule ends, and the moved meeting stays as the one-off event it is: the original is not left cancelled with no meeting.
    expect((await rules())[0]!.status).toBe("ended");
    expect(await replacementLink()).toBeDefined();
    expect(await movedMeetings()).toBe(1);
    expect(ruleId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// PR 9: shape change, keep, generations, owner deletions, adoption, and the moved-meeting minors.

const dismissalIds = async () =>
  (
    await sql<
      { external_event_id: string }[]
    >`SELECT external_event_id FROM calendar_event_dismissals WHERE provider='calendar_feed' ORDER BY external_event_id`
  ).map((row) => row.external_event_id);
const importKeys = async () =>
  (
    await sql<
      { import_key: string }[]
    >`SELECT import_key FROM import_entity_keys WHERE import_key LIKE 'calendar_feed:%' ORDER BY import_key`
  ).map((row) => row.import_key);
const linkFor = async (externalEventId: string) =>
  (
    await sql<
      { recurrence_rule_id: string; last_remote_snapshot: Record<string, any> }[]
    >`SELECT recurrence_rule_id, last_remote_snapshot FROM calendar_event_links WHERE provider='calendar_feed' AND external_event_id=${externalEventId}`
  )[0];
/** A read in which the UID is listed as a repeating event the proxy could not describe. */
const unrepresentable = (reason = "its rule has a shape the portal cannot follow") =>
  preparedFeed([feedEvent(`${STEM}#${compact(week(0))}`, { recurring: true, seriesId: STEM })], {
    unrepresentableSeries: [{ idPrefix: STEM, reason }]
  });
/** A non-empty complete read that does not have the UID at all (another repeating event, which is not imported, is in it). */
const withoutTheSeries = () =>
  preparedFeed([feedEvent(`zzz#${compact(week(0))}`, { recurring: true, seriesId: "zzz" })], {
    unrepresentableSeries: [{ idPrefix: "zzz", reason: "another shape" }]
  });
const unticked = async (predicate: (record: ImportRecord) => boolean = () => true) => {
  const batch = (await openBatch())!;
  const edited = await store.update(
    batch.id,
    batch.version,
    batch.records.map((record) => ({ ...record, removed: predicate(record) }))
  );
  return store.commitReady(edited.id, edited.version).catch(async () => store.commit(edited.id, edited.version));
};

describe("the shape-change card", () => {
  it("holds one end with the card text, the proxy's reason and the exact next calls, and does nothing before it is approved", async () => {
    const ruleId = await createSeries();
    const result = await sync(unrepresentable("a rule with BYSETPOS"));
    expect(result).toMatchObject({ status: "needs_review", heldForReview: 1, committedBatchId: null });
    const [record] = (await openBatch())!.records;
    expect(record).toMatchObject({
      entityType: "fixed_commitment_recurrence",
      operation: "delete",
      importKey: `calendar_feed:series:${STEM}`,
      relationships: { feedSeries: STEM, feedReasonKind: "shape" }
    });
    const rel = record!.relationships;
    expect(rel.feedReason).toContain(`"Series ${STEM}"`);
    expect(rel.feedReason).toContain("a rule with BYSETPOS");
    expect(rel.feedReason).toContain("Keep it");
    expect(rel.feedNextCall).toContain("PUT /api/imports/{batchId}");
    expect(rel.feedNextCall).toContain("/commit-ready");
    expect((await rules())[0]!.status).toBe("active");
    expect(ruleId).toBeTruthy();
  });

  it("persists Keep: an unticked end survives the committed batch and is not proposed again", async () => {
    await createSeries();
    await sync(unrepresentable());
    await unticked();
    expect((await linkFor(`series:${STEM}`))!.last_remote_snapshot.feedKeep).toBe("shape");
    expect((await rules())[0]!.status).toBe("active");
    // Hourly syncs of the same unfollowable shape stay quiet.
    expect(await sync(unrepresentable())).toMatchObject({ status: "synced", heldForReview: 0 });
    expect(await sync(unrepresentable())).toMatchObject({ status: "synced", heldForReview: 0 });
    expect(await openBatch()).toBeNull();
  });

  it("clears a kept end when the shape is representable again, and asks again if it changes back", async () => {
    await createSeries();
    await sync(unrepresentable());
    await unticked();
    expect(await sync(readOf(seriesOf()))).toMatchObject({ status: "synced", heldForReview: 0 });
    expect((await linkFor(`series:${STEM}`))!.last_remote_snapshot.feedKeep).toBeUndefined();
    expect(await sync(unrepresentable())).toMatchObject({ status: "needs_review", heldForReview: 1 });
  });

  it("ends the rule on approval: the link records the shape end, the UID is declined, and it is never revived", async () => {
    const ruleId = await createSeries();
    await sync(unrepresentable());
    await approveReview();
    expect((await rules())[0]!.status).toBe("ended");
    expect((await linkFor(`series:${STEM}`))!.last_remote_snapshot.endedBy).toBe("shape");
    expect(await dismissalIds()).toContain(`series:${STEM}`);
    // The shape becomes followable again: no new generation and nothing proposed, because the owner approved the end.
    expect(await sync(readOf(seriesOf()))).toMatchObject({ status: "synced", heldForReview: 0 });
    expect(await openBatch()).toBeNull();
    expect(await ruleLinks()).toHaveLength(1);
    expect(ruleId).toBeTruthy();
  });

  it("keeps a cancelled master and a vanished UID the same way", async () => {
    await createSeries();
    await sync(readOf(seriesOf({ status: "cancelled" })));
    expect((await openBatch())!.records[0]!.relationships.feedReasonKind).toBe("cancelled");
    await unticked();
    expect(await sync(readOf(seriesOf({ status: "cancelled" })))).toMatchObject({ heldForReview: 0 });
    // The feed un-cancels it: the kept end is forgotten.
    expect(await sync(readOf(seriesOf()))).toMatchObject({ heldForReview: 0 });
    expect((await linkFor(`series:${STEM}`))!.last_remote_snapshot.feedKeep).toBeUndefined();
    await sync(withoutTheSeries());
    expect((await openBatch())!.records[0]!.relationships.feedReasonKind).toBe("gone");
    await unticked();
    expect(await sync(withoutTheSeries())).toMatchObject({ heldForReview: 0 });
    expect((await linkFor(`series:${STEM}`))!.last_remote_snapshot.feedKeep).toBe("gone");
  });
});

describe("a kept date", () => {
  it("is not proposed again while the feed asks the same, and is when it asks something else", async () => {
    const ruleId = await createSeries();
    const change = changeOn(week(2));
    await sync(readOf(seriesOf({ exceptions: [change] })));
    expect((await openBatch())!.records).toHaveLength(1);
    await unticked();
    expect(await dateRow(ruleId, week(2))).toMatchObject({ title: "Series wk", schedule_source: "inherit" });
    expect((await dismissalIds()).some((id) => id === `occ:${ruleId}:${week(2)}`)).toBe(true);
    expect(await sync(readOf(seriesOf({ exceptions: [change] })))).toMatchObject({
      status: "synced",
      heldForReview: 0
    });
    // A different ask for the same date comes back.
    expect(
      await sync(readOf(seriesOf({ exceptions: [changeOn(week(2), { localStartTime: "15:00" })] })))
    ).toMatchObject({
      status: "needs_review",
      heldForReview: 1
    });
  });

  it("keeps a revert the owner declined, and forgets dates whose day has passed", async () => {
    const ruleId = await createSeries();
    await sync(readOf(seriesOf({ exceptions: [changeOn(week(2))] })));
    await approveReview();
    // The feed drops the change: a revert is proposed, and kept.
    expect(await sync(readOf(seriesOf()))).toMatchObject({ status: "needs_review", heldForReview: 1 });
    await unticked();
    expect(await sync(readOf(seriesOf()))).toMatchObject({ status: "synced", heldForReview: 0 });
    expect(await dateRow(ruleId, week(2))).toMatchObject({ title: "Retimed" });
    await sql`UPDATE calendar_event_dismissals SET starts_at = starts_at - INTERVAL '30 days' WHERE provider='calendar_feed'`;
    await sync(readOf(seriesOf()));
    expect(await dismissalIds()).toEqual([]);
  });
});

describe("generations", () => {
  /** The feed itself ends the rule (the UID vanishes from a complete read) and the owner approves. */
  async function feedEnds() {
    await sync(withoutTheSeries());
    await approveReview();
  }

  it("revives a rule the feed ended as generation 2, from its first real instance, and is steady afterwards", async () => {
    const first = await createSeries();
    await feedEnds();
    expect((await rules())[0]!.status).toBe("ended");
    expect((await linkFor(`series:${STEM}`))!.last_remote_snapshot.endedBy).toBe("feed");
    // The UID returns, bounded by a COUNT that leaves five dates (the proxy states a bound as the last instance).
    const bounded = seriesOf({ endDate: week(6) });
    const result = await sync(readOf(bounded));
    expect(result).toMatchObject({ status: "needs_review", heldForReview: 1 });
    const [create] = (await openBatch())!.records;
    expect(create).toMatchObject({
      operation: "create",
      importKey: `calendar_feed:series:${STEM}.2`,
      relationships: { feedSeries: STEM, feedGeneration: "2" }
    });
    expect(create!.fields.startDate!.value).toBe(week(0));
    expect(create!.fields.endDate!.value).toBe(week(6));
    expect(create!.relationships.feedNote).toContain("is back");
    await approveReview();
    const all = await rules();
    expect(all).toHaveLength(2);
    const second = (await linkFor(`series:${STEM}.2`))!;
    expect(second.last_remote_snapshot).toMatchObject({ feedStem: STEM, feedGeneration: 2, startDate: week(0) });
    expect(second.recurrence_rule_id).not.toBe(first);
    // The old generation stays ended, and the new rule is steady against the same read.
    expect((await rules()).find((r) => r.id === first)!.status).toBe("ended");
    expect(await sync(readOf(bounded))).toMatchObject({ status: "synced", heldForReview: 0 });
    // The new generation follows the feed as any rule does: a cancelled date is applied under its own rule.
    const dated = seriesOf({ endDate: week(6), exceptions: [cancelOn(week(3))] });
    await replan(second.recurrence_rule_id, 90);
    expect(await sync(readOf(dated))).toMatchObject({ status: "synced", updated: 1 });
    expect(await dateRow(second.recurrence_rule_id, week(3))).toMatchObject({ status: "cancelled" });
    // The old generation's date was closed when the feed ended it (not deleted), and stays closed: no open duplicate.
    expect(await dateRow(first, week(3))).toMatchObject({ status: "cancelled" });
  });

  it("starts the revival at the first date from today that is not cancelled or moved", async () => {
    await createSeries();
    await feedEnds();
    await sync(readOf(seriesOf({ exceptions: [cancelOn(week(0))] })));
    expect((await openBatch())!.records[0]!.fields.startDate!.value).toBe(week(1));
  });

  it("revives again as generation 3 when the feed ends the second generation too", async () => {
    await createSeries();
    await feedEnds();
    await sync(readOf(seriesOf()));
    await approveReview();
    await feedEnds();
    expect((await linkFor(`series:${STEM}.2`))!.last_remote_snapshot.endedBy).toBe("feed");
    await sync(readOf(seriesOf()));
    expect((await openBatch())!.records[0]!.importKey).toBe(`calendar_feed:series:${STEM}.3`);
  });

  it("proposes no revival when the revived series has no instance left", async () => {
    await createSeries();
    await feedEnds();
    expect(await sync(readOf(seriesOf({ endDate: addDays(week(0), 1) })))).toMatchObject({ heldForReview: 1 });
    expect(await sync(readOf(seriesOf({ startDate: week(-3), endDate: addDays(today(), -1) })))).toMatchObject({
      heldForReview: 0
    });
    expect(await openBatch()).toBeNull();
  });

  it("never revives a rule the owner ended, even after the rule is deleted; the decline covers every generation", async () => {
    const ruleId = await createSeries();
    await sql`UPDATE commitment_recurrence_rules SET status='ended', version=version+1 WHERE id=${ruleId}`;
    expect(await sync(readOf(seriesOf()))).toMatchObject({ status: "synced", heldForReview: 0 });
    expect((await linkFor(`series:${STEM}`))!.last_remote_snapshot.endedBy).toBe("owner");
    expect(await dismissalIds()).toContain(`series:${STEM}`);
    await sql`DELETE FROM commitment_recurrence_rules WHERE id=${ruleId}`;
    expect(await sync(readOf(seriesOf()))).toMatchObject({ status: "synced", heldForReview: 0 });
    expect(await openBatch()).toBeNull();
    expect(await rules()).toEqual([]);
  });

  it("does not revive a rule the feed ended when the owner has declined the UID", async () => {
    await createSeries();
    await feedEnds();
    await sql`INSERT INTO calendar_event_dismissals(user_id,provider,external_event_id,title,starts_at) VALUES(${userId},'calendar_feed',${`series:${STEM}`},'x',now())`;
    expect(await sync(readOf(seriesOf()))).toMatchObject({ status: "synced", heldForReview: 0 });
  });

  it("withdraws the owner's decline when the owner reopens the rule, so a later end by the feed can be revived", async () => {
    const ruleId = await createSeries();
    await sql`UPDATE commitment_recurrence_rules SET status='ended', version=version+1 WHERE id=${ruleId}`;
    await sync(readOf(seriesOf()));
    expect(await dismissalIds()).toContain(`series:${STEM}`);
    await sql`UPDATE commitment_recurrence_rules SET status='active', version=version+1 WHERE id=${ruleId}`;
    await sync(readOf(seriesOf()));
    expect(await dismissalIds()).not.toContain(`series:${STEM}`);
    await feedEnds();
    await sync(readOf(seriesOf()));
    expect((await openBatch())!.records[0]!.importKey).toBe(`calendar_feed:series:${STEM}.2`);
  });

  it("forgets who ended a rule the owner reopened", async () => {
    const ruleId = await createSeries();
    await feedEnds();
    await sql`UPDATE commitment_recurrence_rules SET status='active', version=version+1 WHERE id=${ruleId}`;
    await sync(readOf(seriesOf()));
    expect((await linkFor(`series:${STEM}`))!.last_remote_snapshot.endedBy).toBeUndefined();
    expect(await openBatch()).toBeNull();
  });
});

describe("what an owner's deletion leaves behind", () => {
  it("clears the stale key of a rule deleted outright, declines the UID, and does not propose it again", async () => {
    const ruleId = await createSeries();
    expect(await importKeys()).toContain(`calendar_feed:series:${STEM}`);
    await sql`DELETE FROM commitment_recurrence_rules WHERE id=${ruleId}`;
    expect(await sync(readOf(seriesOf()))).toMatchObject({ status: "synced", heldForReview: 0 });
    expect(await importKeys()).not.toContain(`calendar_feed:series:${STEM}`);
    expect(await dismissalIds()).toContain(`series:${STEM}`);
    expect(await sync(readOf(seriesOf()))).toMatchObject({ status: "synced", heldForReview: 0 });
    expect(await rules()).toEqual([]);
  });

  it("clears the stale key of a moved meeting's replacement the owner deleted, so it is proposed as a create and not a conflict", async () => {
    const ruleId = await createSeries();
    const original = week(1);
    const newDay = addDays(original, 2);
    const move = changeOn(original, { title: "Moved meeting", startDate: newDay, endDate: newDay });
    await sync(readOf(seriesOf({ exceptions: [move] })));
    await approveReview();
    const key = `calendar_feed:event:${STEM}#move${compact(original)}`;
    expect(await importKeys()).toContain(key);
    await sql`DELETE FROM commitments WHERE title='Moved meeting' AND recurrence_rule_id IS NULL AND status<>'cancelled'`;
    const result = await sync(readOf(seriesOf({ exceptions: [move] })));
    expect(result.status).not.toBe("failed");
    expect(await importKeys()).not.toContain(key);
    const records = (await openBatch())?.records ?? [];
    expect(records.map((r) => r.operation)).toEqual(["create"]);
    expect(records[0]!.errors).toEqual([]);
    // Unticking it is remembered like any declined event.
    await unticked();
    expect(await sync(readOf(seriesOf({ exceptions: [move] })))).toMatchObject({ status: "synced", heldForReview: 0 });
    expect(await dateRow(ruleId, original)).toMatchObject({ status: "cancelled" });
  });
});

describe("a moved meeting that the feed cancels or drops", () => {
  const originalDate = () => week(1);
  const newDay = () => addDays(week(1), 2);
  const moveEx = (over: Record<string, unknown> = {}) =>
    changeOn(originalDate(), { title: "Moved meeting", startDate: newDay(), endDate: newDay(), ...over });
  const movedCount = async () =>
    Number(
      (
        await sql<
          { n: string }[]
        >`SELECT count(*) AS n FROM commitments WHERE title='Moved meeting' AND recurrence_rule_id IS NULL AND status<>'cancelled'`
      )[0]!.n
    );
  async function approvedMove() {
    const ruleId = await createSeries();
    await sync(readOf(seriesOf({ exceptions: [moveEx()] })));
    await approveReview();
    expect(await movedCount()).toBe(1);
    return ruleId;
  }

  it("keeps the replacement's removal as a held record with a note when the feed cancels the date (no silent ghost)", async () => {
    await approvedMove();
    const result = await sync(readOf(seriesOf({ exceptions: [cancelOn(originalDate())] })));
    expect(result).toMatchObject({ status: "needs_review", heldForReview: 1 });
    const [record] = (await openBatch())!.records;
    expect(record).toMatchObject({ operation: "delete" });
    expect(record!.relationships.feedMove).toBeUndefined();
    expect(record!.warnings.join(" ")).toContain("cancelled this date");
    expect(await movedCount()).toBe(1);
    await approveReview();
    expect(await movedCount()).toBe(0);
  });

  it("does the same when the whole master is cancelled, and when the UID is gone from the feed", async () => {
    await approvedMove();
    await sync(readOf(seriesOf({ status: "cancelled", exceptions: [moveEx()] })));
    const cancelled = (await openBatch())!.records;
    expect(cancelled.map((r) => `${r.entityType}/${r.operation}`).sort()).toEqual([
      "fixed_commitment/delete",
      "fixed_commitment_recurrence/delete"
    ]);
    expect(cancelled.find((r) => r.entityType === "fixed_commitment")!.warnings.join(" ")).toContain("cancelled");
    await sync(withoutTheSeries());
    const gone = (await openBatch())!.records;
    expect(gone.map((r) => r.entityType).sort()).toEqual(["fixed_commitment", "fixed_commitment_recurrence"]);
    expect(gone.find((r) => r.entityType === "fixed_commitment")!.warnings.join(" ")).toContain(
      "no longer in the calendar feed"
    );
    expect(await movedCount()).toBe(1);
  });

  it("does not propose the replacement's removal at all from a read that cannot speak for it", async () => {
    await approvedMove();
    expect(
      await sync(readOf(seriesOf({ exceptions: [cancelOn(originalDate())] }), { transportComplete: false }))
    ).toMatchObject({
      heldForReview: 0
    });
    expect(await movedCount()).toBe(1);
  });

  it("moves both halves aside together when one becomes a conflict after the preview, and commits the rest without throwing", async () => {
    const ruleId = await createSeries();
    await sync(readOf(seriesOf({ exceptions: [moveEx(), changeOn(week(3))] })));
    const batch = (await openBatch())!;
    expect(batch.records).toHaveLength(3);
    // The owner edits the original date after the preview was made: its update is now stale, a conflict at commit.
    await sql`UPDATE commitments SET version=version+1 WHERE recurrence_rule_id=${ruleId} AND local_date=${originalDate()}::date`;
    const { batch: committed, deferred } = await store.commitReady(batch.id, batch.version);
    const written = committed.records.filter((record) => !record.removed).map((record) => record.importKey);
    expect(written).toEqual([expect.stringContaining(`calendar_feed:occ:${ruleId}:${week(3)}`)]);
    expect(deferred!.records.map((record) => record.relationships.feedMove).sort()).toEqual([
      `mv:${STEM}:${originalDate()}`,
      `mv:${STEM}:${originalDate()}`
    ]);
    // Neither half was written: the original is not cancelled and there is no moved meeting.
    expect(await dateRow(ruleId, originalDate())).toMatchObject({ status: "confirmed" });
    expect(await movedCount()).toBe(0);
  });

  it("holds the owner's edit of the replacement as a conflict when the feed moves the date back, and loses nothing", async () => {
    const ruleId = await approvedMove();
    await sql`UPDATE commitments SET title='Moved meeting (mine)', version=version+1 WHERE title='Moved meeting' AND recurrence_rule_id IS NULL AND status<>'cancelled'`;
    const result = await sync(readOf(seriesOf()));
    expect(result.status).toBe("needs_review");
    const records = (await openBatch())!.records;
    // Only the conflict is held: the date's revert is not offered on its own, because the original must not come back
    // while the replacement is still the owner's meeting, and it cannot be committed alone.
    expect(records.map((r) => `${r.importKey.split(":")[1]}/${r.operation}`)).toEqual(["event/conflict"]);
    const batch = (await openBatch())!;
    await expect(store.commitReady(batch.id, batch.version)).rejects.toThrow();
    expect(await dateRow(ruleId, originalDate())).toMatchObject({ status: "cancelled" });
    expect(await sql`SELECT 1 FROM commitments WHERE title='Moved meeting (mine)'`).toHaveLength(1);
  });
});

describe("a date the feed cancels, and a cancel the owner made on a planner-owned date", () => {
  const stamp = async (ruleId: string, date: string) =>
    (
      await sql<
        {
          status: string;
          closed_by: string | null;
          closed_reason: string | null;
          closed_batch: string | null;
          closed_from_status: string | null;
        }[]
      >`SELECT status, closed_by, closed_reason, closed_batch, closed_from_status FROM commitments WHERE recurrence_rule_id=${ruleId} AND local_date=${date}::date`
    )[0]!;
  /** The owner cancelling a date from the portal: `closed_by` is `person`, as the close command stamps it. */
  const ownerCancels = (ruleId: string, date: string) =>
    sql.begin(async (tx) => {
      await tx`SELECT set_config('priorities.actor', 'person', true)`;
      await tx`UPDATE commitments SET status='cancelled', closed_reason='Not going', version=version+1 WHERE recurrence_rule_id=${ruleId} AND local_date=${date}::date`;
    });
  const ledger = (rowId: string) =>
    sql<
      { write_id: string; evidence: Record<string, any> }[]
    >`SELECT write_id, evidence FROM write_rows WHERE operation='close' AND entity_type='commitment' AND entity_id=${rowId}`;

  it("stamps a feed cancel of a planner-owned date as the source's removal, with a ledger row under the import batch", async () => {
    const ruleId = await createSeries();
    const result = await sync(readOf(seriesOf({ exceptions: [cancelOn(week(1))] })));
    expect(result.committedBatchId).toEqual(expect.any(String));
    const row = (await dateRow(ruleId, week(1)))!;
    expect(await stamp(ruleId, week(1))).toMatchObject({
      status: "cancelled",
      closed_by: "system",
      closed_reason: "Removed at source: Cancelled for this date in the calendar feed",
      closed_from_status: "confirmed",
      closed_batch: result.committedBatchId
    });
    const rows = await ledger(row.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.write_id).toBe(result.committedBatchId);
    expect(rows[0]!.evidence).toMatchObject({ do: "close", verb: "cancel", via: "import", closed: 1 });
  });

  it("stamps a cancelled date the commit inserts itself, the same way", async () => {
    const ruleId = await createSeries(seriesOf(), 0);
    const result = await sync(readOf(seriesOf({ exceptions: [cancelOn(week(3))] })));
    expect(await stamp(ruleId, week(3))).toMatchObject({
      status: "cancelled",
      closed_by: "system",
      closed_reason: "Removed at source: Cancelled for this date in the calendar feed",
      closed_batch: result.committedBatchId
    });
    expect(await ledger(commitmentOccurrenceRowId(ruleId, week(3)))).toHaveLength(1);
  });

  it("does not reopen a date the owner cancelled when the feed sends a change for it", async () => {
    const ruleId = await createSeries();
    await ownerCancels(ruleId, week(1));
    const held = await sync(readOf(seriesOf({ exceptions: [changeOn(week(1))] })));
    expect(held).toMatchObject({ status: "needs_review", heldForReview: 1 });
    await approveReview();
    expect(await dateRow(ruleId, week(1))).toMatchObject({ title: "Retimed", status: "cancelled" });
    expect(await stamp(ruleId, week(1))).toMatchObject({ closed_by: "person", closed_reason: "Not going" });
  });

  it("does not reopen it through the insert either, when the planner made the date after the diff saw none", async () => {
    const ruleId = await createSeries();
    await ownerCancels(ruleId, week(1));
    const row = (await dateRow(ruleId, week(1)))!;
    await sql.begin((tx) =>
      insertFeedDate(
        tx as never,
        userId,
        ruleId,
        week(1),
        {
          title: "Retimed",
          startsAt: row.starts_at.toISOString(),
          endsAt: row.ends_at.toISOString(),
          status: "confirmed",
          location: null,
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        },
        null
      )
    );
    expect(await dateRow(ruleId, week(1))).toMatchObject({ title: "Retimed", status: "cancelled" });
    expect(await stamp(ruleId, week(1))).toMatchObject({ closed_by: "person" });
  });

  it("does not close a date the owner edited when the insert's statement wrote nothing for it", async () => {
    const ruleId = await createSeries();
    await sql`UPDATE commitments SET schedule_source='custom' WHERE recurrence_rule_id=${ruleId} AND local_date=${week(1)}::date`;
    const row = (await dateRow(ruleId, week(1)))!;
    await sql.begin((tx) =>
      insertFeedDate(
        tx as never,
        userId,
        ruleId,
        week(1),
        {
          title: "Cancelled by feed",
          startsAt: row.starts_at.toISOString(),
          endsAt: row.ends_at.toISOString(),
          status: "cancelled",
          location: null,
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        },
        null,
        { batchId: crypto.randomUUID() }
      )
    );
    expect((await dateRow(ruleId, week(1)))!.status).not.toBe("cancelled");
    expect(await ledger(row.id)).toHaveLength(0);
  });

  it("leaves an already cancelled date alone when the feed cancels it too: nothing rewritten, nothing counted", async () => {
    const ruleId = await createSeries();
    await ownerCancels(ruleId, week(1));
    const before = await stamp(ruleId, week(1));
    const row = (await dateRow(ruleId, week(1)))!;
    await sql.begin((tx) =>
      insertFeedDate(
        tx as never,
        userId,
        ruleId,
        week(1),
        {
          title: row.title,
          startsAt: row.starts_at.toISOString(),
          endsAt: row.ends_at.toISOString(),
          status: "cancelled",
          location: null,
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        },
        null
      )
    );
    expect(await stamp(ruleId, week(1))).toEqual(before);
    expect(await ledger(row.id)).toHaveLength(0);
  });

  it("reopens a date the feed cancelled when the EXDATE goes, to the status it had", async () => {
    const ruleId = await createSeries();
    await sync(readOf(seriesOf({ exceptions: [cancelOn(week(1))] })));
    await sync(readOf(seriesOf()));
    await approveReview();
    expect(await stamp(ruleId, week(1))).toEqual({
      status: "confirmed",
      closed_by: null,
      closed_reason: null,
      closed_batch: null,
      closed_from_status: null
    });
  });
});
