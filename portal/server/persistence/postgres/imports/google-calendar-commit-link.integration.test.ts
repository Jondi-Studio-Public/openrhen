import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { acceptRecordCancel } from "@/features/imports/import-batch-edits";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import type { GoogleCalendarEvent } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { NormalizedPostgresStateStore } from "../state-store";
import { createSeedState } from "@/state/portal-state";
import { PostgresImportStore } from "../import-store";
import { ensureUser } from "../ensure-user";
import { toCalendarEvent } from "./calendar-profiles/google-event-fixtures";
import { listGoogleCalendarSelections, saveGoogleCalendarSelections } from "../calendar-source-selections";

/**
 * The Google Calendar twin of `example_daily-commit-link.integration.test.ts`: committing a Google-sourced batch
 * writes a `calendar_event_links` row with `provider='google_calendar'` and the calendar id as `frame_id`,
 * a second preview of the same window proposes nothing, and what a person rejects is remembered in
 * `calendar_event_dismissals` on commit or discard (but not when the sync merely replaces a stale batch).
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_google_calendar_link");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let store: NormalizedPostgresStateStore;
let importStore: PostgresImportStore;

function previewGoogle(
  args: Omit<Parameters<PostgresImportStore["previewGoogleCalendar"]>[0], "events"> & { events: GoogleCalendarEvent[] }
) {
  return importStore.previewGoogleCalendar({ ...args, events: args.events.map(toCalendarEvent) });
}

const CAL = "jon@example.com";
const window = {
  timezone: "Australia/Sydney",
  timeMin: "2026-10-01T00:00:00.000Z",
  timeMax: "2026-12-30T00:00:00.000Z"
};
const calendars = [{ calendarId: CAL, summary: "Jon" }];

function event(overrides: Partial<GoogleCalendarEvent> & { externalEventId: string }): GoogleCalendarEvent {
  return {
    calendarId: CAL,
    title: "Dentist",
    description: null,
    startsAt: "2026-10-10T09:00:00.000Z",
    endsAt: "2026-10-10T10:00:00.000Z",
    allDay: false,
    timezone: "Australia/Sydney",
    location: null,
    status: "confirmed",
    seriesId: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists
    `;
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
  store = new NormalizedPostgresStateStore(sql);
  importStore = new PostgresImportStore(sql);
}, 30_000);

beforeEach(async () => {
  // This suite is allowed to clear only a database whose validated name ends in _test.
  await sql.unsafe("TRUNCATE TABLE users, portal_state, jobs RESTART IDENTITY CASCADE");
  await store.put(createSeedState(new Date()));
});

afterAll(async () => {
  await sql?.end();
});

describe("Google Calendar commit-and-link", () => {
  it("commits an event as a fixed commitment with a link and a source, then proposes nothing on the same window", async () => {
    const e = event({
      externalEventId: "abc123",
      startsAt: "2026-10-10T19:00:00.000+10:00",
      endsAt: "2026-10-10T20:00:00.000+10:00"
    });
    const batch = await previewGoogle({ ...window, events: [e], calendars });
    expect(batch!.records[0]).toMatchObject({
      importKey: "google_calendar:event:jon@example.com:abc123",
      operation: "create"
    });
    await importStore.commit(batch!.id, batch!.version);

    const commitments = await sql<
      { id: string; title: string }[]
    >`SELECT id, title FROM commitments WHERE title='Dentist'`;
    expect(commitments).toHaveLength(1);
    const links = await sql<
      { provider: string; frame_id: string; external_event_id: string; profile_label: string; commitment_id: string }[]
    >`SELECT provider, frame_id, external_event_id, profile_label, commitment_id FROM calendar_event_links WHERE commitment_id=${commitments[0]!.id}`;
    expect(links).toEqual([
      {
        provider: "google_calendar",
        frame_id: CAL,
        external_event_id: "abc123",
        profile_label: "Jon",
        commitment_id: commitments[0]!.id
      }
    ]);
    const sources = await sql<
      { source_type: string; external_id: string }[]
    >`SELECT source_type, external_id FROM sources WHERE source_type='google_calendar_event'`;
    expect(sources).toEqual([{ source_type: "google_calendar_event", external_id: "jon@example.com:abc123" }]);

    // Proof that `last_remote_snapshot` was written in the shape the diff compares against.
    expect(await previewGoogle({ ...window, events: [e], calendars })).toBeNull();
  });

  it("previews a later change to the linked event as an update, and a cancellation as a delete that cancels the commitment", async () => {
    const e = event({ externalEventId: "abc123" });
    const created = await previewGoogle({ ...window, events: [e], calendars });
    await importStore.commit(created!.id, created!.version);
    const [link] = await sql<
      { commitment_id: string }[]
    >`SELECT commitment_id FROM calendar_event_links WHERE provider='google_calendar' AND external_event_id='abc123'`;
    const commitmentId = link!.commitment_id;

    const moved = await previewGoogle({
      ...window,
      events: [{ ...e, title: "Dentist (moved)" }],
      calendars
    });
    expect(moved!.records[0]).toMatchObject({ operation: "update" });
    await importStore.commit(moved!.id, moved!.version);
    const [row] = await sql<{ title: string }[]>`SELECT title FROM commitments WHERE id=${commitmentId}`;
    expect(row!.title).toBe("Dentist (moved)");
    // Committing the update rewrote the link's snapshot: the same remote event proposes nothing again.
    expect(await previewGoogle({ ...window, events: [{ ...e, title: "Dentist (moved)" }], calendars })).toBeNull();

    const cancelled = await previewGoogle({
      ...window,
      events: [{ ...e, title: "Dentist (moved)", status: "cancelled" }],
      calendars
    });
    expect(cancelled!.records[0]).toMatchObject({ operation: "delete" });
    await importStore.commit(cancelled!.id, cancelled!.version);
    // The source cancelled it, so the commitment is cancelled (restorable), not deleted; its link stays.
    expect(
      await sql`SELECT 1 FROM commitments WHERE id=${commitmentId} AND status='cancelled' AND closed_by='system' AND closed_reason LIKE 'Removed at source: %'`
    ).toHaveLength(1);
    expect(await sql`SELECT 1 FROM calendar_event_links WHERE provider='google_calendar'`).toHaveLength(1);
  });

  it("keeps a two-sided Google change as a blocking conflict through validation", async () => {
    const e = event({ externalEventId: "abc123" });
    const created = await previewGoogle({ ...window, events: [e], calendars });
    await importStore.commit(created!.id, created!.version);
    await sql`UPDATE commitments SET title='Dentist (my edit)', version=version+1 WHERE title='Dentist'`;
    const both = await previewGoogle({
      ...window,
      events: [{ ...e, title: "Dentist (Google edit)" }],
      calendars
    });
    expect(both!.records[0]).toMatchObject({ operation: "conflict" });
    expect(both!.records[0]!.errors[0]).toContain("changed in both Google Calendar and OpenRhen");
    await expect(importStore.commit(both!.id, both!.version)).rejects.toThrow(/blocking/);
  });

  it("previews a cancellation or a missing event as a conflict, not a delete, once the commitment was edited here", async () => {
    const e = event({ externalEventId: "abc123" });
    const created = await previewGoogle({ ...window, events: [e], calendars });
    await importStore.commit(created!.id, created!.version);

    // Untouched: a cancellation is a plain delete carrying the cancelled marker; a missing event is a plain delete without it.
    const cancelled = await previewGoogle({
      ...window,
      events: [{ ...e, status: "cancelled" }],
      calendars
    });
    expect(cancelled!.records[0]).toMatchObject({ operation: "delete", relationships: { remoteCancelled: "true" } });
    const missing = await previewGoogle({ ...window, events: [], calendars });
    expect(missing!.records[0]!.operation).toBe("delete");
    expect(missing!.records[0]!.relationships.remoteCancelled).toBeUndefined();

    // the owner retitles it here: both become conflicts, which block a commit instead of removing his edit.
    await sql`UPDATE commitments SET title='Dentist (my edit)', version=version+1 WHERE title='Dentist'`;
    const cancelledAfterEdit = await previewGoogle({
      ...window,
      events: [{ ...e, status: "cancelled" }],
      calendars
    });
    expect(cancelledAfterEdit!.records[0]).toMatchObject({ operation: "conflict" });
    expect(cancelledAfterEdit!.records[0]!.errors[0]).toContain("title changed in OpenRhen since");
    await expect(importStore.commit(cancelledAfterEdit!.id, cancelledAfterEdit!.version)).rejects.toThrow(/blocking/);
    expect(await sql`SELECT 1 FROM commitments WHERE title='Dentist (my edit)'`).toHaveLength(1);
  });

  it("cancels a held Google cancel of an edited commitment once the owner chooses Cancel anyway", async () => {
    const e = event({ externalEventId: "abc123" });
    const created = await previewGoogle({ ...window, events: [e], calendars });
    await importStore.commit(created!.id, created!.version);
    await sql`UPDATE commitments SET title='Dentist (my edit)' WHERE title='Dentist'`;

    const held = await previewGoogle({
      ...window,
      events: [{ ...e, status: "cancelled" }],
      calendars
    });
    const released = acceptRecordCancel(held!, held!.records[0]!.id);
    const saved = await importStore.update(held!.id, held!.version, released.records);
    expect(saved.records[0]).toMatchObject({ operation: "delete", errors: [] });
    await importStore.commit(saved.id, saved.version);
    expect(await sql`SELECT 1 FROM commitments WHERE title='Dentist (my edit)' AND status='cancelled'`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM calendar_event_links WHERE provider='google_calendar'`).toHaveLength(1);
  });

  it("drops the link when the owner keeps an edited commitment Google cancelled, so it is not asked again", async () => {
    const e = event({ externalEventId: "abc123" });
    const created = await previewGoogle({ ...window, events: [e], calendars });
    await importStore.commit(created!.id, created!.version);
    await sql`UPDATE commitments SET title='Dentist (my edit)' WHERE title='Dentist'`;

    const other = event({
      externalEventId: "new1",
      title: "Physio",
      startsAt: "2026-10-12T09:00:00.000Z",
      endsAt: "2026-10-12T10:00:00.000Z"
    });
    const cancelledEvents = [{ ...e, status: "cancelled" as const }, other];
    const held = await previewGoogle({ ...window, events: cancelledEvents, calendars });
    // Keep it: the held delete is unticked, while the new event is imported in the same commit.
    const records = held!.records.map((record) => ({ ...record, removed: record.operation !== "create" }));
    const saved = await importStore.update(held!.id, held!.version, records);
    await importStore.commit(saved.id, saved.version);

    expect(await sql`SELECT 1 FROM commitments WHERE title='Dentist (my edit)'`).toHaveLength(1);
    expect(
      await sql`SELECT 1 FROM calendar_event_links WHERE provider='google_calendar' AND external_event_id='abc123'`
    ).toHaveLength(0);
    expect(await previewGoogle({ ...window, events: cancelledEvents, calendars })).toBeNull();
  });

  it("drops the link of every held delete when the owner discards the batch", async () => {
    const e = event({ externalEventId: "abc123" });
    const created = await previewGoogle({ ...window, events: [e], calendars });
    await importStore.commit(created!.id, created!.version);
    await sql`UPDATE commitments SET title='Dentist (my edit)' WHERE title='Dentist'`;

    const cancelled = [{ ...e, status: "cancelled" as const }];
    const held = await previewGoogle({ ...window, events: cancelled, calendars });
    await importStore.delete(held!.id, { recordDismissals: true });

    expect(await sql`SELECT 1 FROM commitments WHERE title='Dentist (my edit)'`).toHaveLength(1);
    expect(await previewGoogle({ ...window, events: cancelled, calendars })).toBeNull();
  });

  it("keeps the link when the owner declines deleting a missing event, and updates it when it comes back", async () => {
    const e = event({ externalEventId: "abc123" });
    const created = await previewGoogle({ ...window, events: [e], calendars });
    await importStore.commit(created!.id, created!.version);

    const other = event({
      externalEventId: "new1",
      title: "Physio",
      startsAt: "2026-10-12T09:00:00.000Z",
      endsAt: "2026-10-12T10:00:00.000Z"
    });
    const held = await previewGoogle({ ...window, events: [other], calendars });
    expect(held!.records.find((record) => record.operation === "delete")).toBeTruthy();
    const records = held!.records.map((record) => ({ ...record, removed: record.operation === "delete" }));
    const saved = await importStore.update(held!.id, held!.version, records);
    await importStore.commit(saved.id, saved.version);

    expect(await sql`SELECT 1 FROM calendar_event_links WHERE external_event_id='abc123'`).toHaveLength(1);
    // Still missing: not asked again.
    expect(await previewGoogle({ ...window, events: [other], calendars })).toBeNull();
    // Back, and moved: an update of the same commitment, never a second commitment.
    const back = await previewGoogle({
      ...window,
      events: [other, { ...e, title: "Dentist (moved)" }],
      calendars
    });
    expect(back!.records.map((record) => record.operation)).toEqual(["update"]);
  });

  it("proposes no creates after a discarded guard batch once the whole calendar reads back", async () => {
    const events = Array.from({ length: 11 }, (_, index) =>
      event({
        externalEventId: `bulk${index}`,
        title: `Bulk ${index}`,
        startsAt: `2026-10-${String(index + 10).padStart(2, "0")}T09:00:00.000Z`,
        endsAt: `2026-10-${String(index + 10).padStart(2, "0")}T10:00:00.000Z`
      })
    );
    const created = await previewGoogle({ ...window, events, calendars });
    await importStore.commit(created!.id, created!.version);

    // A glitchy read returns nothing: eleven deletes, which the owner throws away.
    const glitch = await previewGoogle({ ...window, events: [], calendars });
    expect(glitch!.records.filter((record) => record.operation === "delete")).toHaveLength(11);
    await importStore.delete(glitch!.id, { recordDismissals: true });

    expect(await sql`SELECT 1 FROM calendar_event_links WHERE provider='google_calendar'`).toHaveLength(11);
    expect(await previewGoogle({ ...window, events, calendars })).toBeNull();
  });

  it("remembers an event left unselected on commit, and proposes it again only once it changes", async () => {
    const keep = event({ externalEventId: "keep" });
    const skip = event({
      externalEventId: "skip",
      title: "Skip me",
      startsAt: "2026-10-11T09:00:00.000Z",
      endsAt: "2026-10-11T10:00:00.000Z"
    });
    const batch = await previewGoogle({ ...window, events: [keep, skip], calendars });
    const records = batch!.records.map((record) => ({ ...record, removed: record.importKey.endsWith(":skip") }));
    const updated = await importStore.update(batch!.id, batch!.version, records);
    await importStore.commit(updated.id, updated.version);

    const dismissals = await sql<
      { provider: string; external_event_id: string; title: string }[]
    >`SELECT provider, external_event_id, title FROM calendar_event_dismissals`;
    expect(dismissals).toEqual([
      { provider: "google_calendar", external_event_id: "jon@example.com:skip", title: "Skip me" }
    ]);

    expect(await previewGoogle({ ...window, events: [keep, skip], calendars })).toBeNull();
    const renamed = await previewGoogle({
      ...window,
      events: [keep, { ...skip, title: "Skip me (renamed)" }],
      calendars
    });
    expect(renamed!.records).toHaveLength(1);
    expect(renamed!.records[0]!.importKey).toBe("google_calendar:event:jon@example.com:skip");
  });

  it("remembers every event of a discarded batch, but not those of a batch the sync replaced", async () => {
    const a = event({ externalEventId: "a" });
    const b = event({ externalEventId: "b", startsAt: "2026-10-12T09:00:00.000Z", endsAt: "2026-10-12T10:00:00.000Z" });
    const first = await previewGoogle({ ...window, events: [a], calendars });
    const second = await previewGoogle({ ...window, events: [a, b], calendars });
    // The sync supersedes the first batch: not a decision about its events.
    await importStore.supersedeOpenBatches("google_calendar", second!.id);
    expect(await sql`SELECT 1 FROM import_batches WHERE id=${first!.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM calendar_event_dismissals`).toHaveLength(0);
    // The person discarding the second declines both events.
    await importStore.delete(second!.id, { recordDismissals: true });
    const dismissals = await sql<
      { external_event_id: string }[]
    >`SELECT external_event_id FROM calendar_event_dismissals ORDER BY external_event_id`;
    expect(dismissals.map((row) => row.external_event_id)).toEqual(["jon@example.com:a", "jon@example.com:b"]);
  });

  it("reports which commitments another source also feeds", async () => {
    const e = event({ externalEventId: "abc123" });
    const created = await previewGoogle({ ...window, events: [e], calendars });
    await importStore.commit(created!.id, created!.version);
    const [commitment] = await sql<
      { id: string }[]
    >`SELECT commitment_id AS id FROM calendar_event_links WHERE provider='google_calendar' AND external_event_id='abc123'`;
    expect(
      await importStore.commitmentsFedByOtherSources([commitment!.id], "google_calendar", "google_calendar_event")
    ).toEqual(new Set());
    // One link per commitment is enforced today, so another provider's link cannot yet be inserted;
    // the other route the check covers is a commitment whose source is not Google's own.
    const userId = await ensureUser(sql);
    const [other] = await sql<
      { id: string }[]
    >`INSERT INTO sources(user_id,source_type,external_id,title,captured_text,content_hash) VALUES(${userId},'example_daily_event','s1','Work','{}','h') RETURNING id`;
    await sql`UPDATE commitments SET source_id=${other!.id} WHERE id=${commitment!.id}`;
    const fed = await importStore.commitmentsFedByOtherSources(
      [commitment!.id],
      "google_calendar",
      "google_calendar_event"
    );
    expect(fed.has(commitment!.id)).toBe(true);
  });
});

describe("calendar_source_selections", () => {
  it("saves and lists the chosen calendars, updating rather than duplicating", async () => {
    expect(await listGoogleCalendarSelections(sql as never)).toEqual([]);
    await saveGoogleCalendarSelections(sql as never, [
      { calendarId: CAL, summary: "Jon", selected: true },
      { calendarId: "holidays@group.v.calendar.google.com", summary: "Holidays", selected: false }
    ]);
    const saved = await saveGoogleCalendarSelections(sql as never, [
      { calendarId: CAL, summary: "Jon (renamed)", selected: false }
    ]);
    expect(saved).toEqual([
      { calendarId: "holidays@group.v.calendar.google.com", summary: "Holidays", selected: false },
      { calendarId: CAL, summary: "Jon (renamed)", selected: false }
    ]);
    expect(await sql`SELECT 1 FROM calendar_source_selections`).toHaveLength(2);
  });
});
