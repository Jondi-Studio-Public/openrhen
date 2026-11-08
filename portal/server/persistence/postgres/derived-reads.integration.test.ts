import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { readActivityEvents, readActivitySummary } from "./activity-store";
import { ensureUser } from "./ensure-user";
import { ensureExtractorStateTx, promoteExtractorVersion } from "./extractor-state-store";
import { runDerivedTick } from "@/server/derived/derived-runner";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_derived_reads");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

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

const T = new Date("2026-11-08T00:00:00.000Z");
const at = (seconds: number) => new Date(T.getTime() + seconds * 1000);
const FACT = "a".repeat(40);

async function derived(
  key: string,
  kind: string,
  ingested: Date,
  attrs: Record<string, unknown>,
  user = userId
): Promise<void> {
  await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
    VALUES (${user}, 'derived', ${kind}, ${key}, '2026-11-01T00:00:00Z', ${sql.json(attrs as never)}, ${ingested})`;
}
const klass = (version: string | null, extra: Record<string, unknown> = {}) => ({
  source_event_id: "m",
  class: "bulk",
  reasons: ["list_id"],
  ...(version === null ? {} : { extractor: "msg-class-t0", extractor_version: version }),
  ...extra
});
const keys = async (query: Parameters<typeof readActivityEvents>[1] = {}) =>
  // The fixtures share one ts_start, so the page order is by random id: compare as sets.
  (await readActivityEvents(sql, { source: "derived", ...query })).events.map((e) => e.key).sort();
const state = (version: string, when: Date) =>
  sql.begin((tx) => ensureExtractorStateTx(tx, userId, "msg-class-t0", version, when));

describe("reading derived rows: the active version", () => {
  it("returns nothing from an extractor that has no active version yet", async () => {
    await derived("c1", "msg_class", at(10), klass("1"));
    expect(await keys()).toEqual([]);
    expect((await readActivityEvents(sql, {})).events).toHaveLength(0);
  });

  it("returns only the rows of the active version, whatever the kind filter", async () => {
    await state("1", at(0));
    await derived("v1", "msg_class", at(10), klass("1"));
    await derived("v2", "msg_class", at(11), klass("2"));
    await derived("f1", "fact", at(12), {
      source_event_id: "m",
      fact_id: FACT,
      fact_type: "ask",
      extractor: "msg-class-t0",
      extractor_version: "1"
    });
    await derived("nover", "msg_class", at(13), klass(null));
    expect((await keys()).sort()).toEqual(["f1", "v1"]);
    expect(await keys({ kind: "msg_class" })).toEqual(["v1"]);
    expect((await readActivityEvents(sql, {})).events.map((e) => e.key).sort()).toEqual(["f1", "v1"]);
  });

  it("always shows a person's own rows (status, override, label): they belong to no extractor version", async () => {
    await derived("s1", "fact_status", at(10), { fact_id: FACT, status: "done", valid_from: "2026-11-08T00:00:00Z" });
    await derived("o1", "override", at(11), { fact_id: FACT, field: "when", new_value: null });
    await derived("l1", "label", at(12), { fact_id: FACT, answer: "ask" });
    expect((await keys()).sort()).toEqual(["l1", "o1", "s1"]);
  });

  it("leaves other sources and other people's derived rows alone", async () => {
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    await state("1", at(0));
    await derived("theirs", "msg_class", at(10), klass("1"), other);
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start) VALUES (${userId}, 'gmail', 'message', 'g1', '2026-11-01T00:00:00Z')`;
    expect(await keys()).toEqual([]);
    expect((await readActivityEvents(sql, { source: "gmail" })).events).toHaveLength(1);
  });

  it("pages through filtered rows without losing or repeating one", async () => {
    await state("1", at(0));
    for (let i = 0; i < 5; i++) {
      await derived(`a${i}`, "msg_class", at(10 + i), klass("1"));
      await derived(`z${i}`, "msg_class", at(10 + i), klass("9"));
    }
    const seen: string[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await readActivityEvents(sql, { source: "derived", limit: 2, after });
      seen.push(...page.events.map((e) => e.key));
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen.sort()).toEqual(["a0", "a1", "a2", "a3", "a4"]);
  });
});

describe("reading derived rows as of a time", () => {
  /** Version 1 active from t=0; version 2 promoted at t=100. v1 rows ingested 10..50, v2 rows 110..150. */
  async function twoVersions() {
    await state("1", at(0));
    await derived("v1a", "msg_class", at(10), klass("1"));
    await derived("v1b", "msg_class", at(50), klass("1"));
    await derived("v2a", "msg_class", at(110), klass("2"));
    await derived("v2b", "msg_class", at(150), klass("2"));
    await promoteExtractorVersion(sql, userId, "msg-class-t0", "2", at(100));
  }

  it("reads the version that was active then, and only what was ingested by then", async () => {
    await twoVersions();
    expect(await keys({ asOf: at(30) })).toEqual(["v1a"]);
    expect(await keys({ asOf: at(60) })).toEqual(["v1a", "v1b"]);
    expect(await keys({ asOf: at(99) })).toEqual(["v1a", "v1b"]);
    expect(await keys({ asOf: at(100) })).toEqual([]);
    expect(await keys({ asOf: at(120) })).toEqual(["v2a"]);
    expect(await keys({ asOf: at(200) })).toEqual(["v2a", "v2b"]);
    expect(await keys()).toEqual(["v2a", "v2b"]);
  });

  it("returns nothing before the first version existed", async () => {
    await twoVersions();
    expect(await keys({ asOf: at(-5) })).toEqual([]);
  });

  it("does not change for an old time when newer rows, a newer run or another promotion arrive", async () => {
    await twoVersions();
    const before = await keys({ asOf: at(60) });
    const beforeEvents = (await readActivityEvents(sql, { source: "derived", asOf: at(60) })).events;
    await derived("v1late", "msg_class", at(300), klass("1"));
    await derived("v3", "msg_class", at(310), klass("3"));
    await promoteExtractorVersion(sql, userId, "msg-class-t0", "3", at(305));
    await promoteExtractorVersion(sql, userId, "msg-class-t0", "1", at(400));
    expect(await keys({ asOf: at(60) })).toEqual(before);
    expect((await readActivityEvents(sql, { source: "derived", asOf: at(60) })).events).toEqual(beforeEvents);
    expect(await keys({ asOf: at(320) })).toEqual(["v3"]);
  });

  it("applies the time limit to every source, not only derived", async () => {
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, ingested_at)
      VALUES (${userId}, 'gmail', 'message', 'old', '2026-11-01T00:00:00Z', ${at(10)}),
             (${userId}, 'gmail', 'message', 'new', '2026-11-01T00:00:00Z', ${at(90)})`;
    expect((await readActivityEvents(sql, { source: "gmail", asOf: at(50) })).events.map((e) => e.key)).toEqual([
      "old"
    ]);
  });

  it("still shows a person's rows only once they had been ingested", async () => {
    await derived("s1", "fact_status", at(10), { fact_id: FACT, status: "done", valid_from: "2026-11-08T00:00:00Z" });
    await derived("s2", "fact_status", at(90), {
      fact_id: FACT,
      status: "confirmed",
      valid_from: "2026-11-08T00:01:00Z"
    });
    expect(await keys({ asOf: at(50) })).toEqual(["s1"]);
  });

  it("breaks a tie between two promotions at the same instant by the later version name", async () => {
    await state("1", at(0));
    await derived("v1", "msg_class", at(10), klass("1"));
    await derived("v2", "msg_class", at(10), klass("2"));
    await promoteExtractorVersion(sql, userId, "msg-class-t0", "2", at(100));
    expect(await keys({ asOf: at(150) })).toEqual(["v2"]);
  });
});

describe("the runner's rows are visible once it has run", () => {
  it("shows the classified mail through the ordinary read, and the summary reports the layer", async () => {
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
      VALUES (${userId}, 'gmail', 'message', 'g1', '2026-11-01T00:00:00Z', '{"message_id":"<a>","list_id":"<l>"}', ${at(-100)})`;
    await runDerivedTick(sql, { now: () => at(0) });
    const events = (await readActivityEvents(sql, { source: "derived" })).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "msg_class", ingestedVia: "extractor:msg-class-t0" });
  });
});

describe("the summary: how far behind the derived layer is", () => {
  const gmail = async (n: number, ingested: Date) => {
    for (let i = 0; i < n; i++)
      await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
        VALUES (${userId}, 'gmail', 'message', ${`g-${ingested.getTime()}-${i}`}, '2026-11-01T00:00:00Z', '{"message_id":"<a>"}', ${ingested})`;
  };

  it("counts every mail row as behind before the first run, and lists the extractor as not yet run", async () => {
    await gmail(3, at(-100));
    const summary = await readActivitySummary(sql);
    expect(summary.derivedBehind).toBe(3);
    expect(summary.extractors).toEqual([
      { extractor: "msg-class-t0", version: "1", active: false, behind: 3, skipped: 0, lastOkAt: null, lastError: null }
    ]);
  });

  it("counts rows past the forward watermark plus the backfill remainder, and shrinks as the runner works", async () => {
    await gmail(5, at(-100));
    await runDerivedTick(sql, { now: () => at(0), backfillBatch: 2 });
    let summary = await readActivitySummary(sql);
    expect(summary.derivedBehind).toBe(3);
    await gmail(2, at(50));
    summary = await readActivitySummary(sql);
    expect(summary.derivedBehind).toBe(5);
    await runDerivedTick(sql, { now: () => at(1000), backfillBatch: 10 });
    summary = await readActivitySummary(sql);
    expect(summary.derivedBehind).toBe(0);
    expect(summary.extractors[0]).toMatchObject({
      active: true,
      behind: 0,
      lastOkAt: at(1000).toISOString(),
      lastError: null
    });
  });

  it("shows the last error and the skipped count so a stale layer is visible, until a clean run replaces them", async () => {
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
      VALUES (${userId}, 'gmail', 'message', 'bad', '2026-11-01T00:00:00Z', '"text"', ${at(-100)})`;
    for (let i = 0; i < 3; i++) await runDerivedTick(sql, { now: () => at(i) });
    const [gaveUp] = (await readActivitySummary(sql)).extractors;
    expect(gaveUp).toMatchObject({ skipped: 1, lastOkAt: at(2).toISOString() });
    expect(gaveUp!.lastError).toMatch(/bad/);
    await runDerivedTick(sql, { now: () => at(10) });
    expect((await readActivitySummary(sql)).extractors[0]).toMatchObject({ skipped: 1, lastError: null });
  });

  it("is zero when there is no mail at all", async () => {
    expect((await readActivitySummary(sql)).derivedBehind).toBe(0);
  });
});
