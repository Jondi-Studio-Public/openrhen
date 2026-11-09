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

const entryFor = (source: string, name: string): FlowEntry => ({
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
  changesPlan: true,
  health: { kind: "activity", source }
});

async function message(source: string, hoursAgo: number, extra: { from?: string; fromSelf?: boolean } = {}) {
  await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, ingested_at, attrs)
    VALUES (${userId}, ${source}, 'message', ${crypto.randomUUID()}, ${ago(hoursAgo)}, ${ago(hoursAgo)},
      ${sql.json({ from: extra.from ?? "a@x.example", ...(extra.fromSelf ? { from_self: true } : {}) })})`;
}
/** A coverage window from `fromHoursAgo` to `toHoursAgo`, posted when it ended. */
async function covered(source: string, scope: string | null, fromHoursAgo: number, toHoursAgo: number) {
  await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, ts_end, ingested_at, attrs)
    VALUES (${userId}, ${source}, 'coverage', ${crypto.randomUUID()}, ${ago(fromHoursAgo)}, ${ago(toHoursAgo)}, ${ago(toHoursAgo)},
      ${sql.json({ complete: true, ...(scope === null ? {} : { scope }) })})`;
}
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
    dataFlow: () => ({ entries: [entryFor(INBOX, "Demo inbox"), entryFor(PAGER, "Demo pager")] })
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
    "TRUNCATE TABLE integration_sync_runs, activity_events, activity_imports, extractor_state, provider_call_telemetry, agent_tokens RESTART IDENTITY CASCADE"
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
    await covered(INBOX, "main", 100, 1);
    await heartbeat(INBOX, 1, "ok");
    const source = await sourceOf(INBOX);
    expect(source).toMatchObject({ freshness: "fresh", changesPlan: true, configured: true });
    expect(source.lastSuccessAt).toBe(ago(1).toISOString());
    expect(source.coverage).toMatchObject({ coveredTo: ago(1).toISOString(), heartbeat: { status: "ok" } });
    expect(source.threshold).toMatchObject({ warnHours: 12, errorHours: 24, from: "default" });
    expect((await report()).planInputs).toEqual({ complete: true, behind: [], sentence: null, note: null });
    expect(await itemsFor(INBOX)).toEqual([]);
  });

  it("goes late at T behind and stale at 2T, alive but not reading, and blocks because the source changes the plan", async () => {
    await covered(INBOX, "main", 60, 14);
    await heartbeat(INBOX, 1, "ok");
    expect((await sourceOf(INBOX)).freshness).toBe("late");
    expect((await itemsFor(INBOX))[0]).toMatchObject({ check: "source_late", tier: "degrading" });
    resetHealthCache();
    await sql`DELETE FROM activity_events WHERE kind = 'coverage'`;
    await covered(INBOX, "main", 60, 30);
    const source = await sourceOf(INBOX);
    expect(source.freshness).toBe("stale");
    const [item] = await itemsFor(INBOX);
    expect(item).toMatchObject({ id: `source_late:${INBOX}`, tier: "blocking" });
    expect(item!.title).toContain("is read up to 2026-11-08 06:00 UTC, 30 h behind");
    expect(item!.why).toContain("alive");
    expect(item!.fix.question).toContain(`\`rhen sources ${INBOX}\``);
    const planInputs = (await report()).planInputs!;
    expect(planInputs.complete).toBe(false);
    expect(planInputs.sentence).toContain("This plan is built from messages read up to 2026-11-08 06:00 UTC");
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
    // No threshold is stated and fewer than 20 hourly buckets are learned, so there is nothing to be late against.
    expect(source).toMatchObject({ freshness: "n/a", threshold: null, lastSuccessAt: ago(2).toISOString() });
    expect(await itemsFor(INBOX)).toEqual([]);
  });
});

describe("a young collector's learned threshold", () => {
  it("does not borrow history from one 31-day backfill window: days come from when it posted, so it cannot block", async () => {
    // Day one: a 31-day backfill window, then 24 hourly windows posted over the last day, then a night of silence.
    await covered(INBOX, "main", 24 * 31 + 30, 30);
    for (let h = 29; h >= 6; h -= 1) await covered(INBOX, "main", h + 1, h);
    await heartbeat(INBOX, 6, "ok");
    const source = await sourceOf(INBOX);
    expect(source.threshold).toMatchObject({ from: "learned" });
    expect(source.threshold!.days ?? 0).toBeLessThan(30);
    expect(source.freshness).toBe("stale");
    const items = await itemsFor(INBOX);
    // Whatever the freshness, a threshold learned from a day of posts is never blocking.
    expect(items.every((item) => item.tier !== "blocking")).toBe(true);
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
    await covered(INBOX, "work", 40, 1);
    await covered(INBOX, "home", 40, 20);
    const source = await sourceOf(INBOX);
    expect(source.coverage!.coveredTo).toBe(ago(20).toISOString());
    expect(source.freshness).toBe("late");
    const health = await readHealth(sql as never, { now: NOW, entries: [entryFor(INBOX, "Demo inbox")], cache: false });
    expect(health.nodes[INBOX]!.coverage!.scopes).toEqual([
      { scope: "home", coveredTo: ago(20).toISOString(), holes14d: 0 },
      { scope: "work", coveredTo: ago(1).toISOString(), holes14d: 0 }
    ]);
  });

  it("no longer holds the source back for a scope that stopped reporting long ago", async () => {
    await covered(INBOX, "work", 40, 1);
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
    expect(source.freshness).toBe("stale");
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
