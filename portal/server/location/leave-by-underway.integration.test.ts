import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { POST as ping } from "@/app/api/location/ping/route";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import {
  ageStoredReadings,
  home,
  pingRequest as locationPingRequest,
  reading,
  savePlace,
  shed
} from "@/server/location/location-test-fixtures";

/**
 * `currentSituation.underway` survives a same-place phone ping that only refreshes staleness, and is
 * cleared once the phone asserts somewhere else (the leave by push design note, "Underway", "On my
 * way"). The rule itself is `current-situation.test.ts`'s job on the pure `nextCurrentSituation`; this
 * is the same rule exercised through the real write path a phone ping actually takes
 * (`location-observation-store.ts`'s `write`), against a real database.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.LEAVE_BY_UNDERWAY_TEST_DATABASE_NAME,
  "openrhen_leave_by_underway"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("LEAVE_BY_UNDERWAY_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;
const pingToken = "integration-leave-by-underway-token";

let sql: postgres.Sql;
let userId: string;

const pingRequest = (body: unknown) => locationPingRequest(body, pingToken);

const underway = {
  commitmentId: "dentist-1",
  occurrenceStartsAt: "2026-09-26T08:30:00.000Z",
  fromLocationId: "home",
  departedAt: "2026-09-26T08:05:00.000Z"
};

async function assertLocationWithUnderway(
  locationId: string,
  setAt = new Date(),
  withUnderway: typeof underway | null = underway
) {
  await sql`
    UPDATE user_preferences
    SET current_situation = ${sql.json({
      locationId,
      locationSetAt: setAt.toISOString(),
      overrides: {},
      carrying: {},
      transportModes: ["car"],
      travel: {},
      underway: withUnderway
    } as never)}
    WHERE user_id = ${userId}
  `;
}

async function storedSituation() {
  const rows = await sql<{ current_situation: { locationId: string | null; underway: typeof underway | null } }[]>`
    SELECT current_situation FROM user_preferences WHERE user_id=${userId}
  `;
  return rows[0]!.current_situation;
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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  process.env.DATABASE_URL = testUrl.toString();
  process.env.LOCATION_PING_TOKEN = pingToken;
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
  await savePlace(sql, userId, home);
  await savePlace(sql, userId, shed);
  process.env.LOCATION_PING_TOKEN = pingToken;
});

afterAll(async () => {
  await sql?.end();
});

describe("underway survives a same-place refresh, through a real phone ping", () => {
  it("a same-place ping only refreshes staleness and keeps underway", async () => {
    const asserted = new Date(Date.now() - 60 * 60_000);
    await assertLocationWithUnderway("home", asserted);
    const response = await ping(pingRequest(reading(home, 0)), undefined);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ decision: "refreshed", locationId: "home" });
    const stored = await storedSituation();
    expect(stored.locationId).toBe("home");
    expect(stored.underway).toEqual(underway);
  });

  it("a reading that asserts a different place clears underway", async () => {
    await assertLocationWithUnderway("home");
    // One disagreeing reading only suggests; a second, matching one moves the assertion — the
    // ordinary two-in-a-row sustained-presence rule (`observation-policy.ts`), unrelated to underway.
    await ping(pingRequest(reading(shed, 12)), undefined);
    await ageStoredReadings(sql, userId, 12);
    const response = await ping(pingRequest(reading(shed, 0)), undefined);
    expect(await response.json()).toMatchObject({ decision: "asserted", locationId: "shed" });
    const stored = await storedSituation();
    expect(stored.locationId).toBe("shed");
    expect(stored.underway).toBeNull();
  });

  it("with no underway stored, a same-place ping still just refreshes as usual", async () => {
    const asserted = new Date(Date.now() - 60 * 60_000);
    await assertLocationWithUnderway("home", asserted, null);
    const response = await ping(pingRequest(reading(home, 0)), undefined);
    expect(await response.json()).toMatchObject({ decision: "refreshed", locationId: "home" });
    const stored = await storedSituation();
    expect(stored.underway).toBeNull();
  });
});
