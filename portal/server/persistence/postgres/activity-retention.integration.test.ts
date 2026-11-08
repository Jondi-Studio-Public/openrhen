import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { runDerivedTick } from "@/server/derived/derived-runner";
import {
  ActivityInputError,
  deleteActivityImport,
  purgeActivitySource,
  purgeExpiredActivity,
  readActivitySummary,
  setActivitySourceSettings
} from "./activity-store";
import { RETENTION_BATCHES_PER_TICK } from "./activity-retention-store";
import { recordLineage } from "./derived-lineage-store";
import { appendRunnerFactStatusTx, RETENTION_VIA } from "./derived-source-gone-store";
import { ensureUser } from "./ensure-user";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_retention");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const now = new Date("2026-11-08T12:00:00.000Z");
const OLD = "2025-01-01T00:00:00Z";
const NEW = "2026-11-07T00:00:00Z";
const fid = (c: string) => c.repeat(40);

async function source(user: string, src: string, key: string, start = OLD, end: string | null = null) {
  const [made] = await sql<{ id: string }[]>`
    INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, ts_end)
    VALUES (${user}, ${src}, 'message', ${key}, ${start}, ${end}) RETURNING id`;
  return made!.id;
}

/** A derived fact (synthetic: nothing writes facts yet) read from `sources`. */
async function fact(key: string, factId: string, sources: string[], user = userId) {
  const [made] = await sql<{ id: string }[]>`
    INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_via)
    VALUES (${user}, 'derived', 'fact', ${key}, ${OLD},
      ${sql.json({ source_event_id: "m", fact_id: factId, fact_type: "ask", extractor: "x-t2", extractor_version: "1" })}, 'extractor:x-t2')
    RETURNING id`;
  await recordLineage(sql, user, [made!.id], sources);
  return made!.id;
}

async function status(
  factId: string,
  value: string,
  via: string | null,
  validFrom: string,
  key = `${factId}-${value}`
) {
  await sql`
    INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_via)
    VALUES (${userId}, 'derived', 'fact_status', ${key}, ${validFrom},
      ${sql.json({ fact_id: factId, status: value, valid_from: validFrom })}, ${via})`;
}

const keys = async (src: string, user = userId) =>
  (
    await sql<
      { event_key: string }[]
    >`SELECT event_key FROM activity_events WHERE source = ${src} AND user_id = ${user} ORDER BY event_key`
  ).map((r) => r.event_key);
const total = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM activity_events`)[0]!.n;
const statuses = async (factId: string) =>
  await sql<{ status: string; via: string | null; valid_from: string }[]>`
    SELECT attrs->>'status' AS status, ingested_via AS via, attrs->>'valid_from' AS valid_from
    FROM activity_events WHERE kind = 'fact_status' AND attrs->>'fact_id' = ${factId} ORDER BY event_key`;
const tick = (extra: Parameters<typeof runDerivedTick>[1] = {}) =>
  runDerivedTick(sql, { now: () => now, extractors: [], ...extra });

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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

describe("permanent by default: the tick deletes nothing without a setting", () => {
  it("deletes zero rows for a source with null retention, however old, and for a source with no state row", async () => {
    await source(userId, "gmail", "old-1");
    await source(userId, "spotify", "old-2");
    await sql`INSERT INTO activity_source_state (user_id, source, content_enabled, retention_days) VALUES (${userId}, 'gmail', false, NULL)`;
    const before = await total();
    const result = await tick();
    expect(result).toMatchObject({ status: "ok", retention: { removed: 0, sources: [], more: false } });
    expect(await total()).toBe(before);
    expect(await purgeExpiredActivity(sql, now)).toEqual([]);
    expect(await total()).toBe(before);
  });

  it("clearing the setting back to null stops deleting", async () => {
    await source(userId, "gmail", "old");
    await setActivitySourceSettings(sql, "gmail", { retentionDays: 30 });
    await setActivitySourceSettings(sql, "gmail", { retentionDays: null });
    await tick();
    expect(await keys("gmail")).toEqual(["old"]);
  });
});

describe("the tick applies a set retention", () => {
  it("deletes expired rows of the source with the setting only, by end time, and keeps recent ones", async () => {
    await source(userId, "gmail", "old");
    await source(userId, "gmail", "recent", NEW);
    await source(userId, "gmail", "ended-recently", OLD, NEW);
    await source(userId, "spotify", "old-other-source");
    await setActivitySourceSettings(sql, "gmail", { retentionDays: 30 });
    const result = await tick();
    expect(result).toMatchObject({ retention: { removed: 1, sources: [{ source: "gmail", removed: 1 }] } });
    expect(await keys("gmail")).toEqual(["ended-recently", "recent"]);
    expect(await keys("spotify")).toEqual(["old-other-source"]);
  });

  it("never deletes derived rows themselves, even when the derived source has a setting", async () => {
    const m = await source(userId, "gmail", "m");
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs)
      VALUES (${userId}, 'derived', 'msg_class', 'c', ${OLD}, ${sql.json({ class: "person" })}),
             (${userId}, 'derived-shadow', 'msg_class', 'cs', ${OLD}, ${sql.json({ class: "person" })})`;
    await recordLineage(
      sql,
      userId,
      [(await sql<{ id: string }[]>`SELECT id FROM activity_events WHERE event_key = 'c'`)[0]!.id],
      [m]
    );
    await sql`INSERT INTO activity_source_state (user_id, source, retention_days) VALUES (${userId}, 'derived', 1), (${userId}, 'derived-shadow', 1), (${userId}, 'gmail', 1)`;
    await tick();
    expect(await keys("gmail")).toEqual([]);
    expect(await keys("derived")).toEqual(["c"]);
    expect(await keys("derived-shadow")).toEqual(["cs"]);
  });

  it("keeps derived rows when their source expires (orphans) and they still read back", async () => {
    const m = await source(userId, "gmail", "m");
    const f = await fact("f", fid("a"), [m]);
    await sql`INSERT INTO activity_source_state (user_id, source, retention_days) VALUES (${userId}, 'gmail', 30)`;
    await tick();
    expect(await keys("gmail")).toEqual([]);
    expect(await keys("derived")).toContain("f");
    expect(await sql`SELECT 1 FROM derived_lineage WHERE derived_id = ${f}`).toHaveLength(0);
    expect((await sql`SELECT 1 FROM activity_events WHERE id = ${f}`).length).toBe(1);
  });

  it("is idempotent: a second tick deletes nothing and writes no second source_gone", async () => {
    const m = await source(userId, "gmail", "m");
    await fact("f", fid("a"), [m]);
    await sql`INSERT INTO activity_source_state (user_id, source, retention_days) VALUES (${userId}, 'gmail', 30)`;
    await tick();
    const after = await total();
    const second = await tick();
    expect(second).toMatchObject({ retention: { removed: 0 } });
    expect(await total()).toBe(after);
    expect(await statuses(fid("a"))).toHaveLength(1);
  });

  it("isolates people: another person's expired rows and settings are not touched by this person's tick", async () => {
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    await source(userId, "gmail", "mine");
    await source(other, "gmail", "theirs");
    await sql`INSERT INTO activity_source_state (user_id, source, retention_days) VALUES (${other}, 'gmail', 1)`;
    await tick();
    expect(await keys("gmail", userId)).toEqual(["mine"]);
    expect(await keys("gmail", other)).toEqual(["theirs"]);
  });

  it("is bounded per tick and resumes on the next", async () => {
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start)
      SELECT ${userId}, 'weather', 'observation', 'k' || g, '2025-01-01T00:00:00Z'::timestamptz + g * interval '1 second'
      FROM generate_series(1, 5000 * ${RETENTION_BATCHES_PER_TICK} + 10) g`;
    await sql`INSERT INTO activity_source_state (user_id, source, retention_days) VALUES (${userId}, 'weather', 30)`;
    const first = await tick();
    expect(first).toMatchObject({ more: true, retention: { removed: 5000 * RETENTION_BATCHES_PER_TICK, more: true } });
    expect(await total()).toBe(10);
    const second = await tick();
    expect(second).toMatchObject({ retention: { removed: 10, more: false } });
    expect(await total()).toBe(0);
  });

  it("works under concurrent ingest: rows arriving during the purge are not lost, and a tick holding the lock answers busy", async () => {
    await source(userId, "gmail", "old");
    await sql`INSERT INTO activity_source_state (user_id, source, retention_days) VALUES (${userId}, 'gmail', 30)`;
    const [a, b, ingested] = await Promise.all([tick(), tick(), source(userId, "gmail", "arrives", NEW)]);
    expect([a.status, b.status].filter((s) => s === "ok").length).toBeGreaterThanOrEqual(1);
    expect(ingested).toBeTruthy();
    expect(await keys("gmail")).toEqual(["arrives"]);
  });

  it("reports the last purge per source in the summary", async () => {
    await source(userId, "gmail", "old");
    await setActivitySourceSettings(sql, "gmail", { retentionDays: 30 });
    await tick();
    const summary = await readActivitySummary(sql);
    const gmail = summary.sources.find((s) => s.source === "gmail")!;
    expect(gmail).toMatchObject({ retentionPurge: "scheduled", lastPurge: { removed: 1, at: now.toISOString() } });
    expect(summary.sources.find((s) => s.source === "spotify")).toMatchObject({
      retentionPurge: "not_set",
      lastPurge: null
    });
  });

  it("hides the last purge once the retention is cleared, so a permanent source never shows a stale deletion", async () => {
    await source(userId, "gmail", "old");
    await setActivitySourceSettings(sql, "gmail", { retentionDays: 30 });
    await tick();
    expect((await readActivitySummary(sql)).sources.find((s) => s.source === "gmail")!.lastPurge).not.toBeNull();
    await setActivitySourceSettings(sql, "gmail", { retentionDays: null });
    expect((await readActivitySummary(sql)).sources.find((s) => s.source === "gmail")).toMatchObject({
      retentionDays: null,
      retentionPurge: "not_set",
      lastPurge: null
    });
    // The record is hidden, not erased: setting a retention again shows the last purge that really happened.
    await setActivitySourceSettings(sql, "gmail", { retentionDays: 30 });
    expect((await readActivitySummary(sql)).sources.find((s) => s.source === "gmail")!.lastPurge).toMatchObject({
      removed: 1
    });
  });
});

describe("settings and bad values", () => {
  it("refuses a retention on derived and derived-shadow with a message saying why, and still lets null clear", async () => {
    const refused = setActivitySourceSettings(sql, "derived", { retentionDays: 30 });
    await expect(refused).rejects.toBeInstanceOf(ActivityInputError);
    await expect(refused).rejects.toThrow(/not applied to derived rows.*kept as history.*raw source/s);
    const shadow = setActivitySourceSettings(sql, "derived-shadow", { retentionDays: 30 });
    await expect(shadow).rejects.toBeInstanceOf(ActivityInputError);
    await expect(shadow).rejects.toThrow(/not applied to derived rows.*kept as history.*raw source/s);
    expect(await sql`SELECT 1 FROM activity_source_state WHERE retention_days IS NOT NULL`).toHaveLength(0);
    await expect(setActivitySourceSettings(sql, "derived", { retentionDays: null })).resolves.toMatchObject({
      retentionDays: null
    });
  });

  it("skips a source whose retention makes an invalid cutoff, reports it, and still purges the others", async () => {
    await source(userId, "gmail", "old-gmail");
    await source(userId, "spotify", "old-spotify");
    await sql`INSERT INTO activity_source_state (user_id, source, retention_days) VALUES (${userId}, 'gmail', 2147483647), (${userId}, 'spotify', 30)`;
    const result = await tick();
    expect(result).toMatchObject({
      status: "ok",
      retention: {
        removed: 1,
        sources: [
          { source: "gmail", removed: 0, skipped: expect.stringMatching(/retention_days 2147483647/) },
          { source: "spotify", removed: 1 }
        ]
      }
    });
    expect(await keys("gmail")).toEqual(["old-gmail"]);
    expect(await keys("spotify")).toEqual([]);
    const gmail = (await readActivitySummary(sql)).sources.find((s) => s.source === "gmail")!;
    expect(gmail.lastPurge).toMatchObject({ removed: 0, skipped: expect.any(String) });
    expect(await purgeExpiredActivity(sql, now)).toEqual([
      { source: "gmail", removed: 0 },
      { source: "spotify", removed: 0 }
    ]);
  });
});

describe("source_gone for open facts", () => {
  const setup = async () => {
    await sql`INSERT INTO activity_source_state (user_id, source, retention_days) VALUES (${userId}, 'gmail', 30)`;
  };

  it("appends source_gone (extractor identity, valid_from now) for an open fact whose sources all expire, before deleting", async () => {
    const [m1, m2] = [await source(userId, "gmail", "m1"), await source(userId, "gmail", "m2")];
    await fact("f", fid("a"), [m1, m2]);
    await setup();
    await tick();
    expect(await statuses(fid("a"))).toEqual([
      { status: "source_gone", via: RETENTION_VIA, valid_from: now.toISOString() }
    ]);
    expect(await keys("derived")).toContain("f");
  });

  it("does not mark a fact that still has a source outside the batch, then marks it when the last goes", async () => {
    const [old, recent] = [await source(userId, "gmail", "old"), await source(userId, "gmail", "recent", NEW)];
    await fact("f", fid("a"), [old, recent]);
    await setup();
    await tick();
    expect(await statuses(fid("a"))).toHaveLength(0);
    await tick({ now: () => new Date("2027-06-01T00:00:00Z") });
    expect(await statuses(fid("a"))).toHaveLength(1);
  });

  it("skips facts already closed (done, cancelled, source_gone) and writes for proposed, confirmed, rescheduled", async () => {
    const ms = await Promise.all(["a", "b", "c", "d", "e", "f"].map((k) => source(userId, "gmail", `m${k}`)));
    const facts = ["a", "b", "c", "d", "e", "f"].map((c) => fid(c));
    await Promise.all(facts.map((f, i) => fact(`fact-${i}`, f, [ms[i]!])));
    await status(facts[0]!, "done", null, "2025-02-01T00:00:00Z");
    await status(facts[1]!, "cancelled", "mark", "2025-02-01T00:00:00Z");
    await status(facts[2]!, "confirmed", null, "2025-02-01T00:00:00Z");
    await status(facts[3]!, "rescheduled", "mark", "2025-02-01T00:00:00Z");
    await status(facts[4]!, "source_gone", RETENTION_VIA, "2025-02-01T00:00:00Z");
    await setup();
    await tick();
    const added = async (f: string) =>
      (await statuses(f)).filter((s) => s.via === RETENTION_VIA && s.valid_from === now.toISOString()).length;
    expect(await Promise.all(facts.map(added))).toEqual([0, 0, 1, 1, 0, 1]);
  });

  it("does not mark facts of other sources or people", async () => {
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    const [g, s, t] = [
      await source(userId, "gmail", "g"),
      await source(userId, "spotify", "s"),
      await source(other, "gmail", "t")
    ];
    await fact("fg", fid("a"), [g]);
    await fact("fs", fid("b"), [s]);
    await fact("ft", fid("c"), [t], other);
    await sql`INSERT INTO activity_source_state (user_id, source, retention_days) VALUES (${other}, 'gmail', 1)`;
    await setup();
    await tick();
    expect(await statuses(fid("a"))).toHaveLength(1);
    expect(await statuses(fid("b"))).toHaveLength(0);
    expect(await statuses(fid("c"))).toHaveLength(0);
  });

  it("writes the status in the same transaction as the delete: a failed delete leaves no source_gone", async () => {
    const m = await source(userId, "gmail", "m");
    await fact("f", fid("a"), [m]);
    await setup();
    await sql`CREATE OR REPLACE FUNCTION refuse_gmail_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'no'; END $$ LANGUAGE plpgsql`;
    await sql`CREATE TRIGGER refuse_gmail_delete BEFORE DELETE ON activity_events FOR EACH ROW WHEN (OLD.source = 'gmail') EXECUTE FUNCTION refuse_gmail_delete()`;
    try {
      const result = await tick();
      expect(result).toMatchObject({ status: "ok", retention: { removed: 0, error: expect.any(String) } });
    } finally {
      await sql`DROP TRIGGER refuse_gmail_delete ON activity_events`;
    }
    expect(await statuses(fid("a"))).toHaveLength(0);
    expect(await keys("gmail")).toEqual(["m"]);
  });
});

describe("explicit deletes still take derived rows with their sources", () => {
  it("undo import and purge source delete the derived rows via lineage, as before", async () => {
    const [i] = await sql<{ id: string }[]>`
      INSERT INTO activity_imports (user_id, source, sha256, filename) VALUES (${userId}, 'gmail', ${"a".repeat(64)}, 'x') RETURNING id`;
    const m1 = (
      await sql<{ id: string }[]>`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, import_id)
      VALUES (${userId}, 'gmail', 'message', 'm1', ${OLD}, ${i!.id}) RETURNING id`
    )[0]!.id;
    const m2 = await source(userId, "spotify", "m2");
    await fact("f1", fid("a"), [m1]);
    await fact("f2", fid("b"), [m2]);
    await deleteActivityImport(sql, i!.id);
    expect(await keys("derived")).toEqual(["f2"]);
    await purgeActivitySource(sql, "spotify");
    expect(await keys("derived")).toEqual([]);
  });
});

describe("the runner's one status write", () => {
  it("can write source_gone and no other status, and has no path for an override or label", async () => {
    await sql.begin(async (tx) => {
      const out = await appendRunnerFactStatusTx(tx, userId, [fid("a")], "source_gone", now);
      expect(out).toBe(1);
      for (const bad of ["done", "cancelled", "confirmed", "proposed", "superseded", "override", "label"])
        await expect(appendRunnerFactStatusTx(tx, userId, [fid("a")], bad as never, now)).rejects.toThrow(
          /source_gone/
        );
    });
    expect(await sql`SELECT 1 FROM activity_events WHERE kind IN ('override','label')`).toHaveLength(0);
    expect(await statuses(fid("a"))).toHaveLength(1);
  });
});
