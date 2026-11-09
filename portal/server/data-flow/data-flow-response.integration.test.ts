import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { enterCoreOnly } from "@openrhen/contracts";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readDataFlow } from "./data-flow-response";
import { resetHealthCache } from "./health-reader";

/** The body of GET /api/data-flow: the graph, a health node per entry, the 2.5 unused set and the unavailable fallback. */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_data_flow_response");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
const NOW = new Date("2026-10-18T12:00:00Z");

// Core's tests of core behaviour: a composed build's extensions would add their own entries. The example calendar
// sources are test fixtures, not extensions, so they are registered after the cut-back.
let leaveCoreOnly: (() => void) | undefined;

beforeAll(async () => {
  leaveCoreOnly = enterCoreOnly();
  await import("@/test/example-calendar-sources");
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
  await ensureUser(sql);
}, 30_000);

afterAll(async () => {
  leaveCoreOnly?.();
  await sql?.end();
});

describe("GET /api/data-flow body", () => {
  it("returns the graph with a health node per present entry, against the test database", async () => {
    resetHealthCache();
    const body = await readDataFlow(sql as never, NOW);
    expect(body.generatedAt).toBe(NOW.toISOString());
    expect(["merged", "pinned"]).toContain(body.build);
    expect(body.health.unavailable).toBeUndefined();
    if (body.health.unavailable) return;
    const present = body.entries.filter((entry) => entry.planned === undefined);
    expect(Object.keys(body.health.nodes).sort()).toEqual(present.map((entry) => entry.id).sort());
    expect(body.edges.length).toBeGreaterThan(100);
    expect(body.devices.map((device) => device.id)).toEqual(expect.arrayContaining(["pc", "phone", "wearable"]));
  });

  it("counts the sources not set up under never", async () => {
    resetHealthCache();
    const body = await readDataFlow(sql as never, NOW);
    if (body.health.unavailable) throw new Error("health was unavailable");
    const never = Object.values(body.health.nodes).filter((node) => node.freshness === "never").length;
    expect(never).toBeGreaterThan(0);
    expect(body.health.counts.never).toBe(never);
  });

  it("lists the 2.5 set as unused, accepted or dead (the data `rhen sources --unused` prints)", async () => {
    const body = await readDataFlow(sql as never, NOW);
    const bySource = (bucket: string) =>
      body.unused.entries
        .filter((item) => item.bucket === bucket)
        .map((item) => body.entries.find((entry) => entry.id === item.id)?.activitySource ?? item.id)
        .sort();
    expect(bySource("unused")).toEqual(
      [
        "apple-health",
        "chrome-takeout",
        "discord-package",
        "drift",
        "drift-reason",
        "fit",
        "google-access-log",
        "google-activity",
        "google-chat",
        "google-photos",
        "maps-places",
        "spotify",
        "timeline"
      ].sort()
    );
    expect(bySource("nothing-sends")).toEqual([
      "gmail",
      "iphone-health",
      "iphone-shortcuts",
      "physiology",
      "rhen-watch",
      "steam",
      "weather"
    ]);
    expect(body.unused.datasets).toEqual(
      expect.arrayContaining(["pg:offer_log", "pg:forecast_snapshots", "pg:place_reference_photo"])
    );
    expect(body.unused.dead).toEqual(["pg:photo_checkin_stage"]);
  });

  it("answers 'Health unavailable' rather than failing when the probes cannot run", async () => {
    const broken = postgres(testUrl.toString(), { max: 1, connect_timeout: 10, fetch_types: false });
    await broken.end();
    resetHealthCache();
    const body = await readDataFlow(broken as never, NOW);
    expect(body.health).toMatchObject({
      unavailable: true,
      reason: "The health probes could not be read.",
      next: "Run `rhen doctor`, then `rhen sources --problems`."
    });
    // The raw database error stays in the server log; the body carries no driver text.
    expect(JSON.stringify(body.health)).not.toMatch(/CONNECTION_ENDED|connect|ECONN|postgres/i);
    expect(body.entries.length).toBeGreaterThan(50);
  });
});
