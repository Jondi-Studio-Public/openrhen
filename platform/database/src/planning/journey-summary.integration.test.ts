import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { journeyBand } from "@openrhen/contracts";
import { integrationDatabaseName } from "../operations/integration-database.js";
import { readJourneySummary } from "./journey-summary.js";
import { buildPlanForecastRequest } from "./plan-forecast-runtime.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
// A database of its own for the same reason every other suite in this folder has one: this suite
// truncates, and two suites truncating the same database is an unreproducible flake.
const testDatabaseName = integrationDatabaseName(
  process.env.JOURNEY_SUMMARY_TEST_DATABASE_NAME,
  "openrhen_journey_summary"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("JOURNEY_SUMMARY_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

const TIME_ZONE = "Australia/Sydney";
const DAY = 86_400_000;

let sql: postgres.Sql;
let userId: string;

beforeAll(async () => {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<
      { exists: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
    if (!existing[0]?.exists) await admin.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
  } finally {
    await admin.end();
  }
  const migrationSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  // This suite is allowed to clear only a database whose validated name ends in _test.
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (display_name, timezone) VALUES ('Journey Fixture', ${TIME_ZONE}) RETURNING id
  `;
  userId = users[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

async function insertSample(input: {
  from: string;
  to: string;
  mode?: "car" | "bike" | "walk";
  minutes: number;
  departedAt: Date;
  observedAt?: Date;
  source?: "google" | "own_trip";
}): Promise<void> {
  await sql`
    INSERT INTO journey_samples
      (user_id, origin_location_id, destination_location_id, mode, minutes, departed_at, observed_at, source)
    VALUES (
      ${userId}, ${input.from}, ${input.to}, ${input.mode ?? "car"}, ${input.minutes},
      ${input.departedAt}, ${input.observedAt ?? input.departedAt}, ${input.source ?? "google"}
    )
  `;
}

async function insertLocation(id: string, travelMinutes: number | null): Promise<void> {
  await sql`
    INSERT INTO condition_definitions (user_id, id, name, kind, travel_minutes)
    VALUES (${userId}, ${id}, ${id}, 'location', ${travelMinutes})
  `;
}

/** Nearest-rank percentile, matching Postgres's `percentile_disc` semantics, for the assertions below. */
function percentileDisc(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1]!;
}

describe("readJourneySummary", () => {
  it("derives day type and band the same way journeyBand does, across a DST change", async () => {
    // Australia/Sydney's 2026 DST changes: clocks forward on 2026-10-04 (AEST -> AEDT), back on
    // 2026-04-05 (AEDT -> AEST). Picking one sample on each side of the forward change exercises the
    // SQL `AT TIME ZONE` conversion the same way `journeyBand`'s `Intl.DateTimeFormat` conversion is
    // exercised, both reading the identical instant.
    const beforeDst = new Date("2026-10-03T20:15:00.000Z"); // 2026-10-04 07:15 AEST (weekend, band 14)
    const afterDst = new Date("2026-10-04T20:15:00.000Z"); // 2026-10-05 07:15 AEDT (weekday, band 14)

    await insertSample({ from: "home", to: "office", minutes: 20, departedAt: beforeDst });
    await insertSample({ from: "home", to: "office", minutes: 22, departedAt: afterDst });

    const summary = await readJourneySummary(sql, userId, new Date(), TIME_ZONE);
    const bandCells = summary.cells.filter((cell) => cell.band !== null);
    expect(bandCells).toHaveLength(2);

    for (const [sample, departedAt] of [
      [20, beforeDst],
      [22, afterDst]
    ] as const) {
      const expected = journeyBand(departedAt, TIME_ZONE);
      const cell = bandCells.find((c) => c.dayType === expected.dayType && c.band === expected.band);
      expect(cell, `no cell for ${expected.dayType}/${expected.band} (sample ${sample})`).toBeDefined();
      expect(cell!.pooled.count).toBe(1);
      expect(cell!.pooled.median).toBe(sample);
    }
  });

  it("matches nearest-rank percentiles on a known set of Google samples", async () => {
    const departedAt = new Date("2026-09-14T22:00:00.000Z"); // a fixed weekday morning band, seed-zone time
    const minutesSet = [10, 12, 15, 18, 20, 25, 30];
    for (const minutes of minutesSet) {
      await insertSample({ from: "home", to: "office", minutes, departedAt });
    }

    const summary = await readJourneySummary(sql, userId, new Date(), TIME_ZONE);
    const expected = journeyBand(departedAt, TIME_ZONE);
    const cell = summary.cells.find((c) => c.dayType === expected.dayType && c.band === expected.band);
    expect(cell).toBeDefined();
    expect(cell!.pooled.count).toBe(minutesSet.length);
    expect(cell!.pooled.median).toBe(percentileDisc(minutesSet, 0.5));
    expect(cell!.pooled.p80).toBe(percentileDisc(minutesSet, 0.8));
    expect(cell!.pooled.p95).toBe(percentileDisc(minutesSet, 0.95));
  });

  it("drops an own-trip outlier judged against the cell's Google median, keeps one that is not", async () => {
    const departedAt = new Date("2026-09-14T22:00:00.000Z");
    // Five Google samples clustered around 20 minutes: median 20.
    for (const minutes of [18, 19, 20, 21, 22]) {
      await insertSample({ from: "home", to: "gym", minutes, departedAt });
    }
    // Under 0.5x the median (10): an outlier, dropped from both pooled and own.
    await insertSample({ from: "home", to: "gym", minutes: 5, departedAt, source: "own_trip" });
    // A normal own trip: kept.
    await insertSample({ from: "home", to: "gym", minutes: 21, departedAt, source: "own_trip" });

    const summary = await readJourneySummary(sql, userId, new Date(), TIME_ZONE);
    const expected = journeyBand(departedAt, TIME_ZONE);
    const cell = summary.cells.find(
      (c) => c.toLocationId === "gym" && c.dayType === expected.dayType && c.band === expected.band
    );
    expect(cell).toBeDefined();
    // 5 Google + 1 kept own trip; the outlier own trip is excluded from pooled too.
    expect(cell!.pooled.count).toBe(6);
    expect(cell!.own.count).toBe(1);
    expect(cell!.own.median).toBe(21);
  });

  it("drops an own-trip outlier judged against the destination's stored minutes when the cell has no Google samples", async () => {
    await insertLocation("clinic", 30);
    const departedAt = new Date("2026-09-14T22:00:00.000Z");
    // Over 2x the stored 30 minutes (60): an outlier.
    await insertSample({ from: "home", to: "clinic", minutes: 70, departedAt, source: "own_trip" });
    // Within bounds: kept.
    await insertSample({ from: "home", to: "clinic", minutes: 32, departedAt, source: "own_trip" });

    const summary = await readJourneySummary(sql, userId, new Date(), TIME_ZONE);
    const expected = journeyBand(departedAt, TIME_ZONE);
    const cell = summary.cells.find(
      (c) => c.toLocationId === "clinic" && c.dayType === expected.dayType && c.band === expected.band
    );
    expect(cell).toBeDefined();
    expect(cell!.pooled.count).toBe(1);
    expect(cell!.own.count).toBe(1);
    expect(cell!.own.median).toBe(32);
  });

  it("aggregates the any-time cell as the union of every band cell for the same pair and mode", async () => {
    // Two distinct weekday bands (same day type), each 3 Google samples of a single value, so the
    // pooled union's own median is unambiguous by nearest rank.
    const bandA = new Date("2026-09-14T22:00:00.000Z"); // weekday morning seed-zone
    const bandB = new Date("2026-09-14T23:30:00.000Z"); // same weekday, a later band
    for (let i = 0; i < 3; i++) await insertSample({ from: "home", to: "office", minutes: 10, departedAt: bandA });
    for (let i = 0; i < 3; i++) await insertSample({ from: "home", to: "office", minutes: 30, departedAt: bandB });

    const summary = await readJourneySummary(sql, userId, new Date(), TIME_ZONE);
    const bandCells = summary.cells.filter((c) => c.toLocationId === "office" && c.band !== null);
    const anyCell = summary.cells.find((c) => c.toLocationId === "office" && c.band === null && c.dayType === null);

    expect(bandCells.length).toBe(2);
    expect(anyCell).toBeDefined();
    const allMinutes = ([10, 10, 10, 30, 30, 30] as const).slice();
    expect(anyCell!.pooled.count).toBe(allMinutes.length);
    expect(anyCell!.pooled.median).toBe(percentileDisc(allMinutes, 0.5));
    expect(anyCell!.pooled.p80).toBe(percentileDisc(allMinutes, 0.8));
    expect(anyCell!.pooled.p95).toBe(percentileDisc(allMinutes, 0.95));
  });

  it("ignores samples older than the 180-day window", async () => {
    const now = new Date("2026-09-26T00:00:00.000Z");
    const stale = new Date(now.getTime() - 200 * DAY);
    const fresh = new Date(now.getTime() - 10 * DAY);
    await insertSample({ from: "home", to: "office", minutes: 99, departedAt: stale, observedAt: stale });
    await insertSample({ from: "home", to: "office", minutes: 20, departedAt: fresh, observedAt: fresh });

    const summary = await readJourneySummary(sql, userId, now, TIME_ZONE);
    const expected = journeyBand(fresh, TIME_ZONE);
    const cell = summary.cells.find((c) => c.dayType === expected.dayType && c.band === expected.band);
    expect(cell).toBeDefined();
    expect(cell!.pooled.count).toBe(1);
    expect(cell!.pooled.median).toBe(20);

    // The stale sample also never contributes to the pair's latest-Google reading.
    const latest = summary.latest.find((l) => l.fromLocationId === "home" && l.toLocationId === "office");
    expect(latest?.minutes).toBe(20);
  });
});

/** The smallest state `portalStateSchema` accepts, mirroring `plan-forecast-engine-harness.ts`'s
 * `minimalPlanForecastRequest` fixture (not imported from there: this suite calls
 * `buildPlanForecastRequest` directly, with a real `sql`/`userId`, rather than through that harness's
 * own two-argument helper). */
function minimalState(at: Date) {
  return {
    settings: {
      timezone: TIME_ZONE,
      planningHorizonEnd: "22:00",
      defaultUsableFraction: 0.85,
      defaultSetupBufferMinutes: 10,
      defaultTransitionBufferMinutes: 10,
      submissionBufferMinutes: 60,
      submissionBufferPercent: 0.1,
      energyMeanings: { high: "High", medium: "Medium", low: "Low", recovery: "Recovery" },
      estimateBucketsMinutes: [15, 30, 60],
      preferredBedtime: "22:30",
      preferredWakeTime: "06:30",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 17
    },
    areas: [],
    outcomes: [],
    projects: [],
    actions: [],
    commitments: [],
    routineSteps: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: [],
    currentEnergy: "medium",
    horizonEnd: new Date(at.getTime() + 12 * 3_600_000).toISOString(),
    activeSession: null
  };
}

describe("buildPlanForecastRequest's journey summary", () => {
  it("fills request.journeys from the store, and a new sample changes inputVersion", async () => {
    const at = new Date("2026-09-14T22:00:00.000Z");
    const departedAt = new Date("2026-09-14T21:00:00.000Z");
    const state = minimalState(at);

    const before = await buildPlanForecastRequest(state, at, undefined, sql, userId);
    expect(before.journeys).toEqual({ cells: [], latest: [] });

    await insertSample({ from: "home", to: "office", minutes: 22, departedAt });

    const after = await buildPlanForecastRequest(state, at, undefined, sql, userId);
    expect(after.journeys.cells.length).toBeGreaterThan(0);
    expect(after.journeys.latest).toEqual([
      expect.objectContaining({ fromLocationId: "home", toLocationId: "office", minutes: 22 })
    ]);
    // Nothing about `state` moved between the two calls — only the store did — so a changed
    // `inputVersion` proves the summary itself is hashed into it, not just carried on the request.
    expect(after.inputVersion).not.toBe(before.inputVersion);
  });
});
