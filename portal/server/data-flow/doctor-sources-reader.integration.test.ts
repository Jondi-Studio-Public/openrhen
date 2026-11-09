import "@/test/example-calendar-sources";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readDoctorReport } from "@/server/persistence/postgres/doctor";
import { registerContractsExtension } from "@openrhen/contracts";
import { resetHealthCache } from "./health-reader";
import { readSourcesSlice } from "./doctor-sources-reader";

/** The doctor's source checks end to end: the registry, the health probes and the report, against seeded rows. */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_doctor_sources");
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

async function event(source: string, kind: string, hoursAgo: number) {
  await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, ingested_at)
    VALUES (${userId}, ${source}, ${kind}, ${crypto.randomUUID()}, ${ago(hoursAgo)}, ${ago(hoursAgo)})`;
}
async function run(provider: string, status: string, hoursAgo: number, summary: object = {}) {
  await sql`INSERT INTO integration_sync_runs (user_id, provider, trigger, started_at, finished_at, status, summary)
    VALUES (${userId}, ${provider}, 'manual', ${ago(hoursAgo)}, ${ago(hoursAgo)}, ${status}, ${sql.json(summary as never)})`;
}
const report = () => readDoctorReport(sql as never, { now: NOW });
const sourceChecks = [
  "source_late",
  "source_silent",
  "device_silent",
  "probe_unresolved",
  "token_not_bound",
  "sources_collecting_unused",
  "import_needs_review"
];
/** The ids of the report's items for these checks only; rows that nothing reads also raise the tidy unused summary. */
const idsOf = async (...wanted: string[]) =>
  (await report()).items.filter((item) => wanted.includes(item.check)).map((item) => item.id);
const sourceItems = async () => (await report()).items.filter((item) => sourceChecks.includes(item.check));

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
  await sql`INSERT INTO integration_sync_runs (user_id,provider,trigger,started_at,finished_at,status,summary)
    VALUES (${userId},'backup','scheduled',${NOW.toISOString()},${NOW.toISOString()},'synced','{}'::jsonb)`;
});

afterAll(async () => {
  await sql?.end();
});

describe("doctor source checks", () => {
  it("raises nothing on a database with no data in it", async () => {
    expect(await sourceItems()).toEqual([]);
    expect((await report()).notChecked.map((entry) => entry.check)).not.toContain("source_late");
  });

  it("gives no item for a quiet import, and a tidy one naming the skipped rows for an import that needed review", async () => {
    await run("import:timeline", "synced", 30, { file: "timeline.zip", events: 900, skipped: 0, rejected: 0 });
    expect(await sourceItems()).toEqual([]);
    await run("import:timeline", "needs_review", 2, { file: "timeline.zip", events: 700, skipped: 200, rejected: 12 });
    const items = await sourceItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "import_needs_review:timeline-export",
      tier: "tidy",
      check: "import_needs_review"
    });
    expect(items[0]!.title).toContain("212 rows");
  });

  it("stops naming an import once a later run of it is clean", async () => {
    await run("import:timeline", "needs_review", 30, { skipped: 5, rejected: 0 });
    await run("import:timeline", "synced", 2, { skipped: 0, rejected: 0 });
    expect(await sourceItems()).toEqual([]);
  });

  it("gives one item for a silent device and none for its separate feeds", async () => {
    for (let i = 0; i < 3; i += 1) {
      await event("iphone-shortcuts", "arrive", 120 + i);
      await event("iphone-health", "daily-summary", 120 + i);
    }
    expect(await idsOf("device_silent", "source_late")).toEqual(["device_silent:phone"]);
    const items = await sourceItems();
    const item = items.find((candidate) => candidate.check === "device_silent")!;
    expect(item).toMatchObject({ tier: "degrading", area: "integrations" });
    expect(item.title).toContain("phone");
    expect((await report()).sources?.line).toContain("1 device silent");
  });

  it("names the one feed that stopped while the device is still heard from", async () => {
    await event("iphone-shortcuts", "arrive", 120);
    await event("iphone-health", "daily-summary", 2);
    expect(await idsOf("device_silent", "source_late")).toEqual(["source_late:iphone-shortcuts"]);
  });

  it("does not ask the owner to bind a token when no extension can", async () => {
    await event("iphone-shortcuts", "arrive", 2);
    const slice = await readSourcesSlice(sql as never, NOW);
    expect(slice.issues.filter((issue) => issue.code === "token_not_bound")).toEqual([]);
  });

  it("summarises rows a feed sent this week that nothing uses in one tidy item", async () => {
    for (let i = 0; i < 5; i += 1) await event("rhen-watch", "app-focus", 5 + i);
    const items = await sourceItems();
    expect(items.map((item) => item.id)).toEqual(["sources_collecting_unused"]);
    expect(items[0]).toMatchObject({ tier: "tidy", area: "integrations" });
    expect(items[0]!.title).toContain("PC activity agent");
    expect(items[0]!.title).toContain("5 rows");
  });

  it("raises nothing for a one-off archive, however fresh the import", async () => {
    for (let i = 0; i < 5; i += 1) await event("timeline", "place_visit", 2);
    await run("import:timeline", "synced", 2, { skipped: 0, rejected: 0 });
    expect(await sourceItems()).toEqual([]);
    expect((await report()).sources?.line).toContain("collected, unused");
  });

  it("writes nothing: it runs inside a read-only transaction", async () => {
    await event("iphone-shortcuts", "arrive", 120);
    const before = await sql`SELECT count(*)::int AS n FROM integration_sync_runs`;
    await sql.begin("read only", async (tx) => {
      const slice = await readSourcesSlice(tx as never, NOW);
      expect(slice.sources.length).toBeGreaterThan(0);
    });
    expect(await sql`SELECT count(*)::int AS n FROM integration_sync_runs`).toEqual(before);
  });

  it("lists the source checks as not run when the probes fail, and still answers the rest", async () => {
    const broken = new Proxy(sql, {
      get(target, property, receiver) {
        if (property === "reserve") return () => Promise.reject(new Error("probe connection refused"));
        return Reflect.get(target, property, receiver);
      },
      apply(target, thisArg, args) {
        return Reflect.apply(target as never, thisArg, args);
      }
    });
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => void logged.push(String(line)));
    onTestFinished(() => spy.mockRestore());
    const result = await readDoctorReport(broken as never, { now: NOW });
    const note = result.notChecked.find((entry) => entry.check === "source_late");
    expect(note?.reason).not.toContain("probe connection refused");
    expect(logged.join("\n")).toContain("Doctor source health probes failed");
    expect(logged.join("\n")).not.toContain("probe connection refused");
    expect(note?.reason).toContain("rhen sources --problems");
    expect(result.items.filter((item) => sourceChecks.includes(item.check))).toEqual([]);
  });
});

describe("with an extension that binds tokens", () => {
  beforeAll(() => {
    registerContractsExtension({
      id: "doctor-sources-fixture",
      dataFlow: () => ({ amend: { "rhen-watch": { tokenName: "watch" }, "iphone-shortcuts": { tokenName: "phone" } } })
    });
  });
  const token = (name: string, usedHoursAgo: number | null) =>
    sql`INSERT INTO agent_tokens (user_id, name, token_hash, expires_at, last_used_at)
      VALUES (${userId}, ${name}, ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, ${ago(-1000)}, ${usedHoursAgo === null ? null : ago(usedHoursAgo)})`;

  it("raises source_silent for a live token that has never been used, and not for one that was never made", async () => {
    await token("watch", 1);
    await token("phone", 1);
    await sql`UPDATE agent_tokens SET last_used_at = NULL WHERE name = 'watch'`;
    expect(await idsOf("source_silent", "probe_unresolved")).toEqual(["source_silent:rhen-watch"]);
    const item = (await sourceItems()).find((candidate) => candidate.check === "source_silent")!;
    expect(item).toMatchObject({ tier: "degrading", area: "integrations" });
    expect(item.fix.question).toContain("token");
  });

  it("names a bound token that no live token matches as probe_unresolved, fixable by an agent", async () => {
    await token("watch", 1);
    const item = (await sourceItems()).find((candidate) => candidate.id === "probe_unresolved:iphone-shortcuts")!;
    expect(item).toMatchObject({ tier: "degrading", fix: { who: "agent", cli: "rhen sources iphone-shortcuts" } });
    expect(item.fix.next).toContain("phone");
  });

  it("raises token_not_bound as a tidy agent item once an extension can bind it", async () => {
    await token("watch", 1);
    await token("phone", 1);
    await event("iphone-health", "daily-summary", 2);
    const item = (await sourceItems()).find((candidate) => candidate.id === "token_not_bound:iphone-health")!;
    expect(item).toMatchObject({ tier: "tidy", fix: { who: "agent" } });
    expect(item.fix.next).toContain("tokenName");
  });

  it("calls the phone silent when its bound feeds have all gone quiet", async () => {
    await token("watch", 1);
    await token("phone", 120);
    await event("iphone-health", "daily-summary", 120);
    expect(await idsOf("device_silent", "source_late")).toEqual(["device_silent:phone"]);
  });
});
