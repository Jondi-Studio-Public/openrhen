import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ACTIVITY_SOURCES, coverageKey, heartbeatKey, withheldActivitySources } from "@openrhen/contracts";
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
import { requestScopes, runWithActor } from "@/server/agent-actor";
import { createFailureThrottle } from "@/server/agent-token-throttle";
import { createAgentToken, findAgentTokenByHash } from "@/server/agent-token-store";
import { AGENT_TOKEN_HEADER, identifyRequest } from "@/server/agent-tokens";
import { resetRunThrottle } from "./run-log";

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
  resetRunThrottle();
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

describe("heartbeat and coverage rows", () => {
  // The one core source that declares availability with no feeds: the message collector.
  const collector = Object.keys(ACTIVITY_SOURCES).find(
    (name) => ACTIVITY_SOURCES[name]!.availability?.feeds.length === 0
  )!;
  const hbRow = (device: string | undefined, extra: Record<string, unknown> = {}) => ({
    id: heartbeatKey(device, new Date("2026-11-07T11:30:00Z"), "ok"),
    source: collector,
    kind: "heartbeat",
    start: "2026-11-07T11:30:00Z",
    attrs: { status: "ok" },
    ...extra
  });
  const covRow = (start: string, end: string, extra: Record<string, unknown> = {}) => ({
    id: coverageKey("inbox", new Date(start), new Date(end)),
    source: collector,
    kind: "coverage",
    start,
    end,
    attrs: { complete: true, scope: "inbox" },
    ...extra
  });
  const message = (id: string) => ({ id, source: collector, kind: "message", start: "2026-11-07T10:00:00Z" });

  it("stores a heartbeat whose key names the batch device, and a coverage window", async () => {
    const result = await ingest([hbRow("box"), covRow("2026-11-06T00:00:00Z", "2026-11-07T11:00:00Z")], {
      device: "box"
    });
    expect(result).toMatchObject({ added: 2, rejected: [] });
    const rows = await sql<{ kind: string; device: string | null; ts_end: Date | null }[]>`
      SELECT kind, device, ts_end FROM activity_events WHERE source = ${collector} ORDER BY kind`;
    expect(rows.map((r) => [r.kind, r.device])).toEqual([
      ["coverage", "box"],
      ["heartbeat", "box"]
    ]);
    expect(rows[0]!.ts_end?.toISOString()).toBe("2026-11-07T11:00:00.000Z");
  });

  it("rejects a heartbeat key that does not match the batch device, naming the key and the fix", async () => {
    const result = await ingest([hbRow("box")], { device: "other" });
    expect(result).toMatchObject({ added: 0 });
    expect(result.rejected[0]!.reason).toContain('must be "hb:other:2026-11-07T11:ok"');
    expect(result.rejected[0]!.reason).toContain('send "device" at the top of the batch');
    const none = await ingest([hbRow("box")]);
    expect(none.rejected[0]!.reason).toContain('must be "hb:_:2026-11-07T11:ok"');
  });

  it("refuses a heartbeat or coverage row for a source that does not declare availability", async () => {
    const result = await ingest([
      hbRow(undefined, { source: "rhen-watch" }),
      covRow("2026-11-06T00:00:00Z", "2026-11-07T11:00:00Z", { source: "rhen-watch" })
    ]);
    expect(result.added).toBe(0);
    expect(result.rejected[0]!.reason).toContain("heartbeat is not accepted");
    expect(result.rejected[1]!.reason).toContain("coverage is not accepted");
    expect(await count()).toBe(0);
  });

  it("refuses coverage when a row of the same source in the batch was rejected, and stores the good rows", async () => {
    const result = await ingest([
      message("m1"),
      { ...message("m2"), kind: "nope" },
      covRow("2026-11-06T00:00:00Z", "2026-11-07T11:00:00Z")
    ]);
    expect(result).toMatchObject({ added: 1 });
    expect(result.rejected.map((r) => r.index)).toEqual([1, 2]);
    expect(result.rejected[1]!.reason).toContain(`coverage refused: event #1 of ${collector} was rejected`);
    const again = await ingest([message("m2"), covRow("2026-11-06T00:00:00Z", "2026-11-07T11:00:00Z")]);
    expect(again).toMatchObject({ added: 2, rejected: [] });
  });

  it("refuses a coverage row with no scope, saying the scope and the id to send", async () => {
    const bare = covRow("2026-11-06T00:00:00Z", "2026-11-07T11:00:00Z", {
      id: coverageKey(undefined, new Date("2026-11-06T00:00:00Z"), new Date("2026-11-07T11:00:00Z")),
      attrs: { complete: true }
    });
    const result = await ingest([bare]);
    expect(result.added).toBe(0);
    expect(result.rejected[0]!.reason).toContain("attrs.scope is required");
    expect(result.rejected[0]!.reason).toContain('Add "scope": "<name>" to attrs');
    expect(result.rejected[0]!.reason).toContain("cov:<name>:2026-11-06T00:00:00.000Z:2026-11-07T11:00:00.000Z");
    expect(await count()).toBe(0);
  });

  it("refuses a blank scope the same way", async () => {
    const start = new Date("2026-11-06T00:00:00Z");
    const end = new Date("2026-11-07T11:00:00Z");
    const result = await ingest([
      covRow("2026-11-06T00:00:00Z", "2026-11-07T11:00:00Z", {
        id: coverageKey(" ", start, end),
        attrs: { complete: true, scope: " " }
      })
    ]);
    expect(result.added).toBe(0);
    expect(result.rejected[0]!.reason).toContain("attrs.scope is required");
    expect(result.rejected[0]!.reason).toContain("must not be blank");
  });

  it("is idempotent for a repeated coverage window", async () => {
    const row = covRow("2026-11-06T00:00:00Z", "2026-11-07T11:00:00Z");
    await ingest([row]);
    expect(await ingest([row])).toMatchObject({ added: 0, alreadyHeld: 1 });
  });

  it("allows a window older than 400 days inside an import, not in a live batch", async () => {
    const old = covRow("2025-01-01T00:00:00Z", "2025-01-31T00:00:00Z");
    const live = await ingest([old]);
    expect(live.rejected[0]!.reason).toContain("400 days");
    const imported = await ingest([old], { import: { sha256: sha("7"), filename: "export.json" } });
    expect(imported).toMatchObject({ added: 1, rejected: [] });
  });

  it("keeps coverage of the import's source when a row of another source is refused", async () => {
    const result = await ingest([message("m1"), event("w1"), covRow("2025-01-01T00:00:00Z", "2025-01-31T00:00:00Z")], {
      import: { sha256: sha("8"), filename: "export.json" }
    });
    expect(result.added).toBe(2);
    expect(result.rejected.map((r) => r.index)).toEqual([1]);
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

  it("refuses an expected rhythm for a source that reports no coverage, naming the next step, and still accepts null", async () => {
    await expect(setActivitySourceSettings(sql, "rhen-watch", { expectedEveryMinutes: 1440 })).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/does not report coverage.*docs\/operations\/posting-messages\.md/s)
    });
    expect(await sql`SELECT 1 FROM activity_source_state`).toHaveLength(0);
    expect(await setActivitySourceSettings(sql, "rhen-watch", { expectedEveryMinutes: null })).toMatchObject({
      expectedEveryMinutes: null
    });
  });

  it("shows a stored expected rhythm in the summary, and the table refuses a value out of range", async () => {
    await sql`INSERT INTO activity_source_state (user_id, source, expected_every_minutes)
      SELECT id, 'rhen-watch', 1440 FROM users LIMIT 1`;
    expect((await readActivitySummary(sql)).sources.find((s) => s.source === "rhen-watch")).toMatchObject({
      expectedEveryMinutes: 1440
    });
    for (const bad of [4, 129_601, 0])
      await expect(
        sql`UPDATE activity_source_state SET expected_every_minutes = ${bad} WHERE source = 'rhen-watch'`
      ).rejects.toThrow(/activity_source_state_expected_check/);
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

describe("ingest run rows", () => {
  const ingestRuns = () =>
    sql<{ provider: string; trigger: string; status: string; summary: { rejected: number; firstReason: string } }[]>`
      SELECT provider, trigger, status, summary FROM integration_sync_runs WHERE provider LIKE 'ingest:%' ORDER BY provider`;

  it("leaves one needs_review row, trigger scheduled, when a source's events are rejected", async () => {
    await ingest([event("good"), event("bad", { start: "not a time" }), event("bad2", { start: "also not" })]);
    const rows = await ingestRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "ingest:rhen-watch", trigger: "scheduled", status: "needs_review" });
    expect(rows[0]!.summary.rejected).toBe(2);
    expect(rows[0]!.summary.firstReason).toEqual(expect.any(String));
    expect(rows[0]!.summary.firstReason.length).toBeGreaterThan(0);
  });

  it("writes nothing for a clean batch", async () => {
    await ingest([event("a"), event("b")]);
    expect(await ingestRuns()).toEqual([]);
  });

  it("writes at most one row per source per hour, in memory and after a restart", async () => {
    await ingest([event("bad", { start: "nope" })]);
    await ingest([event("bad-again", { start: "nope" })]);
    expect(await ingestRuns()).toHaveLength(1);
    resetRunThrottle();
    await ingest([event("bad-3", { start: "nope" })]);
    expect(await ingestRuns()).toHaveLength(1);
  });

  it("files rejections from an event with no known source under ingest:unknown", async () => {
    await ingest([{ id: "x", kind: "foreground", start: "2026-11-07T10:00:00Z" }, event("y", { source: "made-up" })]);
    const rows = await ingestRuns();
    expect(rows.map((row) => row.provider)).toEqual(["ingest:unknown"]);
  });

  it("still records the rejections when the transaction rolls back", async () => {
    await expect(
      ingest([event("bad", { start: "nope" })], { importId: "00000000-0000-4000-8000-000000000000" })
    ).rejects.toBeInstanceOf(ActivityInputError);
    expect(await count()).toBe(0);
    expect((await ingestRuns()).map((row) => row.provider)).toEqual(["ingest:rhen-watch"]);
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
    const read = values.filter((value): value is number => value !== null);
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
        min: Math.min(...read),
        max: Math.max(...read),
        avg: Math.round((read.reduce((a, b) => a + b, 0) / read.length) * 100) / 100,
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

  it("accepts a batch of about 250 worst-case rows (about 1.5 MB) inside the request cap", async () => {
    const rows = Array.from({ length: 250 }, (_, n) => {
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
          unit_raw: "milliseconds",
          // The worst case: 240 irregular one-decimal readings with their offsets and a flags list.
          step_s: null,
          t: Array.from({ length: 240 }, (_, i) => i * 14),
          values: Array.from({ length: 240 }, (_, i) => 100.5 + (i % 20) / 10),
          flags: Array.from({ length: 240 }, () => null),
          n: 240,
          min: 100.5,
          max: 102.4,
          avg: 101.45,
          coverage_s: 3360,
          src_step_s: 14
        }
      };
    });
    const bytes = new TextEncoder().encode(JSON.stringify({ schema: 1, events: rows })).length;
    expect(bytes).toBeGreaterThan(1_000_000);
    expect(bytes).toBeLessThanOrEqual(1.5 * 1024 * 1024);
    expect(await ingest(rows)).toMatchObject({ added: 250, rejected: [], held: [] });
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
    expect(page.withheldClasses).toEqual({ health: health.length });
  });

  it("attaches the notice only when no source was named or the named one is withheld", async () => {
    await ingest([steps, event("a")]);
    const named = await readActivityEvents(sql, { source: "rhen-watch", excludeSources: health });
    expect(named.events).toHaveLength(1);
    expect(named).not.toHaveProperty("withheld");
    expect(named).not.toHaveProperty("withheldNote");
    expect(await readActivityEvents(sql, { excludeSources: health })).toHaveProperty("withheld");
    expect(await readActivityEvents(sql, { source: "iphone-health", excludeSources: health })).toHaveProperty(
      "withheld"
    );
  });

  it("answers a read that names a withheld source with an empty page and the notice", async () => {
    await ingest([steps]);
    const page = await readActivityEvents(sql, { source: "physiology", kind: "steps", excludeSources: health });
    expect(page.events).toEqual([]);
    expect(page.withheld).toContain("physiology");
    expect((await readActivityEvents(sql, { source: "physiology", kind: "steps" })).events).toHaveLength(1);
  });
});

describe("a real database token reads health rows only with read:activity-health", () => {
  const health = ["apple-health", "iphone-health", "physiology"];

  /** Issues a token in the table, identifies a request with it the way the route wrapper does, and reads as that token. */
  const readAs = async (scopes: string[], name: string) => {
    const { token } = await createAgentToken(sql, { name, scopes, directWrites: {}, expiresInDays: 30 });
    const identity = await identifyRequest(
      new Request("http://portal.test/api/activity-events", { headers: { [AGENT_TOKEN_HEADER]: token } }),
      "/api/activity-events",
      undefined,
      { ok: true, entries: [] },
      "off",
      { lookup: (hash) => findAgentTokenByHash(sql, hash), touch: () => {}, throttle: createFailureThrottle() }
    );
    expect(identity.principal?.source).toBe("db");
    const held = identity.principal?.scopes;
    return runWithActor(
      identity.actor ?? null,
      () => readActivityEvents(sql, { excludeSources: withheldActivitySources(requestScopes()) }),
      undefined,
      undefined,
      held ?? []
    );
  };

  it("withholds them from a read-only event token and returns them to one that also holds the health scope", async () => {
    await ingest([
      event("a"),
      {
        id: "steps|band-1|2026-11-01T00:00:00.000Z|v0",
        source: "physiology",
        kind: "steps",
        start: "2026-11-01T00:00:00.000Z",
        attrs: { device: "band-1", route: "app", v: 0, steps: 12 }
      },
      { id: "ah", source: "apple-health", kind: "steps", start: "2026-11-01T01:00:00Z" }
    ]);
    const plain = await readAs(["read:activity-event"], "plain");
    // The drift class is withheld from a token without its own scope as well as the health class.
    expect(plain).toMatchObject({ withheld: [...health, "drift"].sort() });
    expect((await readAs(["read:activity-event"], "plain2")).events.map((row) => row.source)).toEqual(["rhen-watch"]);
    const readable = ["apple-health", "physiology", "rhen-watch"];
    const healthOnly = await readAs(["read:activity-event", "read:activity-health"], "health-only");
    expect(healthOnly.events.map((row) => row.source).sort()).toEqual(readable);
    expect(healthOnly).toMatchObject({ withheld: ["drift"] });
    const full = await readAs(["read:activity-event", "read:activity-health", "read:activity-drift"], "full");
    expect(full.events.map((row) => row.source).sort()).toEqual(readable);
    expect(full).not.toHaveProperty("withheld");
  });
});

describe("the per-device view of health sources in the summary", () => {
  const at = (iso: string) => new Date(iso);
  const clock = at("2026-11-07T12:00:00.000Z");
  const steps = (device: string, hour: number, extra: Record<string, unknown> = {}) => {
    const start = new Date(Date.parse("2026-11-05T00:00:00.000Z") + hour * 3_600_000).toISOString();
    return {
      id: `steps|${device}|${start}|v0`,
      source: "physiology",
      kind: "steps",
      start,
      attrs: { device, route: "app", v: 0, steps: 10 },
      ...extra
    };
  };
  const devices = async () => (await readActivitySummary(sql, clock)).devices;

  it("is empty when no health source holds a row", async () => {
    await ingest([event("a")]);
    expect(await devices()).toEqual([]);
  });

  it("groups by source, device, kind and collector, and counts rows with the last event and ingest times", async () => {
    await ingest([steps("band-1", 0), steps("band-1", 1), steps("band-2", 0)], {}, "phone-app");
    await ingest([steps("band-1", 2)], {}, "file-export");
    const list = await devices();
    expect(list.map((d) => [d.source, d.device, d.kind, d.ingestedVia, d.rows30d])).toEqual([
      ["physiology", "band-1", "steps", "file-export", 1],
      ["physiology", "band-1", "steps", "phone-app", 2],
      ["physiology", "band-2", "steps", "phone-app", 1]
    ]);
    const phone = list.find((d) => d.device === "band-1" && d.ingestedVia === "phone-app")!;
    expect(phone.lastEventAt).toBe("2026-11-05T01:00:00.000Z");
    expect(phone.lastIngestedAt).toMatch(/^2026-|^20\d\d-/);
  });

  it("ends a period row's last event at its end when it has one", async () => {
    await ingest([steps("band-1", 0, { end: "2026-11-05T01:00:00.000Z" })]);
    expect((await devices())[0]!.lastEventAt).toBe("2026-11-05T01:00:00.000Z");
  });

  it("keeps the owner's own posts apart as a null collector", async () => {
    await ingest([steps("band-1", 0)], {}, null);
    expect((await devices())[0]).toMatchObject({ device: "band-1", ingestedVia: null });
  });

  it("looks back 30 days only", async () => {
    await ingest([
      { ...steps("band-1", 0), id: "steps|band-1|2026-10-01T00:00:00.000Z|v0", start: "2026-10-01T00:00:00.000Z" },
      steps("band-1", 0)
    ]);
    expect((await devices())[0]!.rows30d).toBe(1);
  });

  it("maps the legacy sources: attrs.source_name, else the device column", async () => {
    await ingest(
      [
        {
          id: "ah1",
          source: "apple-health",
          kind: "steps",
          start: "2026-11-06T10:00:00Z",
          attrs: { source_name: "watch" }
        }
      ],
      {},
      "export-tool"
    );
    await ingest(
      [{ id: "ih1", source: "iphone-health", kind: "steps_day", start: "2026-11-06T00:00:00Z" }],
      { device: "iphone-14" },
      "shortcut"
    );
    const list = await devices();
    expect(list.find((d) => d.source === "apple-health")).toMatchObject({
      device: "watch",
      kind: "steps",
      ingestedVia: "export-tool",
      rows30d: 1
    });
    expect(list.find((d) => d.source === "iphone-health")).toMatchObject({
      device: "iphone-14",
      kind: "steps_day",
      ingestedVia: "shortcut"
    });
  });

  it("leaves other sources out", async () => {
    await ingest([event("a"), steps("band-1", 0)]);
    expect((await devices()).map((d) => d.source)).toEqual(["physiology"]);
  });

  it("answers within a bounded time at 100k rows in the window, using the (user, source, time) index", async () => {
    await sql`
      INSERT INTO activity_events (user_id, source, kind, event_key, device, ts_start, attrs, ingested_via)
      SELECT ${userId}, 'physiology', (ARRAY['heart_rate', 'steps', 'hrv', 'sleep'])[1 + n % 4], 'k' || n,
             'x', '2026-11-07T12:00:00Z'::timestamptz - (n % 2000) * interval '20 minutes',
             jsonb_build_object('device', 'band-' || (n % 5)), 'collector-' || (n % 3)
      FROM generate_series(1, 100000) AS n`;
    // Rows of other sources and older rows surround the window and must not be scanned into it.
    await sql`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs)
      SELECT ${userId}, 'rhen-watch', 'foreground', 'w' || n, '2026-11-07T12:00:00Z'::timestamptz - n * interval '1 minute', '{}'::jsonb
      FROM generate_series(1, 50000) AS n`;
    await sql`ANALYZE activity_events`;
    const began = performance.now();
    const list = (await readActivitySummary(sql, clock)).devices;
    const took = performance.now() - began;
    expect(list.reduce((total, d) => total + d.rows30d, 0)).toBe(
      (
        await sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM activity_events WHERE source = 'physiology' AND ts_start >= '2026-10-08T12:00:00Z'`
      )[0]!.n
    );
    expect(list.length).toBeLessThanOrEqual(5 * 4 * 3);
    expect(took).toBeLessThan(3000);
    // The window here holds nearly every physiology row, so the planner may scan. For a window that is a small part of
    // the table (a day of it here) the same predicate shape must be served by the (user, source, ts_start) index.
    const plan = await sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      return tx.unsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN SELECT 1 FROM activity_events WHERE user_id = '${userId}' AND source IN ('apple-health', 'iphone-health', 'physiology') AND ts_start >= '2026-11-06T12:00:00Z'`
      );
    });
    expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toMatch(/activity_events_user_source_time_idx/);
  }, 60_000);
});
