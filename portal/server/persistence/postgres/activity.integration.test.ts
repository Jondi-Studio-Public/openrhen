import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import {
  ActivityInputError,
  deleteActivityImport,
  findActivityImport,
  ingestActivityEvents,
  purgeActivitySource,
  purgeExpiredActivity,
  readActivityEvents,
  readActivitySummary,
  setActivitySourceSettings
} from "./activity-store";
import { ensureUser } from "./ensure-user";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_activity");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const now = new Date("2026-11-07T12:00:00.000Z");
const event = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  source: "rhen-watch",
  kind: "foreground",
  start: "2026-11-07T10:00:00.250Z",
  end: "2026-11-07T10:05:00.000Z",
  attrs: { exe: "chrome.exe" },
  ...extra
});
const ingest = (events: unknown[], extra: Record<string, unknown> = {}, via: string | null = "agent-a") =>
  ingestActivityEvents(sql, { events, ...extra }, via, now);
const count = async (table = "activity_events") =>
  (await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n;
const sha = (c: string) => c.repeat(64);

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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

describe("ingesting events", () => {
  it("stores events with every column, and records who posted them", async () => {
    const result = await ingest([
      event("a", { start: "2026-11-07T21:00:00+11:00", end: null, tzOffsetMin: undefined, approximate: true })
    ]);
    expect(result).toMatchObject({ added: 1, alreadyHeld: 0, rejected: [], ingestedVia: "agent-a", importId: null });
    const [row] = await sql<Record<string, unknown>[]>`SELECT * FROM activity_events`;
    expect(row).toMatchObject({
      source: "rhen-watch",
      kind: "foreground",
      event_key: "a",
      tz_offset_min: 660,
      approximate: true,
      attrs: { exe: "chrome.exe" },
      content: null,
      ingested_via: "agent-a",
      ts_end: null
    });
    expect((row!.ts_start as Date).toISOString()).toBe("2026-11-07T10:00:00.000Z");
  });

  it("is idempotent: a repeat is alreadyHeld and changes nothing", async () => {
    await ingest([event("a"), event("b")]);
    const again = await ingest([event("a", { attrs: { exe: "other.exe" } }), event("c")]);
    expect(again).toMatchObject({ added: 1, alreadyHeld: 1 });
    expect(await count()).toBe(3);
    const [a] = await sql<{ attrs: unknown }[]>`SELECT attrs FROM activity_events WHERE event_key = 'a'`;
    expect(a!.attrs).toEqual({ exe: "chrome.exe" });
  });

  it("counts a duplicate key inside one batch as alreadyHeld, once stored", async () => {
    const result = await ingest([event("a"), event("a"), event("a")]);
    expect(result).toMatchObject({ added: 1, alreadyHeld: 2 });
    expect(await count()).toBe(1);
  });

  it("keeps the same key for different sources distinct", async () => {
    await ingest([event("a"), event("a", { source: "spotify", kind: "play" })]);
    expect(await count()).toBe(2);
  });

  it("rejects a bad event by itself and stores the rest", async () => {
    const result = await ingest([
      event("a"),
      event("b", { source: "nope" }),
      event("c", { end: "2020-01-01T00:00:00Z" })
    ]);
    expect(result.added).toBe(1);
    expect(result.rejected.map((r) => r.index)).toEqual([1, 2]);
    expect(result.rejected[0]!.reason).toMatch(/Use one of/);
    expect(await count()).toBe(1);
  });

  it("drops content for a source whose gate is off, and counts it", async () => {
    const result = await ingest([event("a", { source: "discord-package", kind: "message", content: "hi there" })]);
    expect(result).toMatchObject({ added: 1, contentDropped: 1 });
    expect((await sql<{ content: string | null }[]>`SELECT content FROM activity_events`)[0]!.content).toBeNull();
  });

  it("keeps content once the owner turns the gate on for that source only", async () => {
    await setActivitySourceSettings(sql, "discord-package", { contentEnabled: true });
    const result = await ingest([
      event("a", { source: "discord-package", kind: "message", content: "hi there" }),
      event("b", { source: "spotify", kind: "play", content: "track name" })
    ]);
    expect(result).toMatchObject({ added: 2, contentDropped: 1 });
    const rows = await sql<
      { source: string; content: string | null }[]
    >`SELECT source, content FROM activity_events ORDER BY source`;
    expect(rows).toEqual([
      { source: "discord-package", content: "hi there" },
      { source: "spotify", content: null }
    ]);
  });

  it("stores a full 1000-event batch", async () => {
    const events = Array.from({ length: 1000 }, (_, i) =>
      event(`k${i}`, { start: new Date(now.getTime() - i * 1000).toISOString(), end: null })
    );
    expect(await ingest(events)).toMatchObject({ added: 1000, alreadyHeld: 0 });
  });
});

describe("append-only", () => {
  it("refuses an UPDATE of any column", async () => {
    await ingest([event("a")]);
    await expect(sql`UPDATE activity_events SET kind = 'idle'`).rejects.toThrow(/append-only/);
    await expect(sql`UPDATE activity_events SET content = 'x'`).rejects.toThrow(/append-only/);
    expect((await sql<{ kind: string }[]>`SELECT kind FROM activity_events`)[0]!.kind).toBe("foreground");
  });

  it("still allows DELETE, TRUNCATE and the user cascade (restore and undo need them)", async () => {
    await ingest([event("a"), event("b")]);
    await sql`DELETE FROM activity_events WHERE event_key = 'a'`;
    expect(await count()).toBe(1);
    await sql.unsafe("TRUNCATE TABLE activity_events, derived_lineage");
    expect(await count()).toBe(0);
    await ingest([event("c")]);
    await sql`DELETE FROM users WHERE id = ${userId}`;
    expect(await count()).toBe(0);
  });

  it("refuses an end before the start at the database too", async () => {
    await expect(
      sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, ts_end)
          VALUES (${userId}, 'rhen-watch', 'idle', 'z', '2026-11-07T10:00:00Z', '2026-11-07T09:00:00Z')`
    ).rejects.toThrow(/time_order/);
  });
});

describe("content from an explicit file import", () => {
  const stored = async () =>
    await sql<
      { event_key: string; content: string | null }[]
    >`SELECT event_key, content FROM activity_events ORDER BY event_key`;

  it("is kept with the gate off, on the first batch and on a later one joined by importId", async () => {
    const first = await ingest([event("a", { source: "discord-package", kind: "message", content: "hello" })], {
      import: { sha256: sha("e"), filename: "messages.json" }
    });
    expect(first).toMatchObject({ added: 1, contentDropped: 0 });
    const later = await ingest([event("b", { source: "discord-package", kind: "message", content: "again" })], {
      importId: first.importId!
    });
    expect(later).toMatchObject({ added: 1, contentDropped: 0 });
    expect(await stored()).toEqual([
      { event_key: "a", content: "hello" },
      { event_key: "b", content: "again" }
    ]);
    expect((await readActivitySummary(sql)).sources.find((x) => x.source === "discord-package")!.contentEnabled).toBe(
      false
    );
  });

  it("is dropped, and counted, for the same source arriving without an import", async () => {
    const result = await ingest([event("a", { source: "discord-package", kind: "message", content: "hello" })]);
    expect(result).toMatchObject({ added: 1, contentDropped: 1 });
    expect(await stored()).toEqual([{ event_key: "a", content: null }]);
  });

  it("is kept for an import even when the owner has turned the gate off explicitly", async () => {
    await setActivitySourceSettings(sql, "discord-package", { contentEnabled: false });
    const result = await ingest([event("a", { source: "discord-package", kind: "message", content: "hello" })], {
      import: { sha256: sha("f"), filename: "m.json" }
    });
    expect(result.contentDropped).toBe(0);
    expect(await stored()).toEqual([{ event_key: "a", content: "hello" }]);
  });
});

describe("OPENRHEN_ACTIVITY_CONTENT_DEFAULT", () => {
  const original = process.env.OPENRHEN_ACTIVITY_CONTENT_DEFAULT;
  afterEach(() => {
    if (original === undefined) delete process.env.OPENRHEN_ACTIVITY_CONTENT_DEFAULT;
    else process.env.OPENRHEN_ACTIVITY_CONTENT_DEFAULT = original;
  });
  const post = () => ingest([event("a", { content: "window title" })]);
  const content = async () =>
    (await sql<{ content: string | null }[]>`SELECT content FROM activity_events`)[0]!.content;

  it("off (and unset) drops content for a source with no saved setting", async () => {
    delete process.env.OPENRHEN_ACTIVITY_CONTENT_DEFAULT;
    expect(await post()).toMatchObject({ contentDropped: 1 });
    expect(await content()).toBeNull();
  });

  it("on keeps content for a source with no saved setting, and the summary shows it", async () => {
    process.env.OPENRHEN_ACTIVITY_CONTENT_DEFAULT = "on";
    expect(await post()).toMatchObject({ contentDropped: 0 });
    expect(await content()).toBe("window title");
    expect((await readActivitySummary(sql)).sources.find((x) => x.source === "rhen-watch")!.contentEnabled).toBe(true);
  });

  it("a saved setting wins in both directions", async () => {
    process.env.OPENRHEN_ACTIVITY_CONTENT_DEFAULT = "on";
    await setActivitySourceSettings(sql, "rhen-watch", { contentEnabled: false });
    expect(await post()).toMatchObject({ contentDropped: 1 });
    await sql`TRUNCATE TABLE activity_events, derived_lineage`;
    process.env.OPENRHEN_ACTIVITY_CONTENT_DEFAULT = "off";
    await setActivitySourceSettings(sql, "rhen-watch", { contentEnabled: true });
    expect(await post()).toMatchObject({ contentDropped: 0 });
  });

  it("saving only retention under default on records the effective setting, so nothing flips", async () => {
    process.env.OPENRHEN_ACTIVITY_CONTENT_DEFAULT = "on";
    await setActivitySourceSettings(sql, "rhen-watch", { retentionDays: 30 });
    expect(await post()).toMatchObject({ contentDropped: 0 });
  });
});

describe("imports", () => {
  it("creates the record on the first batch, joins it by importId, and reports the file as held", async () => {
    const first = await ingest([event("a", { source: "chrome-takeout", kind: "visit" })], {
      import: { sha256: sha("a"), filename: "BrowserHistory.json" }
    });
    expect(first.importId).toBeTruthy();
    expect(await findActivityImport(sql, sha("a"))).toMatchObject({
      held: true,
      importId: first.importId,
      eventCount: 1
    });
    expect(await findActivityImport(sql, sha("b"))).toEqual({ held: false });
    const second = await ingest([event("b", { source: "chrome-takeout", kind: "visit" })], {
      importId: first.importId
    });
    expect(second).toMatchObject({ added: 1, importId: first.importId });
    expect(await findActivityImport(sql, sha("a"))).toMatchObject({ eventCount: 2 });
    expect(
      (await sql<{ import_id: string }[]>`SELECT import_id FROM activity_events`).every(
        (r) => r.import_id === first.importId
      )
    ).toBe(true);
  });

  it("resolves two concurrent first batches of one file to a single import record", async () => {
    const batch = (id: string) =>
      ingest([event(id, { source: "chrome-takeout", kind: "visit" })], {
        import: { sha256: sha("c"), filename: "x.json" }
      });
    const [one, two] = await Promise.all([batch("a"), batch("b")]);
    expect(one.importId).toBe(two.importId);
    expect(await count("activity_imports")).toBe(1);
    expect(await findActivityImport(sql, sha("c"))).toMatchObject({ eventCount: 2 });
  });

  it("re-posting a whole file adds nothing and does not claim the earlier events", async () => {
    const events = [event("a", { source: "chrome-takeout", kind: "visit" })];
    const first = await ingest(events, { import: { sha256: sha("d"), filename: "x.json" } });
    const again = await ingest(events, { import: { sha256: sha("d"), filename: "x.json" } });
    expect(again).toMatchObject({ added: 0, alreadyHeld: 1, importId: first.importId });
    expect(await count("activity_imports")).toBe(1);
  });

  it("refuses an importId the person does not hold, saying how to start one", async () => {
    await expect(ingest([event("a")], { importId: "6f1d0a4e-8c3b-4f7a-9d2e-1b5c7a9e3f10" })).rejects.toThrow(
      /first batch/
    );
    await expect(
      ingest([event("a")], { import: { sha256: sha("e"), filename: "x", source: "myspace" } })
    ).rejects.toBeInstanceOf(ActivityInputError);
    expect(await count()).toBe(0);
    expect(await count("activity_imports")).toBe(0);
  });

  it("undoes an import: its events and its record, and nothing else", async () => {
    const first = await ingest([event("a", { source: "chrome-takeout", kind: "visit" })], {
      import: { sha256: sha("f"), filename: "x.json" }
    });
    await ingest([event("keep")]);
    expect(await deleteActivityImport(sql, first.importId!)).toEqual({ deleted: true, removed: 1 });
    expect(await count()).toBe(1);
    expect(await count("activity_imports")).toBe(0);
    expect(await findActivityImport(sql, sha("f"))).toEqual({ held: false });
    expect(await deleteActivityImport(sql, first.importId!)).toEqual({ deleted: false, removed: 0 });
  });
});

describe("import batches are one source", () => {
  const visit = (id: string, extra: Record<string, unknown> = {}) =>
    event(id, { source: "chrome-takeout", kind: "visit", ...extra });

  it("rejects an event from another source in a first batch, so undoing or purging cannot reach it", async () => {
    const result = await ingest([visit("a"), event("b"), visit("c")], {
      import: { sha256: sha("1"), filename: "x.json" }
    });
    expect(result).toMatchObject({ added: 2 });
    expect(result.rejected).toEqual([
      {
        index: 1,
        reason: 'source "rhen-watch" does not match this import\'s source "chrome-takeout". Send one import per source.'
      }
    ]);
    expect((await sql<{ source: string }[]>`SELECT DISTINCT source FROM activity_events`).map((r) => r.source)).toEqual(
      ["chrome-takeout"]
    );
  });

  it("holds later batches to the import's source too", async () => {
    const first = await ingest([visit("a")], { import: { sha256: sha("2"), filename: "x.json" } });
    const second = await ingest([visit("b"), event("c")], { importId: first.importId! });
    expect(second).toMatchObject({ added: 1 });
    expect(second.rejected.map((r) => r.index)).toEqual([1]);
  });

  it("takes the source from import.source when given, and asks for it when every event was rejected", async () => {
    const named = await ingest([visit("a")], {
      import: { sha256: sha("3"), filename: "x.json", source: "chrome-takeout" }
    });
    expect(named.added).toBe(1);
    await expect(
      ingest([event("z", { source: "nope" })], { import: { sha256: sha("4"), filename: "x.json" } })
    ).rejects.toThrow(/import\.source is needed because every event in this batch was rejected/);
    expect(await count("activity_imports")).toBe(1);
  });
});

describe("text and times Postgres would refuse", () => {
  it("rejects those events alone and stores the rest of the batch", async () => {
    const result = await ingest([
      event("ok"),
      event("nul", { content: "a\u0000b" }),
      event("lone", { attrs: { x: "a\ud800b" } }),
      event("offset", { start: "2026-11-07T10:00:00+99:99", end: null }),
      event("a\u0000b")
    ]);
    expect(result.added).toBe(1);
    expect(result.rejected.map((r) => r.index)).toEqual([1, 2, 3, 4]);
    expect(await count()).toBe(1);
  });
});

describe("purging", () => {
  it("purges one source's events and import records, leaving other sources", async () => {
    await ingest([event("a", { source: "spotify", kind: "play" })], {
      import: { sha256: sha("1"), filename: "s.json" }
    });
    await ingest([event("b")]);
    expect(await purgeActivitySource(sql, "spotify")).toEqual({ removed: 1 });
    expect(await count()).toBe(1);
    expect(await count("activity_imports")).toBe(0);
    await expect(purgeActivitySource(sql, "myspace")).rejects.toBeInstanceOf(ActivityInputError);
  });

  it("deletes in batches of 5000 when more than one batch is held", async () => {
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start)
              SELECT ${userId}, 'weather', 'observation', 'k' || g, '2026-01-01T00:00:00Z'::timestamptz + g * interval '1 second'
              FROM generate_series(1, 12000) g`;
    expect(await purgeActivitySource(sql, "weather")).toEqual({ removed: 12000 });
    expect(await count()).toBe(0);
  });

  it("applies retention per source by end time (start for an instant), and keeps unset sources forever", async () => {
    await ingest([
      event("old-interval", { start: "2026-09-01T00:00:00Z", end: "2026-10-31T00:00:00Z" }),
      event("old-instant", { start: "2026-09-01T00:00:00Z", end: null }),
      event("recent", { start: "2026-11-05T00:00:00Z", end: null }),
      event("spotify-old", { source: "spotify", kind: "play", start: "2020-01-01T00:00:00Z", end: null })
    ]);
    await setActivitySourceSettings(sql, "rhen-watch", { retentionDays: 30 });
    const purged = await purgeExpiredActivity(sql, now);
    expect(purged).toEqual([{ source: "rhen-watch", removed: 1 }]);
    const keys = (await sql<{ event_key: string }[]>`SELECT event_key FROM activity_events ORDER BY event_key`).map(
      (r) => r.event_key
    );
    // old-interval ended 7 days before now so it stays; old-instant is past the cutoff.
    expect(keys).toEqual(["old-interval", "recent", "spotify-old"]);
  });

  it("keeps a source with permanent retention and clears the setting with null", async () => {
    await ingest([event("old", { start: "2020-01-01T00:00:00Z", end: null })]);
    await setActivitySourceSettings(sql, "rhen-watch", { retentionDays: 1 });
    await setActivitySourceSettings(sql, "rhen-watch", { retentionDays: null });
    expect(await purgeExpiredActivity(sql, now)).toEqual([]);
    expect(await count()).toBe(1);
  });
});

describe("settings, summary and reads", () => {
  it("merges settings: a field left out keeps its value, and an unknown source is refused", async () => {
    await setActivitySourceSettings(sql, "spotify", { contentEnabled: true });
    expect(await setActivitySourceSettings(sql, "spotify", { retentionDays: 90 })).toMatchObject({
      source: "spotify",
      contentEnabled: true,
      retentionDays: 90,
      retentionRuns: true,
      note: expect.stringMatching(/deleted automatically.*derived/s)
    });
    expect(await setActivitySourceSettings(sql, "spotify", { retentionDays: null })).toMatchObject({
      retentionRuns: false,
      note: null
    });
    await expect(setActivitySourceSettings(sql, "myspace", {})).rejects.toBeInstanceOf(ActivityInputError);
  });

  it("summarises every registered source with counts, the last event and the settings", async () => {
    await ingest([event("a", { end: null }), event("b", { start: "2026-11-07T11:00:00Z", end: null })]);
    await setActivitySourceSettings(sql, "rhen-watch", { retentionDays: 10 });
    const summary = await readActivitySummary(sql);
    const watch = summary.sources.find((s) => s.source === "rhen-watch")!;
    expect(watch).toMatchObject({
      events: 2,
      lastEventAt: "2026-11-07T11:00:00.000Z",
      retentionDays: 10,
      contentEnabled: false,
      schemaVersion: 1
    });
    expect(summary.sources.find((s) => s.source === "iphone-health")).toMatchObject({ events: 0, lastEventAt: null });
    // Nothing runs the retention purge yet, and the summary says so wherever a retention is set.
    expect(watch.retentionPurge).toBe("scheduled");
    expect(summary.sources.find((s) => s.source === "spotify")!.retentionPurge).toBe("not_set");
  });

  it("pages events in time order with filters and a cursor", async () => {
    await ingest(
      Array.from({ length: 5 }, (_, i) => event(`k${i}`, { start: `2026-11-07T0${i}:00:00Z`, end: null })).concat([
        event("s", { source: "spotify", kind: "play", start: "2026-11-07T02:30:00Z", end: null })
      ])
    );
    const first = await readActivityEvents(sql, { source: "rhen-watch", limit: 2 });
    expect(first.events.map((e) => e.key)).toEqual(["k0", "k1"]);
    expect(first.next).toBeTruthy();
    const second = await readActivityEvents(sql, { source: "rhen-watch", limit: 2, after: first.next! });
    expect(second.events.map((e) => e.key)).toEqual(["k2", "k3"]);
    const last = await readActivityEvents(sql, { source: "rhen-watch", limit: 2, after: second.next! });
    expect(last.events.map((e) => e.key)).toEqual(["k4"]);
    expect(last.next).toBeNull();
    const ranged = await readActivityEvents(sql, {
      from: new Date("2026-11-07T01:00:00Z"),
      to: new Date("2026-11-07T03:00:00Z")
    });
    expect(ranged.events.map((e) => e.key)).toEqual(["k1", "k2", "s"]);
    expect(ranged.events[0]).toMatchObject({ ingestedVia: "agent-a", content: null, tzOffsetMin: null });
    await expect(readActivityEvents(sql, { after: "garbage" })).rejects.toBeInstanceOf(ActivityInputError);
    // A cursor with a real time but an id that is not a UUID would be a Postgres error, not a 400.
    const badId = Buffer.from("2026-11-07T01:00:00.000Z|not-a-uuid").toString("base64url");
    await expect(readActivityEvents(sql, { after: badId })).rejects.toThrow(/not a cursor this API returned/);
    await expect(readActivityEvents(sql, { after: badId })).rejects.toBeInstanceOf(ActivityInputError);
  });

  it("is isolated per user: another user's events and import records are never seen or deleted", async () => {
    const [other] = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`;
    const [theirImport] = await sql<{ id: string }[]>`
      INSERT INTO activity_imports (user_id, source, filename, sha256) VALUES (${other!.id}, 'spotify', 'x', ${sha("9")}) RETURNING id`;
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, import_id)
              VALUES (${other!.id}, 'spotify', 'play', 'a', '2026-11-07T10:00:00Z', ${theirImport!.id})`;
    await ingest([event("a", { source: "spotify", kind: "play" })]);
    expect((await readActivityEvents(sql, {})).events).toHaveLength(1);
    expect(await findActivityImport(sql, sha("9"))).toEqual({ held: false });
    expect(await deleteActivityImport(sql, theirImport!.id)).toEqual({ deleted: false, removed: 0 });
    await purgeActivitySource(sql, "spotify");
    expect(await sql`SELECT 1 FROM activity_events WHERE user_id = ${other!.id}`).toHaveLength(1);
  });
});

describe("who a derived row is attributed to", () => {
  const derived = (id: string, kind: string, attrs: Record<string, unknown>) => ({
    id,
    source: "derived",
    kind,
    start: "2026-11-07T10:00:00.000Z",
    attrs
  });
  const label = { fact_id: "f".repeat(40), field: "fact_type", answer: "ask" };

  it("records the posting agent as ingested_via, null for the person, and never lets attrs say otherwise", async () => {
    const asMark = await ingest([derived("by-mark", "label", label)], {}, "mark");
    const asPerson = await ingest([derived("by-person", "label", { ...label, answer: "fyi" })], {}, null);
    expect(asMark.added).toBe(1);
    expect(asPerson.added).toBe(1);
    const rows = await sql<{ event_key: string; ingested_via: string | null }[]>`
      SELECT event_key, ingested_via FROM activity_events WHERE source = 'derived' ORDER BY event_key`;
    expect(rows).toEqual([
      { event_key: "by-mark", ingested_via: "mark" },
      { event_key: "by-person", ingested_via: null }
    ]);
    // Only rows with ingested_via IS NULL count as his labels.
    const his =
      await sql`SELECT 1 FROM activity_events WHERE source = 'derived' AND kind = 'label' AND ingested_via IS NULL`;
    expect(his).toHaveLength(1);
  });

  it("stores a derived-shadow row under its own source, attributed to the poster, and refuses a client by there too", async () => {
    const shadow = (id: string, attrs: Record<string, unknown>) => ({
      id,
      source: "derived-shadow",
      kind: "msg_class",
      start: "2026-11-07T10:00:00.000Z",
      attrs: {
        source_event_id: "g1",
        class: "bulk",
        reasons: [],
        extractor: "msg-class-t0",
        extractor_version: "2",
        ...attrs
      }
    });
    expect((await ingest([shadow("sh1", {})], {}, "extractor-agent")).added).toBe(1);
    const refused = await ingest([shadow("sh2", { by: "jondi" })], {}, "extractor-agent");
    expect(refused.rejected[0]!.reason).toContain("attrs.by");
    expect(
      await sql`SELECT ingested_via FROM activity_events WHERE source = 'derived-shadow' AND event_key = 'sh1'`
    ).toEqual([{ ingested_via: "extractor-agent" }]);
    // Nothing but extractor output is stored there, whoever posts it.
    for (const via of ["extractor-agent", "mark", null])
      for (const kind of ["label", "override", "fact_status", "correction"]) {
        const result = await ingest(
          [{ id: `no-${kind}-${via}`, source: "derived-shadow", kind, start: "2026-11-07T10:00:00.000Z", attrs: {} }],
          {},
          via
        );
        expect(result.added, `${kind} by ${via}`).toBe(0);
        expect(result.rejected[0]!.reason).toContain("msg_class, fact");
      }
    // A read that does not name the source never shows it.
    expect((await readActivityEvents(sql, {})).events).toHaveLength(0);
    expect((await readActivityEvents(sql, { source: "derived-shadow" })).events).toHaveLength(1);
  });

  it("refuses a row that claims to be the person through attrs.by, from the person or from an agent", async () => {
    for (const via of ["mark", null]) {
      const result = await ingest([derived(`claims-${via}`, "label", { ...label, by: "jondi" })], {}, via);
      expect(result.added).toBe(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]!.reason).toContain("attrs.by");
    }
    expect(await count()).toBe(0);
  });
});

describe("physiology rows", () => {
  const HOUR = Date.parse("2026-10-10T00:00:00.000Z");
  const hourStart = (n: number) => new Date(HOUR + n * 3_600_000).toISOString();
  /** A heart_rate period row on a 15 s grid with `count` readings and the given version. */
  const heart = (n: number, extra: { v?: number; count?: number; device?: string } = {}) => {
    const v = extra.v ?? 0;
    const count = extra.count ?? 240;
    const device = extra.device ?? "band-1";
    const values: (number | null)[] = Array.from({ length: 240 }, (_, i) => (i < count ? 60 + (i % 20) : null));
    const start = hourStart(n);
    return {
      id: `heart_rate|${device}|${start}|v${v}`,
      source: "physiology",
      kind: "heart_rate",
      start,
      attrs: {
        device,
        route: "app",
        v,
        unit: "bpm",
        step_s: 15,
        values,
        n: count,
        min: 60,
        max: 79,
        avg: 69.5,
        coverage_s: count * 15
      }
    };
  };
  const keysOf = async () =>
    (
      await sql<
        { event_key: string }[]
      >`SELECT event_key FROM activity_events WHERE source = 'physiology' ORDER BY event_key`
    ).map((row) => row.event_key);

  it("stores v0 and then v1 of one period as two rows", async () => {
    expect(await ingest([heart(0, { count: 100 })])).toMatchObject({ added: 1, held: [] });
    expect(await ingest([heart(0, { v: 1, count: 240 })])).toMatchObject({ added: 1, alreadyHeld: 0, held: [] });
    expect(await keysOf()).toEqual([`heart_rate|band-1|${hourStart(0)}|v0`, `heart_rate|band-1|${hourStart(0)}|v1`]);
  });

  it("answers a re-post of a held key with what is held: index, key, v, coverage_s and n", async () => {
    await ingest([heart(0, { count: 100 }), heart(1, { count: 240 })]);
    const result = await ingest([heart(2), heart(1, { count: 50 }), heart(0, { count: 240 })]);
    expect(result).toMatchObject({ added: 1, alreadyHeld: 2 });
    expect(result.held).toEqual([
      { index: 1, key: `heart_rate|band-1|${hourStart(1)}|v0`, v: 0, coverage_s: 3600, n: 240 },
      { index: 2, key: `heart_rate|band-1|${hourStart(0)}|v0`, v: 0, coverage_s: 1500, n: 100 }
    ]);
    // First write wins: the re-post under the same key stored nothing.
    const [first] = await sql<{ attrs: { n: number } }[]>`
      SELECT attrs FROM activity_events WHERE event_key = ${`heart_rate|band-1|${hourStart(0)}|v0`}`;
    expect(first!.attrs.n).toBe(100);
  });

  it("reports held only for physiology, not for another source's repeat", async () => {
    await ingest([event("a")]);
    expect(await ingest([event("a")])).toMatchObject({ alreadyHeld: 1, held: [] });
  });

  it("does not report a repeat inside one batch as held", async () => {
    expect(await ingest([heart(0), heart(0)])).toMatchObject({ added: 1, alreadyHeld: 1, held: [] });
  });

  it("rejects a wrong key with the expected one, and stores nothing", async () => {
    const result = await ingest([{ ...heart(0), id: "wrong" }]);
    expect(result.added).toBe(0);
    expect(result.rejected[0]!.reason).toContain(`send id "heart_rate|band-1|${hourStart(0)}|v0"`);
    expect(await count()).toBe(0);
  });

  it("accepts a batch of about 1.5 MB of worst-case rows inside the request cap", async () => {
    const rows = Array.from({ length: 400 }, (_, n) => {
      const start = hourStart(n);
      return {
        id: `hrv|band-1|${start}|v0`,
        source: "physiology",
        kind: "hrv",
        start,
        attrs: {
          device: "band-1",
          route: "app",
          v: 0,
          collector_version: "1.2.3",
          unit: "ms",
          method: "rmssd",
          step_s: 15,
          values: Array.from({ length: 240 }, (_, i) => 40.5 + (i % 20) / 10),
          flags: Array.from({ length: 240 }, () => null),
          n: 240,
          min: 40.5,
          max: 42.4,
          avg: 41.45,
          coverage_s: 3600,
          src_step_s: 15
        }
      };
    });
    const bytes = new TextEncoder().encode(JSON.stringify({ schema: 1, events: rows })).length;
    expect(bytes).toBeGreaterThan(1_000_000);
    expect(bytes).toBeLessThanOrEqual(1.5 * 1024 * 1024);
    expect(await ingest(rows)).toMatchObject({ added: 400, rejected: [], held: [] });
  });
});

describe("health-class sources withheld from a read", () => {
  const steps = {
    id: "steps|band-1|2026-11-01T00:00:00.000Z|v0",
    source: "physiology",
    kind: "steps",
    start: "2026-11-01T00:00:00.000Z",
    attrs: { device: "band-1", route: "app", v: 0, steps: 12 }
  };
  const health = ["apple-health", "iphone-health", "physiology"];

  it("returns every source to a read that excludes nothing, with no withheld field", async () => {
    await ingest([steps, event("a")]);
    const page = await readActivityEvents(sql, {});
    expect(page.events.map((row) => row.source).sort()).toEqual(["physiology", "rhen-watch"]);
    expect(page).not.toHaveProperty("withheld");
  });

  it("leaves health sources out, names them and the missing scope, and still returns the rest", async () => {
    await ingest([
      steps,
      event("a"),
      { id: "ah", source: "apple-health", kind: "steps", start: "2026-11-01T01:00:00Z" },
      { id: "ih", source: "iphone-health", kind: "steps_day", start: "2026-11-01T02:00:00Z" }
    ]);
    const page = await readActivityEvents(sql, { excludeSources: health });
    expect(page.events.map((row) => row.source)).toEqual(["rhen-watch"]);
    expect(page.withheld).toEqual(health);
    expect(page.withheldNote).toContain("read:activity-health");
  });

  it("answers a read that names a withheld source with an empty page and the notice", async () => {
    await ingest([steps]);
    const page = await readActivityEvents(sql, { source: "physiology", kind: "steps", excludeSources: health });
    expect(page.events).toEqual([]);
    expect(page.withheld).toContain("physiology");
    expect((await readActivityEvents(sql, { source: "physiology", kind: "steps" })).events).toHaveLength(1);
  });
});
