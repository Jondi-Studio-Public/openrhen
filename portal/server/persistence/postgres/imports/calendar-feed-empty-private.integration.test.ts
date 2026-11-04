import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";

// The OpenRhen export empties every private seam. Replacing them with nothing here, the calendar feed (which is core)
// must still register its extension and store method, diff, commit and link; and what the seams hold (the shared-calendar
// and roster extensions) must really be gone, or this test would prove nothing.
vi.mock("./private/index", () => ({}));
vi.mock("./calendar-profiles/private/index", () => ({}));
vi.mock("../private/index", () => ({}));
vi.mock("@/server/private/providers", () => ({}));

const { PostgresImportStore } = await import("../import-store");
const { importExtensions } = await import("./import-extensions");
const { registeredDiffProfileNames } = await import("./calendar-diff");
const { FEED_EVENT_PREFIX } = await import("./calendar-profiles/calendar-feed");
const { FEED_TIMEZONE, FEED_WINDOW, feedEvent, feedSeriesEvents, preparedFeed } =
  await import("./calendar-feed-test-support");

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.TEST_DATABASE_NAME,
  "openrhen_calendar_feed_empty_private"
);
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) throw new Error("TEST_DATABASE_NAME must end in _test");
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let store: InstanceType<typeof PostgresImportStore>;

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
});

afterAll(async () => {
  await sql?.end();
});

describe("the calendar feed with the private seams emptied", () => {
  it("has none of the private extensions or profiles, and still has the feed's", () => {
    expect(importExtensions().map((extension) => extension.id)).toEqual(["calendar_feed"]);
    expect(registeredDiffProfileNames()).toEqual(["calendar", "fixed_blocks"]);
  });

  it("diffs, commits and links a feed event, then diffs to nothing", async () => {
    const events = [feedEvent("solo", { title: "Dentist" })];
    const diff = await store.diffCalendarFeed({
      timezone: FEED_TIMEZONE,
      ...FEED_WINDOW,
      prepared: preparedFeed(events)
    });
    expect(diff.records.map((record) => [record.importKey, record.operation])).toEqual([
      [`${FEED_EVENT_PREFIX}solo`, "create"]
    ]);
    const batch = await store.preview(diff.previewFor(diff.records));
    await store.commit(batch.id, batch.version);
    expect(
      await sql`SELECT 1 FROM calendar_event_links WHERE provider='calendar_feed' AND external_event_id='solo'`
    ).toHaveLength(1);
    const again = await store.diffCalendarFeed({
      timezone: FEED_TIMEZONE,
      ...FEED_WINDOW,
      prepared: preparedFeed(events)
    });
    expect(again.records).toEqual([]);
  });

  it("diffs, commits and links a repeating series as one rule, then diffs to nothing", async () => {
    const events = feedSeriesEvents("weekly");
    const diff = await store.diffCalendarFeed({
      timezone: FEED_TIMEZONE,
      ...FEED_WINDOW,
      prepared: preparedFeed(events)
    });
    expect(diff.records.map((record) => [record.importKey, record.operation])).toEqual([
      ["calendar_feed:series:weekly", "create"]
    ]);
    const batch = await store.preview(diff.previewFor(diff.records));
    await store.commit(batch.id, batch.version);
    expect(
      await sql`SELECT 1 FROM calendar_event_links WHERE provider='calendar_feed' AND external_event_id='series:weekly' AND recurrence_rule_id IS NOT NULL`
    ).toHaveLength(1);
    const again = await store.diffCalendarFeed({
      timezone: FEED_TIMEZONE,
      ...FEED_WINDOW,
      prepared: preparedFeed(events)
    });
    expect(again.records).toEqual([]);
  });
});
