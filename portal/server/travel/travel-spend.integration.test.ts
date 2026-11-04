import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import type { TravelMatrixResult } from "@openrhen/contracts";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { home, shed } from "@/server/location/location-test-fixtures";

/**
 * No real Google calls: `fetchTravelMatrix` is mocked at the module boundary `spendTravelLookup`
 * calls it through, so this exercises the spender's own transaction (the reservation, the sample
 * insert, `recordStateChange`) against a real Postgres database without ever reaching the sidecar.
 */
const fetchTravelMatrixMock = vi.fn<(request: unknown) => Promise<TravelMatrixResult>>();
vi.mock("@/integrations/travel/travel-proxy-client", () => ({
  fetchTravelMatrix: (request: unknown) => fetchTravelMatrixMock(request)
}));

// Imported after the mock above so the mocked module is what travel-spend.ts resolves.
const { TRAVEL_LOOKUP_RESERVE, TravelBudgetRefusedError, readTravelLookupsRemaining, spendTravelLookup } =
  await import("./travel-spend");

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TRAVEL_SPEND_TEST_DATABASE_NAME, "openrhen_travel_spend");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TRAVEL_SPEND_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const TIMEZONE = "Australia/Sydney";

/** A one-destination matrix reply naming `minutes` for `locationId`, mirroring the proxy's own shape. */
function matrixReply(locationId: string, minutes: number, mode: "car" | "bike" | "walk" = "car"): TravelMatrixResult {
  return {
    estimates: [{ locationId, minutes, mode }],
    measurements: [{ locationId, mode, minutes }],
    unroutable: []
  };
}

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
  sql = postgres(testUrl.toString(), { max: 10, connect_timeout: 10, fetch_types: false, prepare: true });
  process.env.DATABASE_URL = testUrl.toString();
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
  await sql`
    INSERT INTO condition_definitions (user_id, id, name, kind, latitude, longitude)
    VALUES (${userId}, ${home.id}, ${home.name}, 'location', ${home.latitude}, ${home.longitude})
  `;
  await sql`
    INSERT INTO condition_definitions (user_id, id, name, kind, latitude, longitude)
    VALUES (${userId}, ${shed.id}, ${shed.name}, 'location', ${shed.latitude}, ${shed.longitude})
  `;
  fetchTravelMatrixMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await sql?.end();
});

describe("spendTravelLookup", () => {
  it("reserves, calls the proxy, stores a sample, and logs one write_rows row with a queued recalculation", async () => {
    fetchTravelMatrixMock.mockResolvedValue(matrixReply(shed.id, 14));
    const stateCapturedAt = new Date(Date.now() - 5_000);
    const departureAt = new Date();

    const result = await spendTravelLookup(sql, userId, TIMEZONE, {
      originLocationId: home.id,
      origin: { latitude: home.latitude, longitude: home.longitude },
      destinations: [{ locationId: shed.id, latitude: shed.latitude, longitude: shed.longitude }],
      mode: "car",
      departureAt
    });

    expect(result.spent).toBe(1);
    expect(result.remaining).toBe(99);
    expect(result.estimates).toEqual([{ locationId: shed.id, minutes: 14, mode: "car" }]);

    const samples = await sql<
      { origin_location_id: string; destination_location_id: string; mode: string; minutes: string; source: string }[]
    >`SELECT origin_location_id, destination_location_id, mode, minutes, source FROM journey_samples WHERE user_id=${userId}`;
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      origin_location_id: home.id,
      destination_location_id: shed.id,
      mode: "car",
      source: "google"
    });
    expect(Number(samples[0]!.minutes)).toBe(14);

    const changed = await sql<{ id: string; entity_type: string; operation: string }[]>`
      SELECT id, entity_type, operation FROM write_rows WHERE user_id=${userId} AND created_at > ${stateCapturedAt}
    `;
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ entity_type: "journey_samples", operation: "measure" });

    const jobs = await sql<{ status: string }[]>`
      SELECT status FROM jobs WHERE type='plan_forecast.recalculate.v1' AND payload->>'userId'=${userId}
    `;
    expect(jobs.some((job) => job.status === "pending")).toBe(true);
  });

  it("rolls the reservation back when the proxy call fails, spending nothing and storing nothing", async () => {
    fetchTravelMatrixMock.mockRejectedValue(new Error("The travel service returned 502."));

    await expect(
      spendTravelLookup(sql, userId, TIMEZONE, {
        originLocationId: home.id,
        origin: { latitude: home.latitude, longitude: home.longitude },
        destinations: [{ locationId: shed.id, latitude: shed.latitude, longitude: shed.longitude }],
        mode: "car",
        departureAt: new Date()
      })
    ).rejects.toThrow("The travel service returned 502.");

    const remaining = await readTravelLookupsRemaining(sql, userId, TIMEZONE);
    expect(remaining.spent).toBe(0);
    expect(remaining.remaining).toBe(100);

    const samples = await sql`SELECT id FROM journey_samples WHERE user_id=${userId}`;
    expect(samples).toHaveLength(0);
    const changed = await sql`SELECT id FROM write_rows WHERE user_id=${userId}`;
    expect(changed).toHaveLength(0);
  });

  it("refuses to take today's balance below the reserve before 21:00 local, unless the reserve is explicitly allowed", async () => {
    const morning = atLocalHour(TIMEZONE, 9);
    // Spend down to exactly the reserve floor first, allowing the reserve so this setup step itself
    // is not blocked by the very rule under test.
    await sql`INSERT INTO travel_lookup_budget (user_id, local_date, spent) VALUES (${userId}, ${todayIn(TIMEZONE, morning)}, ${100 - TRAVEL_LOOKUP_RESERVE})`;
    fetchTravelMatrixMock.mockResolvedValue(matrixReply(shed.id, 14));

    await expect(
      spendTravelLookup(
        sql,
        userId,
        TIMEZONE,
        {
          originLocationId: home.id,
          origin: { latitude: home.latitude, longitude: home.longitude },
          destinations: [{ locationId: shed.id, latitude: shed.latitude, longitude: shed.longitude }],
          mode: "car",
          departureAt: morning
        },
        { now: morning }
      )
    ).rejects.toThrow(TravelBudgetRefusedError);
    expect(fetchTravelMatrixMock).not.toHaveBeenCalled();

    // The same spend, with the reserve explicitly allowed (a live check or Manual Measure), succeeds.
    const result = await spendTravelLookup(
      sql,
      userId,
      TIMEZONE,
      {
        originLocationId: home.id,
        origin: { latitude: home.latitude, longitude: home.longitude },
        destinations: [{ locationId: shed.id, latitude: shed.latitude, longitude: shed.longitude }],
        mode: "car",
        departureAt: morning
      },
      { now: morning, allowReserve: true }
    );
    expect(result.spent).toBe(100 - TRAVEL_LOOKUP_RESERVE + 1);
  });

  it("lifts the reserve floor from 21:00 local, even without allowReserve", async () => {
    const night = atLocalHour(TIMEZONE, 21);
    await sql`INSERT INTO travel_lookup_budget (user_id, local_date, spent) VALUES (${userId}, ${todayIn(TIMEZONE, night)}, ${100 - TRAVEL_LOOKUP_RESERVE})`;
    fetchTravelMatrixMock.mockResolvedValue(matrixReply(shed.id, 14));

    const result = await spendTravelLookup(
      sql,
      userId,
      TIMEZONE,
      {
        originLocationId: home.id,
        origin: { latitude: home.latitude, longitude: home.longitude },
        destinations: [{ locationId: shed.id, latitude: shed.latitude, longitude: shed.longitude }],
        mode: "car",
        departureAt: night
      },
      { now: night }
    );
    expect(result.spent).toBe(100 - TRAVEL_LOOKUP_RESERVE + 1);
  });

  it("cannot be pushed past 100 by two concurrent spends", async () => {
    // Each spend below asks for exactly one destination (n=1); starting one short of the cap means
    // both together would reach 101, so exactly one of the two must be refused.
    await sql`INSERT INTO travel_lookup_budget (user_id, local_date, spent) VALUES (${userId}, ${todayIn(TIMEZONE)}, 99)`;
    fetchTravelMatrixMock.mockImplementation(async (request: unknown) => {
      const destinations = (request as { destinations: { locationId: string }[] }).destinations;
      return {
        estimates: destinations.map((destination) => ({
          locationId: destination.locationId,
          minutes: 10,
          mode: "car" as const
        })),
        measurements: destinations.map((destination) => ({
          locationId: destination.locationId,
          mode: "car" as const,
          minutes: 10
        })),
        unroutable: []
      };
    });

    const spend = (locationId: string) =>
      spendTravelLookup(
        sql,
        userId,
        TIMEZONE,
        {
          originLocationId: home.id,
          origin: { latitude: home.latitude, longitude: home.longitude },
          destinations: [{ locationId, latitude: shed.latitude, longitude: shed.longitude }],
          mode: "car",
          departureAt: new Date()
        },
        { allowReserve: true }
      );

    const results = await Promise.allSettled([spend(shed.id), spend(shed.id)]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const remaining = await readTravelLookupsRemaining(sql, userId, TIMEZONE);
    expect(remaining.spent).toBe(100);
    expect(remaining.remaining).toBe(0);
  });

  it("resets at local midnight: a maxed-out earlier day never blocks today's spend", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await sql`INSERT INTO travel_lookup_budget (user_id, local_date, spent) VALUES (${userId}, ${todayIn(TIMEZONE, yesterday)}, 100)`;
    fetchTravelMatrixMock.mockResolvedValue(matrixReply(shed.id, 14));

    const result = await spendTravelLookup(sql, userId, TIMEZONE, {
      originLocationId: home.id,
      origin: { latitude: home.latitude, longitude: home.longitude },
      destinations: [{ locationId: shed.id, latitude: shed.latitude, longitude: shed.longitude }],
      mode: "car",
      departureAt: new Date()
    });

    expect(result.spent).toBe(1);

    const yesterdayRow = await sql<{ spent: number }[]>`
      SELECT spent FROM travel_lookup_budget WHERE user_id=${userId} AND local_date=${todayIn(TIMEZONE, yesterday)}
    `;
    expect(yesterdayRow[0]?.spent).toBe(100);
  });
});

/** `YYYY-MM-DD` in `timeZone`, matching `local_date`'s own derivation. */
function todayIn(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/**
 * An instant that reads as `hour`:MM local in `timeZone`, MM/date otherwise unchanged from now — a
 * plain hour shift from the current instant, so it never has to reconstruct a timezone offset by
 * hand. Good enough for "before 21:00" vs "at/after 21:00": the shift is well under a day either way,
 * so it cannot cross a DST transition or (for the hours this suite uses, 9 and 21) a local midnight.
 */
function atLocalHour(timeZone: string, hour: number): Date {
  const now = new Date();
  const currentHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now)
  );
  return new Date(now.getTime() + (hour - currentHour) * 60 * 60 * 1000);
}
