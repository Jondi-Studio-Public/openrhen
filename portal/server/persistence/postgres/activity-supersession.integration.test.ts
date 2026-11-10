import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import {
  ACTIVITY_SOURCES,
  canonicalMessageKey,
  enterCoreOnly,
  registerContractsExtension,
  type ActivityIngestResult
} from "@openrhen/contracts";
import {
  deleteActivityImport,
  ingestActivityEvents,
  ingestActivityEventsTx,
  purgeActivitySource,
  purgeExpiredActivity,
  readActivityEvents,
  readActivitySummary,
  writeSupersessionLinksTx
} from "./activity-store";
import { runDerivedTick } from "@/server/derived/derived-runner";
import { msgClassT0 } from "@/server/derived/msg-class-t0";
import { lockActivityUser } from "./activity-lock";
import { scanForward } from "./derived-scan-store";
import { ensureUser } from "./ensure-user";
import { resetRunThrottle } from "./run-log";

/**
 * Supersession (A3, docs/design/ and activity-store.md): an import row that holds a message's text stands in for a thinner
 * copy of the same message (no text) in another source. The thin row stays, is still read by the derived pipeline, and
 * is hidden only from a text reader that names no source. Three fixture sources are in the `message@1` family; the
 * thin mail source outside the family is whichever legacy message source the registry holds (the test names no provider).
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_supersession");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
let leaveCoreOnly: (() => void) | undefined;

const LIVE = "sfx-live";
const ARCHIVE = "sfx-archive";
const ARCHIVE2 = "sfx-archive2";
/** A message source outside the family: the registry's first legacy one. */
const LEGACY = Object.entries(ACTIVITY_SOURCES).find(
  ([, entry]) => entry.kinds.includes("message") && entry.family === undefined
)![0];
const now = new Date("2026-11-20T12:00:00.000Z");
const BASE = Date.parse("2026-11-09T10:00:00.000Z");
const iso = (seconds: number) => new Date(BASE + seconds * 1000).toISOString();
const MID = "<Abc.123@Mail.Example.com>";
const MID_KEY = "mid:Abc.123@mail.example.com";

interface Options {
  at?: number;
  text?: string | null;
  mid?: string;
  from?: string;
}
/** A `message@1` event with its canonical key worked out the way a collector must. */
function message(source: string, options: Options = {}) {
  const text = options.text === undefined ? "Can you send the draft by Friday?" : options.text;
  const from = options.from ?? "alex@example.com";
  const start = iso(options.at ?? 0);
  const key = canonicalMessageKey({ messageId: options.mid, sender: from, tsStart: new Date(start), content: text })!;
  return {
    id: key,
    source,
    kind: "message",
    start,
    ...(text === null ? {} : { content: text }),
    attrs: { from, ...(options.mid === undefined ? {} : { message_id: options.mid }) }
  };
}
/** A row of the legacy mail source, keyed as that collector keys it (not by message id) and carrying the raw id. */
const legacy = (n: number, options: Options = {}) => ({
  id: `legacy-${n}`,
  source: LEGACY,
  kind: "message",
  start: iso(options.at ?? 0),
  ...(options.text === undefined || options.text === null ? {} : { content: options.text }),
  attrs: { from: "alex@example.com", ...(options.mid === undefined ? {} : { message_id: options.mid }) }
});

const ingest = (events: unknown[], extra: Record<string, unknown> = {}) =>
  ingestActivityEvents(sql, { events, ...extra }, "agent-a", now);
let fileCounter = 0;
/** An explicit file import into one source (first batch of a new file). */
const importFile = (source: string, events: unknown[]) =>
  ingest(events, {
    import: { sha256: `file-${++fileCounter}`.padEnd(64, "0"), filename: `f${fileCounter}.mbox`, source }
  });

const rows = () =>
  sql<{ id: string; source: string; event_key: string; content: string | null; import_id: string | null }[]>`
    SELECT id, source, event_key, content, import_id FROM activity_events WHERE kind = 'message' ORDER BY source, event_key`;
const links = () =>
  sql<{ superseded: string; superseded_key: string; by: string; by_key: string; created_at: Date }[]>`
    SELECT s.source AS superseded, s.event_key AS superseded_key, b.source AS by, b.event_key AS by_key, l.created_at
    FROM activity_supersessions l
    JOIN activity_events s ON s.id = l.superseded_id
    JOIN activity_events b ON b.id = l.by_id
    ORDER BY s.source, s.event_key`;
const visible = async (query: Parameters<typeof readActivityEvents>[1] = {}) =>
  (await readActivityEvents(sql, query)).events.map((event) => `${event.source}/${event.key}`);
const invariant = (result: ActivityIngestResult, sent: number) =>
  expect(result.added + result.alreadyHeld + result.rejected.length).toBe(sent);

beforeAll(async () => {
  leaveCoreOnly = enterCoreOnly();
  registerContractsExtension({
    id: "sfx",
    activitySources: {
      [LIVE]: { schemaVersion: 1, kinds: ["message"], family: "message@1" },
      [ARCHIVE]: { schemaVersion: 1, kinds: ["message"], family: "message@1" },
      [ARCHIVE2]: { schemaVersion: 1, kinds: ["message"], family: "message@1" }
    }
  });
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
  sql = postgres(testUrl.toString(), { max: 8, connect_timeout: 10, fetch_types: false });
}, 60_000);

const reset = async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
  resetRunThrottle();
};
beforeEach(reset);
afterEach(async () => {
  await sql`DELETE FROM activity_source_state`;
});
afterAll(async () => {
  leaveCoreOnly?.();
  await sql?.end();
});

describe("an import replacing a thin copy", () => {
  it("links an import row to a thin message@1 row held earlier, by message id", async () => {
    const thin = await ingest([message(LIVE, { mid: MID, text: "Hello there" })]);
    expect(thin).toMatchObject({ added: 1, contentDropped: 1, replaced: [] });

    const result = await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "Hello there" })]);
    expect(result).toMatchObject({ added: 1, alreadyHeld: 0, rejected: [], duplicates: [] });
    expect(result.replaced).toEqual([
      {
        index: 0,
        source: ARCHIVE,
        key: MID_KEY,
        role: "replaces",
        other: { source: LIVE, key: MID_KEY },
        by: "message_id",
        kept: "import"
      }
    ]);
    invariant(result, 1);
    expect(await links()).toMatchObject([{ superseded: LIVE, by: ARCHIVE }]);
    // Both rows are held: the thin one is never removed or re-pointed.
    expect((await rows()).map((row) => [row.source, row.content])).toEqual([
      [ARCHIVE, "Hello there"],
      [LIVE, null]
    ]);
  });

  it("links by fingerprint within 60 s when the thin row has no message id", async () => {
    await ingest([message(LIVE, { text: "Lunch on Thursday?" })]);
    const result = await importFile(ARCHIVE, [message(ARCHIVE, { text: "Lunch on Thursday?", at: 30 })]);
    expect(result.replaced).toMatchObject([{ role: "replaces", by: "fingerprint", other: { source: LIVE } }]);
    expect(await links()).toHaveLength(1);
    // 61 s apart is two messages.
    await reset();
    await ingest([message(LIVE, { text: "Lunch on Thursday?" })]);
    const far = await importFile(ARCHIVE, [message(ARCHIVE, { text: "Lunch on Thursday?", at: 61 })]);
    expect(far.replaced).toEqual([]);
    expect(await links()).toEqual([]);
  });

  it("links a thin row of the legacy mail source, whose raw id is bracketed and mixed case, to a mid: import row", async () => {
    await ingest([legacy(1, { mid: MID })]);
    const result = await importFile(ARCHIVE, [
      message(ARCHIVE, { mid: "abc.123@mail.example.com".replace("abc", "Abc"), text: "Body" })
    ]);
    expect(result.replaced).toMatchObject([
      { role: "replaces", other: { source: LEGACY, key: "legacy-1" }, by: "message_id" }
    ]);
    expect(await links()).toMatchObject([{ superseded: LEGACY, superseded_key: "legacy-1", by: ARCHIVE }]);
  });

  it("links one import row to every thin copy of the message", async () => {
    await ingest([legacy(1, { mid: MID }), message(LIVE, { mid: MID, text: "Hi" })]);
    const result = await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "Hi" })]);
    expect(result.added).toBe(1);
    expect(result.replaced.map((entry) => entry.other.source).sort()).toEqual([LEGACY, LIVE].sort());
    expect(await links()).toHaveLength(2);
  });

  it("reports nothing on a second post of the same batch (it is alreadyHeld) and never counts a link as held", async () => {
    await ingest([message(LIVE, { mid: MID, text: "Hi" })]);
    const events = [message(ARCHIVE, { mid: MID, text: "Hi" })];
    const first = await importFile(ARCHIVE, events);
    const importId = first.importId!;
    const again = await ingest(events, { importId });
    expect(again).toMatchObject({ added: 0, alreadyHeld: 1, replaced: [], duplicates: [] });
    invariant(again, 1);
    expect(await links()).toHaveLength(1);
  });

  it("keeps the same-source rule: a re-import into the same source with the same key is alreadyHeld, nothing linked", async () => {
    const first = await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "Hi" })]);
    const second = await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "Hi" })]);
    expect(first.added).toBe(1);
    expect(second).toMatchObject({ added: 0, alreadyHeld: 1, replaced: [] });
    expect(await links()).toEqual([]);
  });

  it("stores both import events of one source for one thin row, links once, and lists the link made", async () => {
    await ingest([message(LIVE, { mid: MID, text: "Same words" })]);
    const result = await importFile(ARCHIVE, [
      message(ARCHIVE, { mid: MID, text: "Same words" }),
      message(ARCHIVE, { text: "Same words", at: 5 })
    ]);
    expect(result.added).toBe(2);
    expect(result.replaced).toHaveLength(1);
    expect(result.replaced[0]).toMatchObject({ index: 0, role: "replaces" });
    expect(await links()).toHaveLength(1);
    invariant(result, 2);
  });

  it("does not link when a visible copy with text is also held: the import copy is dropped as before", async () => {
    // B2 never stores both a thin and a text copy of one message; this is legacy data, so it is written directly.
    await ingest([message(LIVE, { mid: MID, text: "Hi" })]);
    await sql`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, content, attrs)
      VALUES (${userId}, ${ARCHIVE2}, 'message', ${MID_KEY}, ${iso(0)}, 'Hi', ${sql.json({ message_id: "Abc.123@mail.example.com" })})`;
    const result = await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "Hi" })]);
    expect(result).toMatchObject({ added: 0, alreadyHeld: 1, replaced: [] });
    expect(result.duplicates).toMatchObject([{ source: ARCHIVE, by: "message_id" }]);
    expect(await links()).toEqual([]);
  });

  it("never links a non-import row, and never an import row without text", async () => {
    await ingest([legacy(1, { mid: MID })]);
    await sql`INSERT INTO activity_source_state (user_id, source, content_enabled) VALUES (${userId}, ${ARCHIVE}, true)`;
    const live = await ingest([message(ARCHIVE, { mid: MID, text: "Live text" })]);
    expect(live).toMatchObject({ added: 1, replaced: [] });
    expect(await links()).toEqual([]);

    await reset();
    await ingest([message(LIVE, { mid: MID, text: "Hi" })]);
    const empty = await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: null })]);
    // No text, so it supersedes nothing; it is a copy of a held message and is dropped as before.
    expect(empty).toMatchObject({ added: 0, alreadyHeld: 1, replaced: [] });
    expect(await links()).toEqual([]);
  });

  it("matches a later copy and a second import against the import row, not the superseded thin row", async () => {
    await ingest([message(LIVE, { mid: MID, text: "Hi" })]);
    await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "Hi" })]);
    const second = await importFile(ARCHIVE2, [message(ARCHIVE2, { mid: MID, text: "Hi" })]);
    expect(second).toMatchObject({ added: 0, alreadyHeld: 1, replaced: [] });
    expect(second.duplicates).toMatchObject([{ of: { source: ARCHIVE } }]);
    const third = await ingest([message(LIVE, { mid: MID, text: "Hi", at: 3 })]);
    expect(third.added + third.alreadyHeld).toBe(1);
    expect(await links()).toHaveLength(1);
  });
});

describe("a thin row arriving after the import", () => {
  it("stores a thin row of the legacy mail source and links it to the import at birth", async () => {
    await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "The text" })]);
    const result = await ingest([legacy(1, { mid: MID })]);
    expect(result).toMatchObject({ added: 1, alreadyHeld: 0, duplicates: [] });
    expect(result.replaced).toEqual([
      {
        index: 0,
        source: LEGACY,
        key: "legacy-1",
        role: "replaced_by",
        other: { source: ARCHIVE, key: MID_KEY },
        by: "message_id",
        kept: "import"
      }
    ]);
    invariant(result, 1);
    expect(await links()).toMatchObject([{ superseded: LEGACY, superseded_key: "legacy-1", by: ARCHIVE }]);
    // Re-posting it is alreadyHeld and claims no link.
    const again = await ingest([legacy(1, { mid: MID })]);
    expect(again).toMatchObject({ added: 0, alreadyHeld: 1, replaced: [] });
    expect(await links()).toHaveLength(1);
  });

  it("drops a thin message@1 row that arrives after the import, as before (arrival-order behaviour, stated)", async () => {
    await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "The text" })]);
    const result = await ingest([message(LIVE, { mid: MID, text: "The text" })]);
    expect(result).toMatchObject({ added: 0, alreadyHeld: 1, replaced: [] });
    expect(result.duplicates).toMatchObject([{ source: LIVE, of: { source: ARCHIVE } }]);
  });

  it("leaves a gate-on legacy row and an import row of one message both visible, in either order", async () => {
    await sql`INSERT INTO activity_source_state (user_id, source, content_enabled) VALUES (${userId}, ${LEGACY}, true)`;
    await ingest([legacy(1, { mid: MID, text: "Full text" })]);
    const imported = await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "Full text" })]);
    expect(imported).toMatchObject({ added: 1, replaced: [] });
    expect(await links()).toEqual([]);
    expect(await rows()).toHaveLength(2);

    await reset();
    await sql`INSERT INTO activity_source_state (user_id, source, content_enabled) VALUES (${userId}, ${LEGACY}, true)`;
    await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "Full text" })]);
    const live = await ingest([legacy(1, { mid: MID, text: "Full text" })]);
    expect(live).toMatchObject({ added: 1, replaced: [] });
    expect(await links()).toEqual([]);
    expect(await rows()).toHaveLength(2);
  });

  it("does not link a thin legacy row to a live copy with text (only an import supersedes)", async () => {
    await sql`INSERT INTO activity_source_state (user_id, source, content_enabled) VALUES (${userId}, ${LIVE}, true)`;
    await ingest([message(LIVE, { mid: MID, text: "Live text" })]);
    const thin = await ingest([legacy(1, { mid: MID })]);
    expect(thin).toMatchObject({ added: 1, replaced: [] });
    expect(await links()).toEqual([]);
  });

  it("does not match a bare chat id across sources", async () => {
    await ingest([legacy(1, { mid: "12" })]);
    const result = await importFile(ARCHIVE, [message(ARCHIVE, { mid: "12", text: "Hi" })]);
    expect(result).toMatchObject({ added: 1, replaced: [] });
    expect(await links()).toEqual([]);
  });
});

describe("what a link changes, and what it leaves alone", () => {
  async function superseded() {
    await ingest([legacy(1, { mid: MID }), legacy(2, { mid: "<other@mail.example.com>", at: 5 })]);
    return importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "The text" })]);
  }

  it("hides the superseded row from an unfiltered read only, and flags it when the source is named", async () => {
    await superseded();
    expect(await visible()).toEqual([`${ARCHIVE}/${MID_KEY}`, `${LEGACY}/legacy-2`]);
    expect(await visible({ kind: "message" })).toEqual([`${ARCHIVE}/${MID_KEY}`, `${LEGACY}/legacy-2`]);
    const named = (await readActivityEvents(sql, { source: LEGACY })).events;
    expect(named.map((event) => [event.key, event.supersededBy])).toEqual([
      ["legacy-1", { source: ARCHIVE, key: MID_KEY }],
      ["legacy-2", undefined]
    ]);
    expect((await readActivityEvents(sql, { source: ARCHIVE })).events[0]!.supersededBy).toBeUndefined();
  });

  it("pages an unfiltered read by keyset without losing or repeating a row around the hidden one", async () => {
    await ingest([
      legacy(1, { mid: MID, at: 0 }),
      legacy(2, { mid: "<b@mail.example.com>", at: 10 }),
      legacy(3, { at: 20 })
    ]);
    await importFile(ARCHIVE, [
      message(ARCHIVE, { mid: MID, text: "T", at: 5 }),
      message(ARCHIVE, { text: "Other", at: 30 })
    ]);
    const seen: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await readActivityEvents(sql, { limit: 2, after });
      seen.push(...page.events.map((event) => `${event.source}/${event.key}`));
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen).toEqual([
      `${ARCHIVE}/${MID_KEY}`,
      `${LEGACY}/legacy-2`,
      `${LEGACY}/legacy-3`,
      expect.stringContaining(ARCHIVE)
    ]);
  });

  it("reads as_of the link's created_at: the thin row up to it, the import row from it, never neither", async () => {
    await ingest([legacy(1, { mid: MID })]);
    await new Promise((done) => setTimeout(done, 25));
    await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "T" })]);
    const [link] = await links();
    // The database holds microseconds and a JS Date milliseconds, so the instant "at" the link is the next millisecond up.
    const created = link!.created_at;
    const before = new Date(created.getTime() - 1);
    const at = new Date(created.getTime() + 1);
    expect(await visible({ asOf: before })).toEqual([`${LEGACY}/legacy-1`]);
    expect(await visible({ asOf: at })).toEqual([`${ARCHIVE}/${MID_KEY}`]);
    expect(await visible({ asOf: new Date(created.getTime() + 60_000) })).toEqual([`${ARCHIVE}/${MID_KEY}`]);
  });

  it("keeps one copy visible for an as_of between two interleaved transactions (thin row transaction started first)", async () => {
    let thinResult: ActivityIngestResult | undefined;
    await sql.begin(async (tx) => {
      await tx`SELECT 1`; // the thin row's transaction starts here, before the import's
      await new Promise((done) => setTimeout(done, 30));
      await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "T" })]);
      thinResult = await ingestActivityEventsTx(tx, userId, { events: [legacy(1, { mid: MID })] }, "agent-a", now);
    });
    expect(thinResult).toMatchObject({ added: 1 });
    expect(thinResult!.replaced).toMatchObject([{ role: "replaced_by" }]);
    const [thin] = await sql<{ ingested_at: Date }[]>`SELECT ingested_at FROM activity_events WHERE source = ${LEGACY}`;
    const [imported] = await sql<
      { ingested_at: Date }[]
    >`SELECT ingested_at FROM activity_events WHERE source = ${ARCHIVE}`;
    expect(thin!.ingested_at.getTime()).toBeLessThan(imported!.ingested_at.getTime());
    const between = new Date(thin!.ingested_at.getTime() + 1);
    expect(await visible({ asOf: between })).toEqual([`${LEGACY}/legacy-1`]);
    expect(await visible({ asOf: new Date(imported!.ingested_at.getTime() + 1) })).toEqual([`${ARCHIVE}/${MID_KEY}`]);
    const [link] = await links();
    expect(link!.created_at.getTime()).toBe(imported!.ingested_at.getTime());
  });

  it("leaves what measures a collector alone: counts, last ingest and the derived scan still see the thin row", async () => {
    await superseded();
    const summary = await readActivitySummary(sql, now);
    expect(summary.sources.find((source) => source.source === LEGACY)).toMatchObject({ events: 2 });
    expect(summary.sources.find((source) => source.source === ARCHIVE)).toMatchObject({ events: 1 });
    const scanned = await scanForward(
      sql,
      userId,
      { source: LEGACY, kind: "message" },
      { at: "1970-01-01T00:00:00.000000Z", id: "00000000-0000-0000-0000-000000000000" },
      new Date(Date.now() + 60_000),
      10
    );
    // Both rows share one ingested_at (one transaction), so the scan breaks the tie by id: compare as a set.
    expect(scanned.map((row) => row.key).sort()).toEqual(["legacy-1", "legacy-2"]);
  });

  it("keeps a derived row and its lineage on the thin row, untouched", async () => {
    await ingest([legacy(1, { mid: MID })]);
    const [thin] = await sql<{ id: string }[]>`SELECT id FROM activity_events WHERE source = ${LEGACY}`;
    const [derived] = await sql<{ id: string }[]>`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs)
      VALUES (${userId}, 'derived', 'msg_class', 'cls-1', now(), '{}'::jsonb) RETURNING id`;
    await sql`INSERT INTO derived_lineage (user_id, derived_id, source_id) VALUES (${userId}, ${derived!.id}, ${thin!.id})`;
    await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "T" })]);
    const [lineage] = await sql<
      { source_id: string }[]
    >`SELECT source_id FROM derived_lineage WHERE derived_id = ${derived!.id}`;
    expect(lineage!.source_id).toBe(thin!.id);
    expect(await sql`SELECT 1 FROM activity_events WHERE id = ${derived!.id}`).toHaveLength(1);
  });
});

describe("the derived pipeline keeps reading the thin row", () => {
  /** The source the message classifier reads (the registry's, so no provider is named here). */
  const MAIL = msgClassT0.input.source;
  const mailRow = () => ({
    id: "t0-1",
    source: MAIL,
    kind: "message",
    start: iso(0),
    attrs: { message_id: MID, list_id: "<news.example.com>", from: "News <news@example.com>" }
  });
  const tick = () => runDerivedTick(sql, { now: () => new Date(Date.now() + 5 * 60_000), extractors: [msgClassT0] });
  const classes = () =>
    sql<{ source_event_id: string }[]>`
      SELECT attrs->>'source_event_id' AS source_event_id FROM activity_events WHERE source = 'derived' AND kind = 'msg_class'`;
  const lineage = () => sql<{ source_id: string }[]>`SELECT source_id FROM derived_lineage`;

  it("keeps the class and lineage of a thin row, and writes no second class, when an import then replaces it", async () => {
    await ingest([mailRow()]);
    await tick();
    const [thin] = await sql<{ id: string }[]>`SELECT id FROM activity_events WHERE source = ${MAIL}`;
    expect(await classes()).toHaveLength(1);
    const before = await lineage();
    expect(before).toEqual([{ source_id: thin!.id }]);

    const result = await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "The text" })]);
    expect(result.replaced).toMatchObject([{ role: "replaces", other: { source: MAIL } }]);
    await tick();
    expect(await classes()).toHaveLength(1);
    expect(await lineage()).toEqual(before);
  });

  it("derives from a thin row stored and linked after the import", async () => {
    await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "The text" })]);
    const result = await ingest([mailRow()]);
    expect(result.replaced).toMatchObject([{ role: "replaced_by", other: { source: ARCHIVE } }]);
    await tick();
    const [thin] = await sql<{ id: string }[]>`SELECT id FROM activity_events WHERE source = ${MAIL}`;
    expect((await classes()).map((row) => row.source_event_id)).toEqual(["t0-1"]);
    expect(await lineage()).toEqual([{ source_id: thin!.id }]);
  });
});

describe("undo, purge and retention", () => {
  const setup = async () => {
    await ingest([legacy(1, { mid: MID })]);
    return importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "T" })]);
  };

  it("brings the thin row back when the import is undone, and removes the link", async () => {
    const result = await setup();
    expect(await visible()).toEqual([`${ARCHIVE}/${MID_KEY}`]);
    expect(await deleteActivityImport(sql, result.importId!)).toEqual({ deleted: true, removed: 1 });
    expect(await links()).toEqual([]);
    expect(await visible()).toEqual([`${LEGACY}/legacy-1`]);
  });

  it("brings the thin row back when the import's source is purged", async () => {
    await setup();
    await purgeActivitySource(sql, ARCHIVE);
    expect(await links()).toEqual([]);
    expect(await visible()).toEqual([`${LEGACY}/legacy-1`]);
  });

  it("drops only the link when the thin row's source is purged, and the import row stays visible", async () => {
    await setup();
    await purgeActivitySource(sql, LEGACY);
    expect(await links()).toEqual([]);
    expect(await visible()).toEqual([`${ARCHIVE}/${MID_KEY}`]);
  });

  it("cascades a retention purge of the import's source: the thin row is back", async () => {
    await setup();
    await sql`INSERT INTO activity_source_state (user_id, source, retention_days) VALUES (${userId}, ${ARCHIVE}, 1)`;
    // The rows are from 2026-11-09 and the clock is 2026-11-20, so everything of the source is past retention.
    await purgeExpiredActivity(sql, now);
    expect(await links()).toEqual([]);
    expect(await visible()).toEqual([`${LEGACY}/legacy-1`]);
  });

  it("cascades a retention purge of the thin row's source: the import row stays", async () => {
    await setup();
    await sql`INSERT INTO activity_source_state (user_id, source, retention_days) VALUES (${userId}, ${LEGACY}, 1)`;
    await purgeExpiredActivity(sql, now);
    expect(await links()).toEqual([]);
    expect(await visible()).toEqual([`${ARCHIVE}/${MID_KEY}`]);
  });

  it("finds no thin row to link when a delete took the per-person lock first", async () => {
    await ingest([legacy(1, { mid: MID })]);
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    let locked!: () => void;
    const isLocked = new Promise<void>((done) => (locked = done));
    const deleting = sql.begin(async (tx) => {
      await lockActivityUser(tx, userId);
      locked();
      await tx`DELETE FROM activity_events WHERE source = ${LEGACY}`;
      await held;
    });
    await isLocked;
    const racing = importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "T" })]);
    await new Promise((done) => setTimeout(done, 150));
    release();
    await deleting;
    const result = await racing;
    expect(result).toMatchObject({ added: 1, replaced: [] });
    expect(await links()).toEqual([]);
    expect(await visible()).toEqual([`${ARCHIVE}/${MID_KEY}`]);
  });
});

describe("the link table", () => {
  it("refuses a link whose rows belong to another person", async () => {
    await ingest([legacy(1, { mid: MID })]);
    await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "T" })]);
    const [other] = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`;
    const [theirs] = await sql<{ id: string }[]>`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, content, import_id)
      VALUES (${other!.id}, ${ARCHIVE}, 'message', 'theirs', now(), 'x', NULL) RETURNING id`;
    const [mine] = await sql<{ id: string }[]>`SELECT id FROM activity_events WHERE source = ${LEGACY}`;
    const made = await sql.begin((tx) =>
      writeSupersessionLinksTx(tx, userId, [{ supersededId: mine!.id, byId: theirs!.id }])
    );
    expect(made).toEqual([]);
    const reverse = await sql.begin((tx) =>
      writeSupersessionLinksTx(tx, other!.id, [{ supersededId: mine!.id, byId: theirs!.id }])
    );
    expect(reverse).toEqual([]);
  });

  it("refuses a superseder that holds no text, a superseded row that holds some, and a chain", async () => {
    await ingest([
      legacy(1, { mid: MID }),
      legacy(2, { mid: "<two@mail.example.com>" }),
      legacy(3, { mid: "<three@mail.example.com>" })
    ]);
    await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "T" })]);
    const id = async (source: string, key: string) =>
      (await sql<{ id: string }[]>`SELECT id FROM activity_events WHERE source = ${source} AND event_key = ${key}`)[0]!
        .id;
    const thinTwo = await id(LEGACY, "legacy-2");
    const thinThree = await id(LEGACY, "legacy-3");
    const imported = await id(ARCHIVE, MID_KEY);
    const thinOne = await id(LEGACY, "legacy-1");
    const write = (pairs: { supersededId: string; byId: string }[]) =>
      sql.begin((tx) => writeSupersessionLinksTx(tx, userId, pairs));
    expect(await write([{ supersededId: thinTwo, byId: thinThree }])).toEqual([]); // the superseder has no text
    expect(await write([{ supersededId: imported, byId: thinTwo }])).toEqual([]);
    expect(await write([{ supersededId: thinOne, byId: imported }])).toEqual([]); // already superseded: first link wins
    // A superseded row holds no text, so it can never be a superseder: no chain can form.
    expect(await write([{ supersededId: thinTwo, byId: thinOne }])).toEqual([]);
    expect(await links()).toHaveLength(1);
  });

  it("is append-only and cascades from either row", async () => {
    await ingest([legacy(1, { mid: MID })]);
    await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "T" })]);
    await expect(sql`UPDATE activity_supersessions SET created_at = now()`).rejects.toThrow(/append-only/);
    await sql`DELETE FROM activity_events WHERE source = ${LEGACY}`;
    expect(await links()).toEqual([]);
  });
});

describe("a large batch", () => {
  it("links a thousand import rows to a thousand thin rows inside one batch and one lock", async () => {
    const mids = Array.from({ length: 1000 }, (_, n) => `<m${n}@mail.example.com>`);
    for (let at = 0; at < mids.length; at += 500)
      await ingest(mids.slice(at, at + 500).map((mid, n) => legacy(at + n, { mid, at: at + n })));
    const started = Date.now();
    const result = await importFile(
      ARCHIVE,
      mids.map((mid, n) => message(ARCHIVE, { mid, text: `Body ${n}`, at: n }))
    );
    expect(result).toMatchObject({ added: 1000, replaced: expect.any(Array) });
    expect(result.replaced).toHaveLength(1000);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(await links()).toHaveLength(1000);
  }, 60_000);
});

describe("a link hides a message only when its replacement is in the reader's view", () => {
  it("shows the thin row to a token that cannot read the import's source, and names no source it cannot see", async () => {
    await ingest([message(LIVE, { mid: MID, text: "Hello there" })]);
    await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "Hello there" })]);
    expect(await links()).toHaveLength(1);

    // The owner sees the import row only (the thin row is hidden behind it).
    expect(await visible({})).toEqual([`${ARCHIVE}/${MID_KEY}`]);
    // A scoped token that cannot read ARCHIVE must still see the message, as the thin row.
    expect(await visible({ excludeSources: [ARCHIVE] })).toEqual([`${LIVE}/${MID_KEY}`]);
    // Naming the thin source returns it flagged for the owner, and unflagged for a token that cannot see the stand-in.
    const owner = await readActivityEvents(sql, { source: LIVE, kind: "message" });
    expect(owner.events[0]?.supersededBy).toEqual({ source: ARCHIVE, key: MID_KEY });
    const scoped = await readActivityEvents(sql, { source: LIVE, kind: "message", excludeSources: [ARCHIVE] });
    expect(scoped.events).toHaveLength(1);
    expect(scoped.events[0]?.supersededBy).toBeUndefined();
  });

  it("hides the thin row behind an import row of a source the reader may see", async () => {
    await ingest([message(LIVE, { mid: MID, text: "Hello there" })]);
    await importFile(ARCHIVE, [message(ARCHIVE, { mid: MID, text: "Hello there" })]);
    expect(await visible({ excludeSources: [ARCHIVE2] })).toEqual([`${ARCHIVE}/${MID_KEY}`]);
  });

  it("links only the nearest thin row when two identical short messages are held and the import holds one", async () => {
    await ingest([message(LIVE, { text: "ok", at: -20 }), message(LIVE, { text: "ok", at: 40 })]);
    const result = await importFile(ARCHIVE, [message(ARCHIVE, { text: "ok", at: 5 })]);
    expect(result.replaced).toHaveLength(1);
    const made = await links();
    expect(made).toHaveLength(1);
    // The nearest in time (25 s, not 35 s) is the one covered.
    expect(made[0]).toMatchObject({ superseded: LIVE, by: ARCHIVE });
    const shown = await visible({});
    expect(shown).toHaveLength(2);
    expect(shown.filter((item) => item.startsWith(`${LIVE}/`))).toHaveLength(1);
    const left = (await readActivityEvents(sql, { source: LIVE })).events.filter(
      (event) => event.supersededBy === undefined
    );
    expect(left.map((event) => event.start)).toEqual([iso(40)]);
  });

  it("links two thin rows when the import holds both of the two identical messages", async () => {
    await ingest([message(LIVE, { text: "ok", at: -20 }), message(LIVE, { text: "ok", at: 40 })]);
    const result = await importFile(ARCHIVE, [
      message(ARCHIVE, { text: "ok", at: -19 }),
      message(ARCHIVE, { text: "ok", at: 41 })
    ]);
    expect(result.replaced).toHaveLength(2);
    expect(await links()).toHaveLength(2);
    expect(await visible({})).toHaveLength(2);
  });

  it("keeps the thin row visible when its replacement lies outside the requested time window", async () => {
    await ingest([message(LIVE, { text: "Lunch on Thursday?", at: 0 })]);
    await importFile(ARCHIVE, [message(ARCHIVE, { text: "Lunch on Thursday?", at: 30 })]);
    expect(await links()).toHaveLength(1);
    // Window holds only the thin row: it shows, so the message does not drop out at the window edge.
    expect(await visible({ from: new Date(iso(-10)), to: new Date(iso(15)) })).toEqual([
      expect.stringMatching(new RegExp(`^${LIVE}/`))
    ]);
    // Window holds both: only the import row.
    expect(await visible({ from: new Date(iso(-10)), to: new Date(iso(60)) })).toEqual([
      expect.stringMatching(new RegExp(`^${ARCHIVE}/`))
    ]);
    // Window holds only the import row: just that.
    expect(await visible({ from: new Date(iso(20)), to: new Date(iso(60)) })).toEqual([
      expect.stringMatching(new RegExp(`^${ARCHIVE}/`))
    ]);
    // No window: only the import row.
    expect(await visible({})).toEqual([expect.stringMatching(new RegExp(`^${ARCHIVE}/`))]);
  });
});

describe("a write that waits for the supersession index build", () => {
  it("completes once the lock is released and is alreadyHeld when sent again", async () => {
    const locker = postgres(testUrl.toString(), { max: 1, connect_timeout: 10, fetch_types: false });
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => (release = resolveHeld));
    let locked!: () => void;
    const lockedPromise = new Promise<void>((resolveLocked) => (locked = resolveLocked));
    // The same lock CREATE INDEX (not CONCURRENTLY) takes: writes wait, reads do not.
    const holder = locker.begin(async (tx) => {
      await tx`LOCK TABLE activity_events IN SHARE MODE`;
      locked();
      await held;
    });
    try {
      await lockedPromise;
      let settled = false;
      const write = ingest([message(LIVE, { text: "Waiting", at: 0 })]).then((result) => {
        settled = true;
        return result;
      });
      // A read is not blocked.
      await expect(readActivityEvents(sql, { kind: "message" })).resolves.toBeDefined();
      await new Promise((resolveWait) => setTimeout(resolveWait, 400));
      expect(settled).toBe(false);
      release();
      await holder;
      const first = await write;
      expect(first).toMatchObject({ added: 1, alreadyHeld: 0, rejected: [] });
      const again = await ingest([message(LIVE, { text: "Waiting", at: 0 })]);
      expect(again).toMatchObject({ added: 0, alreadyHeld: 1, rejected: [] });
    } finally {
      release();
      await holder.catch(() => undefined);
      await locker.end();
    }
  });
});
