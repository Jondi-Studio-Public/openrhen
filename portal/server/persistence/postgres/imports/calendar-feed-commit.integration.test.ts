import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import type { ImportRecord, PreviewImport } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { calendarFeedAdapter } from "@/server/imports/calendar-feed-adapter";
import { PostgresImportStore } from "../import-store";
import { importExtensions } from "./import-extensions";
import { FEED_EVENT_PREFIX, FEED_MAX_RECORDS, FEED_MAX_SOURCE_CHARS } from "./calendar-profiles/calendar-feed";
import { FEED_TIMEZONE, FEED_WINDOW, feedEvent, feedExtras, preparedFeed } from "./calendar-feed-test-support";

const readCalendarEvents = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/calendar-source-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/calendar-source-client")>()),
  readCalendarEvents
}));

/**
 * The calendar feed's per-instance path against a real database (build plan PR 6): a feed read through the adapter,
 * the diff, the review batch, the commit and the link it writes, then the next diff over what was written. Its own
 * `_test` database, so it belongs to `corepack pnpm test:integration`.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_calendar_feed_commit");
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
  readCalendarEvents.mockReset();
});

afterAll(async () => {
  await sql?.end();
});

type Prepared = ReturnType<typeof preparedFeed>;
const diffOf = (prepared: Prepared) => store.diffCalendarFeed({ timezone: FEED_TIMEZONE, ...FEED_WINDOW, prepared });

/** Reviews and commits the records the way the sync's held batch does: preview, then commit what is ready. */
async function commit(
  diff: { records: ImportRecord[]; previewFor: (records: ImportRecord[]) => PreviewImport },
  records: ImportRecord[] = diff.records
) {
  const batch = await store.preview(diff.previewFor(records));
  return store.commitReady(batch.id, batch.version);
}

const commitmentTitles = async () =>
  (await sql<{ title: string }[]>`SELECT title FROM commitments WHERE user_id=${userId} ORDER BY title`).map(
    (row) => row.title
  );
const feedLinks = () =>
  sql<
    { external_event_id: string; frame_id: string; role: string; profile_label: string; commitment_id: string }[]
  >`SELECT external_event_id, frame_id, role, profile_label, commitment_id FROM calendar_event_links WHERE provider='calendar_feed' ORDER BY external_event_id`;

async function manualCommitment(title: string, startsAt: string, endsAt: string): Promise<string> {
  const rows = await sql<
    { id: string }[]
  >`INSERT INTO commitments(user_id,title,starts_at,ends_at,status) VALUES(${userId},${title},${startsAt},${endsAt},'confirmed') RETURNING id`;
  return rows[0]!.id;
}

describe("a feed read through the adapter, persisted", () => {
  it("creates, links, then diffs to nothing: a fresh link is steady", async () => {
    readCalendarEvents.mockResolvedValue({
      events: [
        feedEvent("solo-uid", { title: "Dentist", location: "High St" }),
        feedEvent("orphan#20261112", {
          title: "Moved lecture",
          recurring: true,
          seriesId: "orphan",
          startsAt: "2026-11-12T03:00:00.000Z",
          endsAt: "2026-11-12T04:00:00.000Z"
        })
      ],
      scope: { frameId: null, timezone: FEED_TIMEZONE },
      extras: feedExtras()
    });
    const read = await calendarFeedAdapter.read({ ...FEED_WINDOW, timezone: FEED_TIMEZONE, env: {} });
    expect(read.status).toBe("read");
    if (read.status !== "read") return;
    const diff = await read.diff(store);
    expect(diff.records.map((r) => [r.importKey, r.operation])).toEqual([
      [`${FEED_EVENT_PREFIX}solo-uid`, "create"],
      [`${FEED_EVENT_PREFIX}orphan#20261112`, "create"]
    ]);
    expect(diff.notImported).toEqual({
      unrepresentableSeries: 0,
      seriesPending: 0,
      seriesChanged: 0,
      unreadable: 0,
      droppedForSize: 0
    });
    expect(diff.records[0]!.fields.title!.evidence[0]).toContain("Calendar feed");

    const { batch } = await commit(diff);
    expect(batch.status).toBe("committed");
    expect(await commitmentTitles()).toEqual(["Dentist", "Moved lecture"]);
    expect(await feedLinks()).toEqual([
      expect.objectContaining({
        external_event_id: "orphan#20261112",
        frame_id: "feed",
        role: "secondary",
        profile_label: "Calendar feed"
      }),
      expect.objectContaining({ external_event_id: "solo-uid", frame_id: "feed", role: "secondary" })
    ]);
    const source = await sql<{ source_type: string; external_id: string; captured_text: string }[]>`
      SELECT source_type, external_id, captured_text FROM sources WHERE source_type='calendar_feed_event' ORDER BY external_id`;
    expect(source.map((row) => row.external_id)).toEqual(["orphan#20261112", "solo-uid"]);
    // The stored text is the id-only shape: no description is kept anywhere.
    expect(Object.keys(JSON.parse(source[1]!.captured_text))).not.toContain("description");

    const again = await diffOf(
      preparedFeed([
        feedEvent("solo-uid", { title: "Dentist", location: "High St" }),
        feedEvent("orphan#20261112", {
          title: "Moved lecture",
          recurring: true,
          seriesId: "orphan",
          startsAt: "2026-11-12T03:00:00.000Z",
          endsAt: "2026-11-12T04:00:00.000Z"
        })
      ])
    );
    expect(again.records).toEqual([]);
  });

  it("proposes an update for a changed linked event, applies a cancellation as a delete, and commits both", async () => {
    await commit(
      await diffOf(preparedFeed([feedEvent("a", { title: "Standup" }), feedEvent("b", { title: "Review" })]))
    );
    const changed = await diffOf(
      preparedFeed([
        feedEvent("a", { title: "Standup", startsAt: "2026-11-10T02:00:00.000Z", endsAt: "2026-11-10T03:00:00.000Z" }),
        feedEvent("b", { title: "Review", status: "cancelled" })
      ])
    );
    const byKey = Object.fromEntries(changed.records.map((r) => [r.importKey, r]));
    expect(byKey[`${FEED_EVENT_PREFIX}a`]).toMatchObject({ operation: "update" });
    expect(byKey[`${FEED_EVENT_PREFIX}b`]).toMatchObject({
      operation: "delete",
      relationships: { remoteCancelled: "true" }
    });
    await commit(changed);
    expect(await commitmentTitles()).toEqual(["Standup"]);
    expect((await feedLinks()).map((l) => l.external_event_id)).toEqual(["a"]);
    const row = await sql<{ starts_at: Date }[]>`SELECT starts_at FROM commitments WHERE title='Standup'`;
    expect(row[0]!.starts_at.toISOString()).toBe("2026-11-10T02:00:00.000Z");
  });

  it("proposes removal of a linked event that is absent from a complete read, and never from an incomplete one", async () => {
    await commit(await diffOf(preparedFeed([feedEvent("a"), feedEvent("b", { title: "Other" })])));
    const incomplete = await diffOf(preparedFeed([feedEvent("a")], { transportComplete: false }));
    expect(incomplete.records).toEqual([]);
    const skippedLinked = await diffOf(
      preparedFeed([feedEvent("a")], { skipped: [{ idPrefix: "b", reason: "unreadable event" }] })
    );
    expect(skippedLinked.records).toEqual([]);
    // A link whose UID is now a set-aside series is the series pass's: never read as absent.
    const behindSeries = await diffOf(
      preparedFeed([feedEvent("a"), feedEvent("b#20261110", { attributes: { series: {} } })])
    );
    expect(behindSeries.records).toEqual([]);
    const emptyRead = await diffOf(preparedFeed([]));
    expect(emptyRead.records).toEqual([]);
    const nullSeries = await diffOf(
      preparedFeed([feedEvent("a")], { unrepresentableSeries: [{ idPrefix: null, reason: "no uid" }] })
    );
    expect(nullSeries.records).toEqual([]);
    const complete = await diffOf(preparedFeed([feedEvent("a")]));
    expect(complete.records.map((r) => [r.importKey, r.operation])).toEqual([[`${FEED_EVENT_PREFIX}b`, "delete"]]);
  });

  it("leaves a series it cannot read, an unrepresentable series and their instances out of the per-instance diff", async () => {
    const diff = await diffOf(
      preparedFeed(
        [
          feedEvent("plain"),
          feedEvent("weekly#20261110", {
            recurring: true,
            seriesId: "weekly",
            attributes: { series: { freq: "WEEKLY" } }
          }),
          feedEvent("weekly#20261117", { recurring: true, seriesId: "weekly" }),
          feedEvent("odd#20261110", { recurring: true, seriesId: "odd" })
        ],
        { unrepresentableSeries: [{ idPrefix: "odd", reason: "shape unsupported" }] }
      )
    );
    expect(diff.records.map((r) => r.importKey)).toEqual([`${FEED_EVENT_PREFIX}plain`]);
    expect(diff.notImported).toMatchObject({ unrepresentableSeries: 1, seriesPending: 0, unreadable: 1 });
  });

  it("does not propose a declined event again, until it changes", async () => {
    const diff = await diffOf(preparedFeed([feedEvent("a", { title: "Not mine" })]));
    const batch = await store.preview(diff.previewFor(diff.records));
    expect(await store.delete(batch.id, { recordDismissals: true })).toBe(true);
    expect((await diffOf(preparedFeed([feedEvent("a", { title: "Not mine" })]))).records).toEqual([]);
    expect((await diffOf(preparedFeed([feedEvent("a", { title: "Mine now" })]))).records).toHaveLength(1);
  });

  it("starts an all-day event unselected, as a secondary source does", async () => {
    const diff = await diffOf(
      preparedFeed([
        feedEvent("holiday", {
          allDay: true,
          startsAt: "2026-11-09T13:00:00.000Z",
          endsAt: "2026-11-10T13:00:00.000Z",
          timezone: FEED_TIMEZONE
        })
      ])
    );
    expect(diff.records[0]).toMatchObject({ operation: "create", removed: true });
  });
});

describe("a feed event that matches a commitment on the plan", () => {
  it("links the first of two events that match one commitment and offers the other as a plain create; the commit succeeds", async () => {
    const id = await manualCommitment("Team sync", "2026-11-10T01:00:00.000Z", "2026-11-10T02:00:00.000Z");
    const diff = await diffOf(
      preparedFeed([feedEvent("a", { title: "Team sync" }), feedEvent("b", { title: "Team sync" })])
    );
    expect(
      diff.records.map((r) => [r.importKey.slice(FEED_EVENT_PREFIX.length), r.operation, r.matchedEntityId])
    ).toEqual([
      ["a", "link", id],
      ["b", "create", null]
    ]);
    expect(diff.records[1]!.relationships.sourceMatchKind).toBeUndefined();
    await commit(diff);
    expect((await feedLinks()).map((l) => [l.external_event_id, l.commitment_id === id])).toEqual([
      ["a", true],
      ["b", false]
    ]);
    expect(await commitmentTitles()).toEqual(["Team sync", "Team sync"]);
  });

  it("skips a link when the commitment already has a feed link under another id, and leaves no stale key", async () => {
    const id = await manualCommitment("Team sync", "2026-11-10T01:00:00.000Z", "2026-11-10T02:00:00.000Z");
    // The batch for event b is built while the commitment is still free, and committed after a took it.
    const staleB = await diffOf(preparedFeed([feedEvent("b", { title: "Team sync" })]));
    expect(staleB.records[0]).toMatchObject({ operation: "link", matchedEntityId: id });
    await commit(await diffOf(preparedFeed([feedEvent("a", { title: "Team sync" })])));
    const result = await commit(staleB);
    expect(result.batch.status).toBe("committed");
    expect((await feedLinks()).map((l) => l.external_event_id)).toEqual(["a"]);
    const keys = await sql<
      { import_key: string }[]
    >`SELECT import_key FROM import_entity_keys WHERE import_key LIKE 'calendar_feed:event:%' ORDER BY import_key`;
    expect(keys.map((k) => k.import_key)).toEqual([`${FEED_EVENT_PREFIX}a`]);
  });
});

describe("the batch ceilings", () => {
  it("keeps a 3,000-event feed readable: the earliest records, inside both schema limits, a flagged run, no absence deletes", async () => {
    // One linked event that is absent from the big read: with a truncated read it must not be listed for removal.
    await commit(await diffOf(preparedFeed([feedEvent("linked-gone", { title: "Gone" })])));
    const many = Array.from({ length: 3000 }, (_, i) =>
      feedEvent(`bulk-${String(i).padStart(4, "0")}`, {
        title: `Bulk event number ${i} with a reasonably long title`,
        location: "Somewhere with a longer name",
        startsAt: new Date(Date.UTC(2026, 10, 10, 0, i)).toISOString(),
        endsAt: new Date(Date.UTC(2026, 10, 10, 0, i, 30)).toISOString()
      })
    );
    const diff = await diffOf(preparedFeed(many));
    expect(diff.records.length).toBeGreaterThan(0);
    expect(diff.records.length).toBeLessThanOrEqual(FEED_MAX_RECORDS);
    expect(diff.notImported.droppedForSize).toBe(3000 - diff.records.length);
    expect(diff.records.every((r) => r.operation === "create")).toBe(true);
    expect(diff.records[0]!.importKey).toBe(`${FEED_EVENT_PREFIX}bulk-0000`);
    const preview = diff.previewFor(diff.records);
    expect(preview.source.text!.length).toBeLessThanOrEqual(FEED_MAX_SOURCE_CHARS);
    const batch = await store.preview(preview);
    const read = await store.get(batch.id);
    expect(read?.records).toHaveLength(diff.records.length);
  });

  it("refuses nothing at the schema: 2,001 records and a 100,001-character source are never produced", async () => {
    const many = Array.from({ length: 2100 }, (_, i) =>
      feedEvent(`e-${i}`, {
        startsAt: new Date(Date.UTC(2026, 10, 10, 0, i)).toISOString(),
        endsAt: new Date(Date.UTC(2026, 10, 10, 0, i, 30)).toISOString()
      })
    );
    const diff = await diffOf(preparedFeed(many));
    expect(diff.records.length).toBeLessThanOrEqual(FEED_MAX_RECORDS);
    for (const subset of [diff.records, diff.records.slice(0, 5), diff.records.slice(500)])
      expect(diff.previewFor(subset).source.text!.length).toBeLessThanOrEqual(100_000);
  });
});

describe("registration", () => {
  it("is registered as a core import extension for the feed's source type", () => {
    expect(importExtensions().find((e) => e.id === "calendar_feed")?.sourceTypes).toEqual(["calendar_feed"]);
  });
});
