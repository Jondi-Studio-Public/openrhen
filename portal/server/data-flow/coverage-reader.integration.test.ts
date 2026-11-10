import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readDoctorReport } from "@/server/persistence/postgres/doctor";
import { enterCoreOnly, registerContractsExtension } from "@openrhen/contracts";
import type { FlowEntry } from "@openrhen/contracts/data-flow";
import { setActivitySourceSettings } from "@/server/persistence/postgres/activity-store";
import { resetHealthCache, readHealth } from "./health-reader";
import { readSourcesSlice } from "./doctor-sources-reader";

/**
 * The coverage reader end to end: a message source that says how far it has read is judged by that, not by when its
 * last message arrived. Rows are seeded straight into the store; the registry is a core-only build plus a fixture
 * extension that registers a message-family source and a collector that declares its cadence.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_coverage_reader");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const NOW = new Date("2026-11-09T12:00:00Z");
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

const INBOX = "covfx-inbox";
const PAGER = "covfx-pager";
/** A message-family source whose entry does not say it changes the plan (the shape of the legacy mail entry). */
const LEGACY = "covfx-legacy";

const entryFor = (source: string, name: string, changesPlan = true): FlowEntry => ({
  id: source,
  name,
  role: "source",
  category: "communications",
  method: "push",
  trigger: { kind: "on-request", by: "device" },
  code: {},
  from: [],
  to: [`pg:activity_events[source=${source},kind=message]`],
  activitySource: source,
  ...(changesPlan ? { changesPlan: true as const } : {}),
  health: { kind: "activity", source }
});

async function message(source: string, hoursAgo: number, extra: { from?: string; fromSelf?: boolean } = {}) {
  await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, ingested_at, attrs)
    VALUES (${userId}, ${source}, 'message', ${crypto.randomUUID()}, ${ago(hoursAgo)}, ${ago(hoursAgo)},
      ${sql.json({ from: extra.from ?? "a@x.example", ...(extra.fromSelf ? { from_self: true } : {}) })})`;
}
/** A coverage window from `fromHoursAgo` to `toHoursAgo`, posted when it ended (or `postedHoursAgo`, or by an import). */
async function covered(
  source: string,
  scope: string | null,
  fromHoursAgo: number,
  toHoursAgo: number,
  options: { postedHoursAgo?: number; importId?: string } = {}
) {
  await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, ts_end, ingested_at, import_id, attrs)
    VALUES (${userId}, ${source}, 'coverage', ${crypto.randomUUID()}, ${ago(fromHoursAgo)}, ${ago(toHoursAgo)},
      ${ago(options.postedHoursAgo ?? toHoursAgo)}, ${options.importId ?? null},
      ${sql.json({ complete: true, ...(scope === null ? {} : { scope }) })})`;
}
/** One window per post, each an hour wide and ending at the given hours ago, posted as it ended. */
async function postsAt(source: string, scope: string | null, endsHoursAgo: readonly number[], offsetHours = 0) {
  for (const end of endsHoursAgo)
    await covered(source, scope, end + 1 - offsetHours, end - offsetHours, { postedHoursAgo: end });
}
/** `count` hourly posts, the newest `lastHoursAgo` ago. */
const hourly = (source: string, scope: string | null, lastHoursAgo: number, count = 30) =>
  postsAt(
    source,
    scope,
    Array.from({ length: count }, (_, index) => lastHoursAgo + index)
  );
const DAY_H = 24;
async function heartbeat(source: string, hoursAgo: number, status: "ok" | "error", error?: string) {
  await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, ingested_at, attrs)
    VALUES (${userId}, ${source}, 'heartbeat', ${crypto.randomUUID()}, ${ago(hoursAgo)}, ${ago(hoursAgo)},
      ${sql.json({ status, ...(error ? { error } : {}) })})`;
}
async function processingRun(source: string, hoursAgo: number, summary: object) {
  await sql`INSERT INTO integration_sync_runs (user_id, provider, trigger, started_at, finished_at, status, summary)
    VALUES (${userId}, ${`reconcile:${source}`}, 'scheduled', ${ago(hoursAgo)}, ${ago(hoursAgo)}, 'synced', ${sql.json(summary as never)})`;
}

const slice = () => readSourcesSlice(sql as never, NOW, userId);
const sourceOf = async (id: string) => (await slice()).sources.find((candidate) => candidate.id === id)!;
const report = () => readDoctorReport(sql as never, { now: NOW });
/** The freshness items for one source; the tidy "collecting, unused" summary is about where its rows go, not its health. */
const itemsFor = async (id: string) =>
  (await report()).items.filter(
    (item) => item.handles.includes(`source:${id}`) && (item.check === "source_late" || item.check === "source_silent")
  );

let leaveCoreOnly: (() => void) | undefined;

beforeAll(async () => {
  leaveCoreOnly = enterCoreOnly();
  registerContractsExtension({
    id: "covfx",
    activitySources: {
      [INBOX]: { schemaVersion: 1, kinds: ["message"], family: "message@1" },
      [LEGACY]: {
        schemaVersion: 1,
        kinds: ["message"],
        family: "message@1",
        availability: { delivery: "periodic", origin: "account", feeds: [], recoveryHint: "Restart the collector." }
      },
      [PAGER]: {
        schemaVersion: 1,
        kinds: ["message"],
        family: "message@1",
        availability: {
          delivery: "periodic",
          origin: "account",
          expectedEveryMinutes: 20,
          feeds: [],
          recoveryHint: "Restart the pager collector."
        }
      }
    },
    dataFlow: () => ({
      entries: [entryFor(INBOX, "Demo inbox"), entryFor(PAGER, "Demo pager"), entryFor(LEGACY, "Legacy inbox", false)]
    })
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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  resetHealthCache();
  await sql.unsafe(
    "TRUNCATE TABLE integration_sync_runs, activity_events, activity_imports, activity_source_state, extractor_state, provider_call_telemetry, agent_tokens RESTART IDENTITY CASCADE"
  );
  await sql`INSERT INTO integration_sync_runs (user_id,provider,trigger,started_at,finished_at,status,summary)
    VALUES (${userId},'backup','scheduled',${NOW.toISOString()},${NOW.toISOString()},'synced','{}'::jsonb)`;
});

afterAll(async () => {
  leaveCoreOnly?.();
  await sql?.end();
});

describe("a quiet inbox and a stuck collector", () => {
  it("keeps a quiet inbox with advancing coverage fresh, however old its last message", async () => {
    await message(INBOX, 90);
    await hourly(INBOX, "main", 1);
    await heartbeat(INBOX, 1, "ok");
    const source = await sourceOf(INBOX);
    expect(source).toMatchObject({ freshness: "fresh", changesPlan: true, configured: true });
    expect(source.lastSuccessAt).toBe(ago(1).toISOString());
    expect(source.coverage).toMatchObject({ coveredTo: ago(1).toISOString(), heartbeat: { status: "ok" } });
    expect(source.threshold).toMatchObject({ warnHours: 3, errorHours: 6, from: "learned", usualMinutes: 60 });
    expect((await report()).planInputs).toEqual({ complete: true, behind: [], sentence: null, note: null });
    expect(await itemsFor(INBOX)).toEqual([]);
  });

  it("goes late at T behind and stale at 2T, alive but not reading, and blocks because the source changes the plan", async () => {
    await hourly(INBOX, "main", 4);
    await heartbeat(INBOX, 1, "ok");
    expect((await sourceOf(INBOX)).freshness).toBe("late");
    expect((await itemsFor(INBOX))[0]).toMatchObject({ check: "source_late", tier: "degrading" });
    resetHealthCache();
    await sql`DELETE FROM activity_events WHERE kind = 'coverage'`;
    await hourly(INBOX, "main", 7);
    const source = await sourceOf(INBOX);
    expect(source.freshness).toBe("stale");
    const [item] = await itemsFor(INBOX);
    expect(item).toMatchObject({ id: `source_late:${INBOX}`, tier: "blocking" });
    expect(item!.title).toContain(
      "is read up to 2026-11-09 05:00 UTC, 7 h behind its usual rhythm of one update every 1 h"
    );
    expect(item!.why).toContain("alive");
    expect(item!.fix.question).toContain(`\`rhen sources ${INBOX}\``);
    const planInputs = (await report()).planInputs!;
    expect(planInputs.complete).toBe(false);
    expect(planInputs.sentence).toContain("This plan is built from messages read up to 2026-11-09 05:00 UTC");
    expect(planInputs.sentence).toContain(`rhen sources ${INBOX}`);
    const health = await readHealth(sql as never, { now: NOW, entries: [entryFor(INBOX, "Demo inbox")], cache: false });
    expect(health.nodes[INBOX]!.note).toContain("alive");
  });

  it("does not count heartbeat or coverage rows as messages arriving", async () => {
    await message(INBOX, 5);
    await covered(INBOX, "main", 10, 1);
    await heartbeat(INBOX, 1, "ok");
    const health = await readHealth(sql as never, { now: NOW, entries: [entryFor(INBOX, "Demo inbox")], cache: false });
    expect(health.nodes[INBOX]).toMatchObject({ count24h: 1, count7d: 1, kindsSeen: ["message"] });
  });

  it("shows a collector whose newest heartbeat is an error as failing, with its error text", async () => {
    await covered(INBOX, "main", 30, 20);
    await heartbeat(INBOX, 2, "error", "sign-in expired");
    const source = await sourceOf(INBOX);
    expect(source.freshness).toBe("failing");
    const [item] = await itemsFor(INBOX);
    expect(item!.why).toContain("sign-in expired");
    expect(item).toMatchObject({ check: "source_late", tier: "degrading" });
  });

  it("is never covered when it sends heartbeats and no coverage, and says so", async () => {
    await heartbeat(INBOX, 1, "ok");
    expect((await sourceOf(INBOX)).freshness).toBe("never");
    expect((await itemsFor(INBOX)).map((item) => item.id)).toEqual([`source_silent:${INBOX}`]);
    const planInputs = (await report()).planInputs!;
    expect(planInputs.complete).toBe(false);
    expect(planInputs.sentence).toContain("built without knowing how far messages from Demo inbox are read");
  });

  it("is judged exactly as before by its arrivals until it posts either kind", async () => {
    await message(INBOX, 2);
    const source = await sourceOf(INBOX);
    expect(source.coverage).toBeUndefined();
    // No threshold is stated and the source posts no coverage, so there is nothing to be late against.
    expect(source).toMatchObject({ freshness: "n/a", threshold: null, lastSuccessAt: ago(2).toISOString() });
    expect(await itemsFor(INBOX)).toEqual([]);
  });
});

describe("a young collector", () => {
  it("cannot block on a limit learned from a few hours of posts, however stale it looks", async () => {
    await postsAt(INBOX, "main", [12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5]);
    await heartbeat(INBOX, 12, "ok");
    const source = await sourceOf(INBOX);
    expect(source.threshold).toMatchObject({ from: "provisional" });
    expect(source.freshness).toBe("stale");
    const items = await itemsFor(INBOX);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.tier !== "blocking")).toBe(true);
    const { planInputs } = await report();
    expect(planInputs!.behind).toEqual([]);
    expect(planInputs!.note).toContain("judged on 7 gaps");
  });

  it("does not take a year of backfilled coverage, posted minutes apart, as its rhythm", async () => {
    const importId = crypto.randomUUID();
    await sql`INSERT INTO activity_imports (id, user_id, source, filename, sha256, event_count)
      VALUES (${importId}, ${userId}, ${INBOX}, 'x.json', ${"a".repeat(64)}, 0)`;
    for (let day = 1; day <= 365; day += 1)
      await covered(INBOX, "main", day * DAY_H + 24, day * DAY_H, { postedHoursAgo: 0.2, importId });
    for (let day = 2; day <= 365; day += 7)
      await covered(INBOX, "main", day * DAY_H + 24, day * DAY_H, { postedHoursAgo: 0.2 });
    const source = await sourceOf(INBOX);
    // Neither the import's rows nor rows posted more than a day after they ended are posts of the collector's own.
    expect(source.threshold).toBeNull();
    expect(source.noRhythm).toMatchObject({ updates: 0 });
  });
});

describe("planInputs for a source with nothing to judge it by", () => {
  it("is incomplete for a message source that posts messages but no coverage or heartbeat and has no threshold", async () => {
    await message(INBOX, 2);
    const { planInputs } = await report();
    expect(planInputs).toMatchObject({ complete: false, behind: [{ source: INBOX, state: "unchecked" }] });
    expect(planInputs!.sentence).toContain("must post a coverage row");
  });
});

describe("scopes, holes and thresholds", () => {
  it("reads the source only as far as its slowest scope and reports each scope's high-water mark", async () => {
    await hourly(INBOX, "work", 1, 40);
    await hourly(INBOX, "home", 20, 21);
    const source = await sourceOf(INBOX);
    expect(source.coverage!.coveredTo).toBe(ago(20).toISOString());
    expect(source.freshness).toBe("stale");
    const health = await readHealth(sql as never, { now: NOW, entries: [entryFor(INBOX, "Demo inbox")], cache: false });
    expect(health.nodes[INBOX]!.coverage!.scopes).toEqual([
      { scope: "home", coveredTo: ago(20).toISOString(), holes14d: 0 },
      { scope: "work", coveredTo: ago(1).toISOString(), holes14d: 0 }
    ]);
  });

  it("no longer holds the source back for a scope that stopped reporting long ago", async () => {
    await hourly(INBOX, "work", 1, 40);
    await covered(INBOX, "old", 24 * 60, 24 * 59);
    const source = await sourceOf(INBOX);
    expect(source.coverage!.coveredTo).toBe(ago(1).toISOString());
    expect(source.freshness).toBe("fresh");
  });

  it("counts windows nobody claimed in the last 14 days as holes", async () => {
    await covered(INBOX, "main", 30, 20);
    await covered(INBOX, "main", 15, 1);
    const source = await sourceOf(INBOX);
    expect(source.coverage!.holes14d).toBe(1);
  });

  it("takes a late-for-a-scope high-water mark from a window older than the detail range", async () => {
    await covered(INBOX, "main", 24 * 60, 24 * 50);
    const source = await sourceOf(INBOX);
    expect(source.coverage!.coveredTo).toBe(ago(24 * 50).toISOString());
    // One post is no rhythm: nothing is judged late against a number nobody gave.
    expect(source.freshness).toBe("n/a");
  });

  it("uses the cadence the collector declares, 3 x expectedEveryMinutes, late at T and stale at 2T", async () => {
    await covered(PAGER, "main", 10, 1.5);
    await heartbeat(PAGER, 0.2, "ok");
    const source = await sourceOf(PAGER);
    // 3 x 20 min = 1 h warning, 2 h error: read up to 1.5 h ago is late.
    expect(source.threshold).toMatchObject({ warnHours: 1, errorHours: 2, from: "collector" });
    expect(source.freshness).toBe("late");
  });
});

describe("each source's own rhythm", () => {
  const weeklyEnds = (count: number, lastDaysAgo = 0) =>
    Array.from({ length: count }, (_, index) => (lastDaysAgo + 7 * index) * DAY_H);
  const at = (lastDaysAgo: number, count = 13) => postsAt(INBOX, "main", weeklyEnds(count, lastDaysAgo));

  it("a weekly roster of 13 posts: fresh at 9 days, late at 22, stale at 43", async () => {
    const states: string[] = [];
    for (const days of [9, 22, 43]) {
      resetHealthCache();
      await sql`DELETE FROM activity_events WHERE kind = 'coverage'`;
      await at(days);
      const source = await sourceOf(INBOX);
      expect(source.threshold).toMatchObject({ from: "learned", warnHours: 504, errorHours: 1008 });
      states.push(source.freshness);
    }
    expect(states).toEqual(["fresh", "late", "stale"]);
  });

  it("the same roster with only 7 posts is provisional, so it degrades and never blocks", async () => {
    await at(43, 7);
    const source = await sourceOf(INBOX);
    expect(source.threshold).toMatchObject({ from: "provisional" });
    expect(source.freshness).toBe("stale");
    expect((await itemsFor(INBOX))[0]!.tier).toBe("degrading");
  });

  it("a pinger every minute: late 6 minutes after the last post, stale at 11", async () => {
    const ends = Array.from({ length: 25 * 60 + 1 }, (_, index) => 6 / 60 + index / 60);
    await postsAt(INBOX, "main", ends);
    expect((await sourceOf(INBOX)).threshold).toMatchObject({
      from: "learned",
      warnHours: 5 / 60,
      errorHours: 10 / 60
    });
    expect((await sourceOf(INBOX)).freshness).toBe("late");
    resetHealthCache();
    await sql`DELETE FROM activity_events WHERE kind = 'coverage'`;
    await postsAt(
      INBOX,
      "main",
      ends.map((end) => end + 5 / 60)
    );
    expect((await sourceOf(INBOX)).freshness).toBe("stale");
  });

  it("a pinger every 10 minutes is judged against a 30-minute limit", async () => {
    await postsAt(
      INBOX,
      "main",
      Array.from({ length: 24 * 6 + 2 }, (_, index) => 0.1 + index / 6)
    );
    expect((await sourceOf(INBOX)).threshold).toMatchObject({ warnHours: 0.5, errorHours: 1 });
  });

  it("with no cadence known there is no number: 1 or 2 posts are informational and 3 give a limit that cannot block", async () => {
    await postsAt(INBOX, "main", [200, 100]);
    const young = await sourceOf(INBOX);
    expect(young).toMatchObject({ freshness: "n/a", threshold: null, noRhythm: { updates: 2, gaps: 1 } });
    expect(await itemsFor(INBOX)).toEqual([]);
    const { planInputs } = await report();
    expect(planInputs!.behind).toEqual([]);
    expect(planInputs!.complete).toBe(true);
    expect(planInputs!.note).toContain("Demo inbox reports 2 updates and has no rhythm yet");
    expect(planInputs!.note).toContain("`rhen sources covfx-inbox`");
    resetHealthCache();
    await postsAt(INBOX, "main", [300]);
    const three = await sourceOf(INBOX);
    expect(three.threshold).toMatchObject({ from: "provisional" });
    expect(three.noRhythm).toBeUndefined();
    expect((await itemsFor(INBOX)).every((item) => item.tier !== "blocking")).toBe(true);
  });

  it("a collector's clock 10 minutes behind or ahead is not permanently late or fresh", async () => {
    for (const skew of [10 / 60, -10 / 60]) {
      resetHealthCache();
      await sql`DELETE FROM activity_events WHERE kind = 'coverage'`;
      await postsAt(
        INBOX,
        "main",
        Array.from({ length: 30 }, (_, index) => 1 + index),
        skew
      );
      expect((await sourceOf(INBOX)).freshness).toBe("fresh");
      resetHealthCache();
      await sql`DELETE FROM activity_events WHERE kind = 'coverage'`;
      await postsAt(
        INBOX,
        "main",
        Array.from({ length: 30 }, (_, index) => 3.2 + index),
        skew
      );
      expect((await sourceOf(INBOX)).freshness).toBe("late");
    }
  });

  it("20 daily posts then silence: late at day 3, stale at day 6, blocking with changesPlan, degrading and retired from day 18", async () => {
    const days = async (since: number) => {
      resetHealthCache();
      await sql`DELETE FROM activity_events WHERE kind = 'coverage'`;
      await postsAt(
        INBOX,
        "main",
        Array.from({ length: 20 }, (_, index) => (since + index) * DAY_H)
      );
      return { source: await sourceOf(INBOX), items: await itemsFor(INBOX) };
    };
    expect((await days(2)).source.freshness).toBe("fresh");
    expect((await days(3.5)).source.freshness).toBe("late");
    const stale = await days(7);
    expect(stale.source.freshness).toBe("stale");
    expect(stale.items[0]).toMatchObject({ tier: "blocking" });
    const gone = await days(19);
    expect(gone.items[0]).toMatchObject({ tier: "degrading" });
    expect(gone.items[0]!.why).toContain("probably been retired");
    expect((await report()).planInputs!.behind).toEqual([]);
  });

  it("a declared cadence holds a degraded collector to 4 x its limit", async () => {
    // Declared every 20 minutes (T = 1 h) but now posting every 2 days: learned T is 6 days, capped at 4 h.
    await postsAt(
      PAGER,
      "main",
      Array.from({ length: 20 }, (_, index) => 9 + index * 48)
    );
    const source = await sourceOf(PAGER);
    expect(source.threshold).toMatchObject({ from: "collector", warnHours: 4, errorHours: 8, observedWarnHours: 144 });
    expect(source.freshness).toBe("stale");
    expect((await itemsFor(PAGER))[0]!.tier).toBe("blocking");
  });

  it("the owner's expectation sets the limit from day one, follows a change, and clearing it returns to learning", async () => {
    await postsAt(
      INBOX,
      "main",
      Array.from({ length: 30 }, (_, index) => 30 + index * 24)
    );
    expect((await sourceOf(INBOX)).threshold).toMatchObject({ from: "learned", warnHours: 72 });
    await setActivitySourceSettings(sql as never, INBOX, { expectedEveryMinutes: 7 * 24 * 60 });
    resetHealthCache();
    const weekly = await sourceOf(INBOX);
    expect(weekly.threshold).toMatchObject({
      from: "owner",
      warnHours: 504,
      errorHours: 1008,
      expectedEveryMinutes: 10_080
    });
    expect(weekly.freshness).toBe("fresh");
    await setActivitySourceSettings(sql as never, INBOX, { contentEnabled: true });
    resetHealthCache();
    expect((await sourceOf(INBOX)).threshold?.from).toBe("owner");
    await setActivitySourceSettings(sql as never, INBOX, { expectedEveryMinutes: null });
    resetHealthCache();
    expect((await sourceOf(INBOX)).threshold?.from).toBe("learned");
  });

  it("an owner expectation gives a source with a single post a real limit", async () => {
    await postsAt(INBOX, "main", [150]);
    await setActivitySourceSettings(sql as never, INBOX, { expectedEveryMinutes: 24 * 60 });
    const source = await sourceOf(INBOX);
    expect(source.threshold).toMatchObject({ from: "owner", warnHours: 72, errorHours: 144 });
    expect(source.freshness).toBe("stale");
    expect((await itemsFor(INBOX))[0]!.tier).toBe("blocking");
  });

  it("legacy mail stays out of what the plan is behind on until its collector reports coverage", async () => {
    await message(LEGACY, 2);
    const before = await sourceOf(LEGACY);
    expect(before.changesPlan).toBeUndefined();
    const first = (await report()).planInputs!;
    expect(first.behind).toEqual([]);
    expect(first.note).toContain("Not covered by this statement: Legacy inbox");
    resetHealthCache();
    await hourly(LEGACY, "main", 7);
    const after = await sourceOf(LEGACY);
    expect(after.changesPlan).toBe(true);
    expect((await report()).planInputs!.behind).toMatchObject([{ source: LEGACY, state: "stale" }]);
  });
});

describe("messages collected against messages decided", () => {
  it("reports the gap and the end states from the recorded runs, leaving the owner's own mail out of collected", async () => {
    for (let i = 0; i < 6; i += 1) await message(INBOX, 2 + i);
    await message(INBOX, 3, { fromSelf: true });
    await message(INBOX, 24 * 40);
    await processingRun(INBOX, 5, {
      endStates: { applied: 1, duplicate: 0, asked: 1, no_effect: 1, unresolved: 0 },
      noEffectReasons: { newsletter: 1 }
    });
    await processingRun(INBOX, 4, { not: "a processing summary" });
    const { processing } = await report();
    expect(processing).toHaveLength(1);
    expect(processing![0]).toMatchObject({
      source: INBOX,
      name: "Demo inbox",
      windowDays: 30,
      collected: 6,
      runs: 2,
      unreadableRuns: 1,
      processed: 3,
      gap: 3,
      byEndState: { applied: 1, asked: 1, no_effect: 1 },
      noEffectReasons: [{ reason: "newsletter", count: 1 }]
    });
  });

  it("says no run is recorded when messages were collected and nothing processed them", async () => {
    await message(INBOX, 2);
    const { processing } = await report();
    expect(processing![0]).toMatchObject({ collected: 1, runs: 0, processed: 0, gap: 1 });
  });

  it("leaves a source with nothing collected and no run out", async () => {
    expect((await report()).processing).toBeUndefined();
  });
});
