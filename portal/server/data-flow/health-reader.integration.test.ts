import "@/test/example-calendar-sources";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { dataFlowRegistry, type FlowEntry } from "@openrhen/contracts/data-flow";
import { doctorSyncCadence, withoutContractsExtensions } from "@openrhen/contracts";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { fromRuns, readHealth, resetHealthCache } from "./health-reader";

/** The health reader, one probe kind at a time, against seeded rows. */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_health_reader");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const NOW = new Date("2026-10-18T12:00:00Z");
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

const entry = (id: string, health: FlowEntry["health"], extra: Partial<FlowEntry> = {}): FlowEntry => ({
  id,
  name: id,
  role: "source",
  category: "manual",
  method: "api-pull",
  trigger: { kind: "none" },
  code: {},
  from: [],
  to: [],
  health,
  owner: "core",
  ...extra
});
const one = async (e: FlowEntry) =>
  (await readHealth(sql as never, { now: NOW, entries: [e], cache: false })).nodes[e.id]!;
const fresh = { warnAfterHours: 10, errorAfterHours: 20 };

async function run(provider: string, status: string, hoursAgo: number, summary: object = {}) {
  await sql`INSERT INTO integration_sync_runs (user_id, provider, trigger, started_at, finished_at, status, summary)
    VALUES (${userId}, ${provider}, 'scheduled', ${ago(hoursAgo)}, ${ago(hoursAgo)}, ${status}, ${sql.json(summary as never)})`;
}
async function event(source: string, kind: string, hoursAgo: number, key = crypto.randomUUID()) {
  await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, ingested_at)
    VALUES (${userId}, ${source}, ${kind}, ${key}, ${ago(hoursAgo)}, ${ago(hoursAgo)})`;
}

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
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  resetHealthCache();
  await sql.unsafe(
    "TRUNCATE TABLE integration_sync_runs, activity_events, activity_imports, extractor_state, provider_call_telemetry, agent_tokens RESTART IDENTITY CASCADE"
  );
  await sql`UPDATE user_preferences SET device_location_state = '{"observations":[],"suggestion":null}'::jsonb WHERE user_id = ${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

describe("sync-runs", () => {
  it("is fresh, late, stale by the entry's thresholds, counting needs_review as a success", async () => {
    const probe = { kind: "sync-runs", provider: "p" } as const;
    await run("p", "needs_review", 5);
    expect(await one(entry("a", probe, { freshness: fresh }))).toMatchObject({ freshness: "fresh", configured: true });
    await sql`TRUNCATE integration_sync_runs`;
    await run("p", "synced", 12);
    expect((await one(entry("a", probe, { freshness: fresh }))).freshness).toBe("late");
    await sql`TRUNCATE integration_sync_runs`;
    await run("p", "synced", 30);
    expect((await one(entry("a", probe, { freshness: fresh }))).freshness).toBe("stale");
  });

  it("is failing when the newest run failed, with its message, and never when no run exists", async () => {
    const probe = { kind: "sync-runs", provider: "p" } as const;
    await run("p", "synced", 8);
    await run("p", "failed", 2, { error: "x".repeat(300) });
    const node = await one(entry("a", probe, { freshness: fresh }));
    expect(node.freshness).toBe("failing");
    expect(node.lastError?.message).toHaveLength(200);
    await sql`TRUNCATE integration_sync_runs`;
    expect(await one(entry("a", probe, { freshness: fresh }))).toMatchObject({ freshness: "never", configured: false });
  });

  it("separates two stages that share a provider by summaryMatch", async () => {
    await run("g", "synced", 1, { stage: "ingest" });
    await run("g", "failed", 1, { stage: "reasoning" });
    const stage = (name: string) =>
      entry(name, { kind: "sync-runs", provider: "g", summaryMatch: { stage: name } }, { freshness: fresh });
    expect((await one(stage("ingest"))).freshness).toBe("fresh");
    expect((await one(stage("reasoning"))).freshness).toBe("failing");
  });

  it("uses the connection's cadence for a pull source (hourly: warn at 3 intervals)", async () => {
    // Any provider the portal has a cadence for; the test does not care which.
    const provider = Object.keys(doctorSyncCadence())[0]!;
    await run(provider, "synced", 2);
    const pull = entry(
      "cal",
      { kind: "sync-runs", provider },
      { freshness: "from-connection", syncProvider: provider }
    );
    expect(await one(pull)).toMatchObject({ freshness: "fresh", threshold: { from: "connection" } });
  });
});

describe("sync-status", () => {
  it("is probe_unresolved when no extension reads that provider, and says what to do", async () => {
    const e = entry("s", { kind: "sync-status", provider: "nobody" });
    const result = await readHealth(sql as never, { now: NOW, entries: [e], cache: false });
    expect(result.nodes.s!.freshness).toBe("probe_unresolved");
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "probe_unresolved", entryId: "s", tier: "degrading" })
    ]);
    expect(result.issues[0]!.next).toMatch(/Register an extension/);
  });
});

describe("activity", () => {
  const probe = { kind: "activity", source: "push-feed" } as const;
  const push = (extra: Partial<FlowEntry> = {}) =>
    entry("push-feed", probe, {
      method: "push",
      activitySource: "push-feed",
      device: "phone",
      coldStart: { warnAfterHours: 24, errorAfterHours: 72 },
      ...extra
    });

  it("counts 24 h and 7 d arrivals, lists the kinds seen, and uses the cold-start numbers", async () => {
    await event("push-feed", "arrive", 2);
    await event("push-feed", "leave", 50);
    await event("push-feed", "leave", 400);
    await event("other", "x", 1);
    const node = await one(push());
    expect(node).toMatchObject({
      freshness: "fresh",
      count24h: 1,
      count7d: 2,
      configured: true,
      threshold: { warnHours: 24, errorHours: 72, from: "default" }
    });
    expect(node.kindsSeen).toEqual(["arrive", "leave"]);
  });

  it("goes late then stale past the cold-start numbers", async () => {
    await event("push-feed", "arrive", 30);
    expect((await one(push())).freshness).toBe("late");
    await sql`DELETE FROM activity_events`;
    await event("push-feed", "arrive", 80);
    expect((await one(push())).freshness).toBe("stale");
  });

  it("is not set up before its partition has ever held a row", async () => {
    expect(await one(push())).toMatchObject({ freshness: "never", configured: false });
  });

  it("learns the threshold from 30 days of arrivals", async () => {
    for (let i = 0; i < 160; i++) await event("push-feed", "arrive", 1 + i * 6);
    const node = await one(push());
    expect(node.threshold).toMatchObject({ from: "learned", warnHours: 9, errorHours: 18 });
  });

  it("is failing when the newest rejected batch (an ingest run) is newer than the last row", async () => {
    await event("push-feed", "arrive", 5);
    await run("ingest:push-feed", "failed", 1, { error: "bad batch" });
    const node = await one(push());
    expect(node.freshness).toBe("failing");
    expect(node.lastError?.message).toBe("bad batch");
  });

  it("is n/a with the age shown for a file import", async () => {
    await event("fit", "steps", 100);
    const node = await one(
      entry("fit-export", { kind: "activity", source: "fit" }, { method: "file-import", activitySource: "fit" })
    );
    expect(node).toMatchObject({ freshness: "n/a", configured: true });
    expect(node.lastSuccessAt).toBe(ago(100).toISOString());
  });
});

describe("extractor", () => {
  it("reads the active extractor's last success and error", async () => {
    await sql`INSERT INTO extractor_state (user_id, extractor, version, last_ok_at, last_error, active)
      VALUES (${userId}, 'msg-class', '1', ${ago(3)}, 'boom', true)`;
    const e = entry("x", { kind: "extractor", name: "msg-class" }, { freshness: fresh });
    expect(await one(e)).toMatchObject({ freshness: "fresh", lastError: { message: "boom" } });
    expect((await one(entry("y", { kind: "extractor", name: "absent" }, { freshness: fresh }))).freshness).toBe(
      "never"
    );
  });
});

describe("telemetry", () => {
  it("reads the last success and failure of the provider over 7 days", async () => {
    await sql`INSERT INTO provider_call_telemetry (provider, operation, kind, started_at, ok, error_summary)
      VALUES ('provider-a','geocode','real_call',${ago(4)},true,NULL),('provider-a','route','real_call',${ago(1)},false,'quota')`;
    const e = entry("t", { kind: "telemetry", name: "provider-a" }, { freshness: fresh });
    expect(await one(e)).toMatchObject({ freshness: "failing", lastError: { message: "quota" } });
    expect((await one(entry("t2", { kind: "telemetry", name: "none-yet" }, { freshness: fresh }))).freshness).toBe(
      "never"
    );
  });
});

describe("max", () => {
  it("reads the maximum of a column, with an equality filter", async () => {
    await run("m1", "synced", 3);
    await run("m2", "failed", 1);
    const e = (where: Record<string, string>) =>
      entry("m", { kind: "max", table: "integration_sync_runs", column: "started_at", where }, { freshness: fresh });
    expect((await one(e({ status: "synced" }))).lastSuccessAt).toBe(ago(3).toISOString());
    expect((await one(e({ status: "failed" }))).lastSuccessAt).toBe(ago(1).toISOString());
  });

  it("is probe_unresolved for a column that does not exist, and for an unsafe identifier", async () => {
    const bad = entry("b", { kind: "max", table: "integration_sync_runs", column: "nope" });
    expect((await one(bad)).freshness).toBe("probe_unresolved");
    const unsafe = entry("u", { kind: "max", table: "integration_sync_runs; DROP TABLE users", column: "started_at" });
    expect((await one(unsafe)).freshness).toBe("probe_unresolved");
    expect((await sql`SELECT count(*)::int AS n FROM users`)[0]!.n).toBeGreaterThan(0);
  });
});

describe("last-used", () => {
  const token = async (name: string, hoursAgo: number | null, revoked = false) =>
    sql`INSERT INTO agent_tokens (user_id, name, token_hash, expires_at, last_used_at, revoked_at)
      VALUES (${userId}, ${name}, ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, ${ago(-1000)}, ${hoursAgo === null ? null : ago(hoursAgo)}, ${revoked ? ago(1) : null})`;
  const probe = (tokenName?: string) =>
    ({ kind: "last-used", table: "agent_tokens", ...(tokenName ? { tokenName } : {}) }) as const;

  it("reads the named token's last use", async () => {
    await token("device-token", 5);
    expect(await one(entry("p", probe("device-token"), { freshness: fresh }))).toMatchObject({
      freshness: "fresh",
      configured: true
    });
  });

  it("is probe_unresolved when the name matches no live token", async () => {
    await token("device-token", 5, true);
    const result = await readHealth(sql as never, {
      now: NOW,
      entries: [entry("p", probe("device-token"), { freshness: fresh })],
      cache: false
    });
    expect(result.nodes.p!.freshness).toBe("probe_unresolved");
    expect(result.issues[0]).toMatchObject({ code: "probe_unresolved", entryId: "p" });
    expect(result.issues[0]!.next).toContain("device-token");
  });

  it("with no tokenName falls back to the activity probe and raises a tidy token_not_bound", async () => {
    await event("push-feed", "arrive", 2);
    const e = entry("push-feed", probe(), {
      method: "push",
      activitySource: "push-feed",
      device: "phone",
      coldStart: { warnAfterHours: 24, errorAfterHours: 72 }
    });
    const result = await readHealth(sql as never, { now: NOW, entries: [e], cache: false });
    expect(result.nodes["push-feed"]!.freshness).toBe("fresh");
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "token_not_bound", tier: "tidy", entryId: "push-feed" })
    ]);
    expect(result.issues[0]!.next).toMatch(/tokenName/);
  });
});

describe("core push entries through the real registry", () => {
  const first = () =>
    withoutContractsExtensions(() => dataFlowRegistry()).entries.find(
      (candidate) => candidate.health.kind === "last-used" && candidate.method === "push"
    )!;
  const core = () => [first()];
  const pushId = first().id;
  const coreSource = first().activitySource!;

  it("raises token_not_bound for a bare core push entry that has a row", async () => {
    await event(coreSource, "arrive", 2);
    const result = await readHealth(sql as never, { now: NOW, entries: core(), cache: false });
    expect(result.nodes[pushId]!.freshness).not.toBe("probe_unresolved");
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "token_not_bound", entryId: pushId, tier: "tidy" })
    ]);
  });

  it("raises nothing for a push source with no rows and no token", async () => {
    const result = await readHealth(sql as never, { now: NOW, entries: core(), cache: false });
    expect(result.issues).toEqual([]);
    expect(result.nodes[pushId]).toMatchObject({ configured: false, freshness: "never" });
  });

  it("reads the named token once an overlay amend binds tokenName", async () => {
    await sql`INSERT INTO agent_tokens (user_id, name, token_hash, expires_at, last_used_at)
      VALUES (${userId}, 'phone-token', ${"a".repeat(64)}, ${ago(-1000)}, ${ago(3)})`;
    // What the registry's overlay amend does to the core entry's probe (covered in contracts' data-flow.test.ts).
    const entries = core().map((candidate) => ({
      ...candidate,
      health: { kind: "last-used", table: "agent_tokens", tokenName: "phone-token" } as const
    }));
    const result = await readHealth(sql as never, { now: NOW, entries, cache: false });
    expect(result.issues).toEqual([]);
    expect(result.nodes[pushId]).toMatchObject({ configured: true, lastSuccessAt: ago(3).toISOString() });
  });
});

const firstPush = () =>
  withoutContractsExtensions(() => dataFlowRegistry()).entries.find(
    (candidate) => candidate.health.kind === "last-used" && candidate.method === "push"
  )!;
const coreSourceOf = () => firstPush().activitySource!;

describe("probe_unresolved next steps", () => {
  it("gives a permanent query error the entry-edit step, not a retry", async () => {
    const bad = entry("q", {
      kind: "max",
      table: "integration_sync_runs",
      column: "started_at",
      where: { started_at: "soon" }
    });
    const result = await readHealth(sql as never, { now: NOW, entries: [bad], cache: false });
    expect(result.issues[0]).toMatchObject({ code: "probe_unresolved" });
    expect(result.issues[0]!.next).toContain("platform/contracts/src/data-flow/entries");
    expect(result.issues[0]!.next).not.toMatch(/retry/i);
  });

  it("tells a connection or timeout failure to retry, naming rhen doctor, and does not cache it", async () => {
    let fail = true;
    const flaky = new Proxy(sql, {
      apply(target, thisArg, args: unknown[]) {
        const text = Array.isArray(args[0]) ? (args[0] as string[]).join("?") : "";
        if (fail && text.includes("max("))
          return Promise.reject(
            Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })
          );
        return Reflect.apply(target, thisArg, args);
      }
    });
    const e = entry("q", { kind: "max", table: "integration_sync_runs", column: "started_at" }, { freshness: fresh });
    const first = await readHealth(flaky as never, { now: NOW, entries: [e] });
    expect(first.nodes.q!.freshness).toBe("probe_unresolved");
    expect(first.issues[0]!.next).toMatch(/retry/i);
    expect(first.issues[0]!.next).toContain("rhen doctor");
    expect(first.issues[0]!.next).toContain("rhen sources --problems");
    fail = false;
    await run("p", "synced", 1);
    const second = await readHealth(flaky as never, { now: NOW, entries: [e] });
    expect(second.nodes.q!.freshness).toBe("fresh");
  });

  it("names the extension's entries file for an extension-owned entry", async () => {
    const bad = entry("x", { kind: "max", table: "integration_sync_runs", column: "nope" }, { owner: "acme-ext" });
    const result = await readHealth(sql as never, { now: NOW, entries: [bad], cache: false });
    expect(result.issues[0]!.next).toContain("acme-ext");
    expect(result.issues[0]!.next).not.toContain("platform/contracts");
  });

  it("tells token_not_bound how to find the token name", async () => {
    await event(coreSourceOf(), "arrive", 2);
    const result = await readHealth(sql as never, { now: NOW, entries: [firstPush()], cache: false });
    expect(result.issues[0]!.next).toContain("rhen agent-token list");
  });

  it("says a missing token is revoked or expired", async () => {
    const e = entry("t", { kind: "last-used", table: "agent_tokens", tokenName: "gone" }, { freshness: fresh });
    const result = await readHealth(sql as never, { now: NOW, entries: [e], cache: false });
    expect(result.issues[0]!.next).toContain("revoked or expired");
  });
});

describe("activity newest-row lookup", () => {
  it("returns each source's own newest row, and none for a source without rows", async () => {
    await event("s1", "k", 9);
    await event("s1", "k", 4);
    await event("s2", "k", 30);
    const entries = ["s1", "s2", "s3"].map((s) => entry(s, { kind: "activity", source: s }, { freshness: fresh }));
    const result = await readHealth(sql as never, { now: NOW, entries, cache: false });
    expect(result.nodes.s1!.lastSuccessAt).toBe(ago(4).toISOString());
    expect(result.nodes.s2!.lastSuccessAt).toBe(ago(30).toISOString());
    expect(result.nodes.s3).toMatchObject({ configured: false, lastSuccessAt: null });
  });
});

describe("review follow-ups", () => {
  it("keeps the learned threshold for a push source judged by a bound token", async () => {
    await sql`INSERT INTO agent_tokens (user_id, name, token_hash, expires_at, last_used_at)
      VALUES (${userId}, 'device-token', ${"b".repeat(64)}, ${ago(-1000)}, ${ago(2)})`;
    for (let i = 0; i < 160; i++) await event("push-feed", "arrive", 1 + i * 6);
    const e = entry(
      "push-feed",
      { kind: "last-used", table: "agent_tokens", tokenName: "device-token" },
      {
        method: "push",
        activitySource: "push-feed"
      }
    );
    expect((await one(e)).threshold).toMatchObject({ from: "learned", warnHours: 9 });
  });

  it("prefetches the probes nested under lag, whatever their kind", async () => {
    await event("lag-src", "x", 1);
    await sql`INSERT INTO extractor_state (user_id, extractor, version, last_ok_at, active)
      VALUES (${userId}, 'lag-ex', '1', ${ago(10)}, true)`;
    const lag = entry(
      "l",
      {
        kind: "lag",
        upstream: { kind: "activity", source: "lag-src" },
        downstream: { kind: "extractor", name: "lag-ex" },
        allowHours: 4
      },
      { freshness: fresh }
    );
    const node = await one(lag);
    expect(node.freshness).toBe("late");
    expect(node.note).toMatch(/trails/);
  });

  it("takes the newer of the last row and the last import", async () => {
    await event("imp", "k", 50);
    await sql`INSERT INTO activity_imports (user_id, source, filename, sha256, imported_at) VALUES (${userId}, 'imp', 'f.json', 'abc', ${ago(2)})`;
    const node = await one(
      entry("i", { kind: "activity", source: "imp" }, { activitySource: "imp", freshness: fresh })
    );
    expect(node.lastSuccessAt).toBe(ago(2).toISOString());
  });

  it("reads 14 days of provider telemetry, the longest threshold", async () => {
    await sql`INSERT INTO provider_call_telemetry (provider, operation, kind, started_at, ok, error_summary)
      VALUES ('provider-b','op','real_call',${ago(24 * 10)},true,NULL)`;
    const node = await one(entry("t", { kind: "telemetry", name: "provider-b" }, { freshness: fresh }));
    expect(node.configured).toBe(true);
  });

  it("does not make up a time for an extractor error with no success", async () => {
    await sql`INSERT INTO extractor_state (user_id, extractor, version, last_error, active)
      VALUES (${userId}, 'ex-err', '1', 'boom', true)`;
    const node = await one(entry("x", { kind: "extractor", name: "ex-err" }, { freshness: fresh }));
    expect(node.lastError).toEqual({ at: null, message: "boom" });
  });

  it("is probe_unresolved for a json stamp on a table with no user_id", async () => {
    const node = await one(
      entry("j", { kind: "json-stamp", table: "users", column: "id", path: ["x"] } as never, { freshness: fresh })
    );
    expect(node.freshness).toBe("probe_unresolved");
  });

  it("does not count a run that is not an explicit failure as a failed attempt", () => {
    const run = (status: string, hoursAgo: number) => ({
      provider: "p",
      status,
      started_at: ago(hoursAgo),
      summary: {}
    });
    const raw = fromRuns([run("running", 1), run("synced", 5)]);
    expect(raw.lastAttemptOk).not.toBe(false);
    expect(raw.lastError).toBeNull();
    expect(fromRuns([run("skipped", 1), run("synced", 5)]).lastAttemptOk).not.toBe(false);
    expect(fromRuns([run("failed", 1), run("synced", 5)]).lastAttemptOk).toBe(false);
  });

  it("reads the same sources once for two concurrent callers, and keys the cache by probe definition", async () => {
    let queries = 0;
    const counted = new Proxy(sql, {
      apply(target, thisArg, args: unknown[]) {
        queries++;
        return Reflect.apply(target, thisArg, args);
      }
    });
    const e = entry("c", { kind: "sync-runs", provider: "p" }, { freshness: fresh });
    await readHealth(counted as never, { now: NOW, entries: [e] });
    const single = queries;
    expect(single).toBeGreaterThan(0);
    await readHealth(counted as never, { now: NOW, entries: [e] });
    expect(queries).toBe(single);
    await readHealth(counted as never, { now: NOW, entries: [{ ...e, health: { kind: "sync-runs", provider: "q" } }] });
    expect(queries).toBe(single * 2);
    resetHealthCache();
    queries = 0;
    await Promise.all([
      readHealth(counted as never, { now: NOW, entries: [e] }),
      readHealth(counted as never, { now: NOW, entries: [e] })
    ]);
    expect(queries).toBe(single);
  });
});

describe("json-stamp", () => {
  const probe = {
    kind: "json-stamp",
    table: "user_preferences",
    column: "device_location_state",
    path: ["lastPhonePingAt"]
  } as const;
  it("reads a timestamp out of a json column", async () => {
    await sql`UPDATE user_preferences SET device_location_state = ${sql.json({ observations: [], suggestion: null, lastPhonePingAt: ago(10).toISOString() })} WHERE user_id = ${userId}`;
    expect(await one(entry("j", probe, { freshness: fresh }))).toMatchObject({
      freshness: "fresh",
      lastSuccessAt: ago(10).toISOString()
    });
  });
  it("is never before the first ping, and probe_unresolved when the value is no longer a time", async () => {
    expect(await one(entry("j", probe, { freshness: fresh }))).toMatchObject({ freshness: "never", configured: false });
    await sql`UPDATE user_preferences SET device_location_state = ${sql.json({ observations: [], suggestion: null, lastPhonePingAt: "soon" })} WHERE user_id = ${userId}`;
    expect((await one(entry("j", probe, { freshness: fresh }))).freshness).toBe("probe_unresolved");
    expect((await one(entry("j", { ...probe, column: "nope" }, { freshness: fresh }))).freshness).toBe(
      "probe_unresolved"
    );
  });
});

describe("lag", () => {
  it("is late when the downstream stage trails the upstream by more than allowHours", async () => {
    await run("up", "synced", 1);
    await run("down", "synced", 9);
    const lag = (allow: number) =>
      entry(
        "l",
        {
          kind: "lag",
          upstream: { kind: "sync-runs", provider: "up" },
          downstream: { kind: "sync-runs", provider: "down" },
          allowHours: allow
        },
        { freshness: fresh }
      );
    expect(await one(lag(4))).toMatchObject({ freshness: "late" });
    expect((await one(lag(12))).freshness).toBe("fresh");
  });
});

describe("none, cache and cold start", () => {
  it("is n/a for a probe that says why it has none", async () => {
    expect(await one(entry("n", { kind: "none", reason: "pass-through" }))).toMatchObject({ freshness: "n/a" });
  });

  it("caches a result for 60 s and not when asked not to", async () => {
    const e = entry("c", { kind: "sync-runs", provider: "c" }, { freshness: fresh });
    await run("c", "synced", 1);
    const first = await readHealth(sql as never, { now: NOW, entries: [e] });
    await sql`TRUNCATE integration_sync_runs`;
    const second = await readHealth(sql as never, { now: new Date(NOW.getTime() + 30_000), entries: [e] });
    expect(second.nodes.c!.freshness).toBe(first.nodes.c!.freshness);
    const later = await readHealth(sql as never, { now: new Date(NOW.getTime() + 61_000), entries: [e] });
    expect(later.nodes.c!.freshness).toBe("never");
  });

  it("reads every core entry without error (no entry is left unresolved by a typo)", async () => {
    const core = withoutExtensions();
    const result = await readHealth(sql as never, { now: NOW, entries: core, cache: false });
    expect(Object.keys(result.nodes).sort()).toEqual(core.map((e) => e.id).sort());
    expect(result.issues.filter((i) => i.code === "probe_unresolved")).toEqual([]);
  });
});

describe("no writes", () => {
  it("runs the whole core registry on a connection that refuses writes", async () => {
    const readOnly = postgres(testUrl.toString(), { max: 2, connection: { default_transaction_read_only: true } });
    try {
      await expect(
        readOnly`INSERT INTO integration_sync_runs (user_id, provider, trigger, status) VALUES (${userId}, 'x', 'manual', 'synced')`
      ).rejects.toThrow();
      const before = (
        await sql`SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM integration_sync_runs) r`
      )[0]!;
      const result = await readHealth(readOnly as never, { now: NOW, entries: withoutExtensions(), cache: false });
      expect(Object.keys(result.nodes).length).toBeGreaterThan(50);
      const after = (
        await sql`SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM integration_sync_runs) r`
      )[0]!;
      expect(after).toEqual(before);
    } finally {
      await readOnly.end();
    }
  });

  it("contains no write statement in its source", () => {
    const source = readFileSync(resolve(process.cwd(), "server/data-flow/health-reader.ts"), "utf8");
    // Whitespace, comments and string joins cannot hide a statement: compare the source with those squashed out.
    const squashed = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ");
    expect(squashed).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE|COPY\s+\S+\s+FROM|ensureUser|recordRun|\.begin\(|\.unsafe\()/i
    );
    expect(source).not.toMatch(/\bimport\s*\(/);
  });
});

function withoutExtensions(): FlowEntry[] {
  return dataFlowRegistry().entries.filter((e) => e.owner === "core" && e.planned === undefined);
}
