import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { DELETE as dismissSuggestion } from "@/app/api/location/suggestion/route";
import { POST as observe } from "@/app/api/location/observe/route";
import { POST as ping } from "@/app/api/location/ping/route";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { DeviceLocationState } from "@/server/location/observation-policy";
import { readLastPhonePingAt } from "@/server/location/location-observation-store";
import { readPortalState } from "@/server/persistence/postgres/state-read";
import {
  ageStoredReadings,
  assertLocation,
  home,
  northOf,
  pingRequest as locationPingRequest,
  reading,
  savePlace,
  shed
} from "@/server/location/location-test-fixtures";

/**
 * The two routes end to end against a real database: the token gate, the strict body, and each of
 * the three things a reading is allowed to do to the assertion.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_location_observation");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;
const pingToken = "integration-location-ping-token";

let sql: postgres.Sql;
let userId: string;

const pingRequest = (body: unknown, token: string | null = pingToken) => locationPingRequest(body, token);

function observeRequest(body: unknown) {
  return new Request("http://localhost/api/location/observe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function storedSituation() {
  const rows = await sql<
    { current_situation: { locationId: string | null; locationSetAt?: string }; device_location_state: unknown }[]
  >`SELECT current_situation, device_location_state FROM user_preferences WHERE user_id=${userId}`;
  return {
    situation: rows[0]!.current_situation,
    device: rows[0]!.device_location_state as DeviceLocationState
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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  // The routes read both of these from the process environment at request time, so the suite points
  // them at the _test database and at a token of its own rather than at whatever .env holds.
  process.env.DATABASE_URL = testUrl.toString();
  process.env.LOCATION_PING_TOKEN = pingToken;
}, 30_000);

beforeEach(async () => {
  // This suite is allowed to clear only a database whose validated name ends in _test.
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
  await savePlace(sql, userId, home);
  await savePlace(sql, userId, shed);
  process.env.LOCATION_PING_TOKEN = pingToken;
});

afterAll(async () => {
  await sql?.end();
});

describe("POST /api/location/ping", () => {
  it("refuses a reading with no token, the wrong token, or when none is configured", async () => {
    expect((await ping(pingRequest(reading(home, 0), null), undefined)).status).toBe(401);
    expect((await ping(pingRequest(reading(home, 0), "not-the-token"), undefined)).status).toBe(401);
    delete process.env.LOCATION_PING_TOKEN;
    expect((await ping(pingRequest(reading(home, 0)), undefined)).status).toBe(401);
    // Nothing was recorded by any of the three, so a rejected caller cannot even fill the history.
    expect((await storedSituation()).device.observations).toHaveLength(0);
  });

  it("refuses a body that is not a well-formed reading", async () => {
    const bad = [
      { latitude: home.latitude, longitude: home.longitude, accuracyMeters: 12 },
      { ...reading(home, 0), latitude: 999 },
      { ...reading(home, 0), observedAt: "yesterday" },
      { ...reading(home, 0), note: "somewhere" }
    ];
    for (const body of bad) expect((await ping(pingRequest(body), undefined)).status).toBe(400);
  });

  it("refreshes the staleness clock when the reading agrees with the assertion", async () => {
    const asserted = new Date(Date.now() - 60 * 60_000);
    await assertLocation(sql, userId, "home", asserted);
    const response = await ping(pingRequest(reading(home, 0)), undefined);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ decision: "refreshed", locationId: "home", locationName: "Home" });
    const stored = await storedSituation();
    expect(stored.situation.locationId).toBe("home");
    expect(Date.parse(stored.situation.locationSetAt!)).toBeGreaterThan(asserted.getTime());
  });

  it("suggests rather than moves on one disagreeing reading, then moves once presence is sustained", async () => {
    await assertLocation(sql, userId, "home");
    const first = await (await ping(pingRequest(reading(shed, 12)), undefined)).json();
    await ageStoredReadings(sql, userId, 12);
    expect(first).toMatchObject({ decision: "suggested", locationId: null });
    const afterFirst = await storedSituation();
    expect(afterFirst.situation.locationId).toBe("home");
    expect(afterFirst.device.suggestion).toMatchObject({ kind: "move", locationId: "shed", source: "phone" });

    const second = await (await ping(pingRequest(reading(shed, 0)), undefined)).json();
    expect(second).toMatchObject({ decision: "asserted", locationId: "shed", locationName: "Shed" });
    const afterSecond = await storedSituation();
    expect(afterSecond.situation.locationId).toBe("shed");
    // The question the first reading raised has been answered by the second, not left standing.
    expect(afterSecond.device.suggestion).toBeNull();
    expect(afterSecond.device.observations).toHaveLength(2);
  });

  it("does not move on a burst of readings dated minutes apart but received together", async () => {
    await assertLocation(sql, userId, "home");
    await ping(pingRequest(reading(shed, 11)), undefined);
    const second = await (await ping(pingRequest(reading(shed, 0)), undefined)).json();
    expect(second).toMatchObject({ decision: "suggested", locationId: null });
    expect((await storedSituation()).situation.locationId).toBe("home");
  });

  it("keeps the match and not the coordinates that produced it", async () => {
    await ping(pingRequest(reading(home, 0)), undefined);
    const stored = await storedSituation();
    expect(JSON.stringify(stored.device)).not.toContain(String(home.latitude));
    expect(stored.device.observations[0]).toMatchObject({ source: "phone", match: { kind: "matched" } });
  });

  it("records being somewhere unsaved as a question of its own", async () => {
    await assertLocation(sql, userId, "home");
    const body = await (await ping(pingRequest(reading(northOf(80_000), 0)), undefined)).json();
    expect(body).toMatchObject({ decision: "suggested", suggestion: { kind: "unknown" } });
    expect((await storedSituation()).situation.locationId).toBe("home");
  });

  it("auto-skips the arrived-at commitment's leftover preparation once presence at it is sustained", async () => {
    // A phone ping moving the assertion is the same "arrival wins" moment a hand-picked location
    // gets — see routine-step-arrival.ts. This is that path exercised through the real HTTP route,
    // not the manual situation save `state-store.integration.test.ts` already covers.
    const commitmentId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const startsAt = new Date(Date.now() - 10 * 60_000);
    const endsAt = new Date(Date.now() + 50 * 60_000);
    await sql`
      INSERT INTO commitments (id, user_id, title, starts_at, ends_at, location_id)
      VALUES (${commitmentId}, ${userId}, 'College Class', ${startsAt}, ${endsAt}, ${shed.id})
    `;
    await sql`
      INSERT INTO routine_steps (id, user_id, commitment_id, anchor_type, anchor_id, title, duration_minutes, sequence, timing_rule, phase, status)
      VALUES (${stepId}, ${userId}, ${commitmentId}, 'commitment', ${commitmentId}, 'Pack Bag', 10, 0, 'contiguous', 'before', 'pending')
    `;
    await assertLocation(sql, userId, "home");
    // One disagreeing reading only suggests; presence sustained over a second moves the assertion.
    await ping(pingRequest(reading(shed, 12)), undefined);
    await ageStoredReadings(sql, userId, 12);
    await ping(pingRequest(reading(shed, 0)), undefined);
    const arrived = await storedSituation();
    expect(arrived.situation.locationId).toBe("shed");
    // The device write path (`write`, `location-observation-store.ts`) goes through the same
    // `nextCurrentSituation` the manual save does, and must stamp `locationSetAt` in the same write as
    // `locationId` — a missing timestamp reads as stale-to-the-point-of-absent downstream
    // (`currentFreshLocationId`), which would silently turn off the sweep backstop and check-in
    // suppression for this exact row.
    expect(arrived.situation.locationSetAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(arrived.situation.locationSetAt!))).toBe(false);
    const step = await sql<{ status: string }[]>`SELECT status FROM routine_steps WHERE id=${stepId}`;
    expect(step[0]?.status).toBe("skipped");
  });
});

describe("lastPhonePingAt", () => {
  it("is null before any ping, and stamped with server receipt time on every accepted ping outcome", async () => {
    expect(await readLastPhonePingAt(sql, userId)).toBeNull();
    await assertLocation(sql, userId, "home");
    const before = Date.now();
    // refreshed
    await ping(pingRequest(reading(home, 0)), undefined);
    const first = await readLastPhonePingAt(sql, userId);
    expect(first!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // suggested (disagrees with the assertion), with an observedAt well before receipt
    await ping(pingRequest(reading(shed, 10)), undefined);
    const second = await readLastPhonePingAt(sql, userId);
    expect(second!.getTime()).toBeGreaterThanOrEqual(first!.getTime());
    expect(second!.getTime()).toBeGreaterThan(Date.parse(reading(shed, 10).observedAt));
    const raw = JSON.stringify((await storedSituation()).device);
    expect(raw).not.toMatch(/latitude|longitude/);
  });

  it("is not stamped by a rejected stale reading, and survives a browser observation and a dismissal", async () => {
    await assertLocation(sql, userId, "home");
    const stale = { ...reading(home, 0), observedAt: new Date(Date.now() - 6 * 3_600_000).toISOString() };
    expect((await ping(pingRequest(stale), undefined)).status).toBe(400);
    expect(await readLastPhonePingAt(sql, userId)).toBeNull();
    await ping(pingRequest(reading(home, 0)), undefined);
    const stamped = await readLastPhonePingAt(sql, userId);
    expect(stamped).not.toBeNull();
    await observe(observeRequest(reading(northOf(4060), 0)), undefined);
    await dismissSuggestion(new Request("http://localhost/api/location/suggestion", { method: "DELETE" }), undefined);
    expect(await readLastPhonePingAt(sql, userId)).toEqual(stamped);
    expect(JSON.stringify(await readPortalState(sql))).not.toContain("lastPhonePingAt");
  });

  it("reads only the given user's stamp", async () => {
    await ping(pingRequest(reading(home, 0)), undefined);
    expect(await readLastPhonePingAt(sql, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("POST /api/location/observe", () => {
  it("needs no token, being unable to move anything", async () => {
    await assertLocation(sql, userId, "home");
    const response = await observe(observeRequest(reading(home, 0)), undefined);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      decision: "refreshed",
      locationId: "home",
      locationName: "Home",
      distanceMeters: 0,
      reason: null
    });
  });

  it("suggests a different place without writing anything to the assertion", async () => {
    await assertLocation(sql, userId, "home");
    // Sixty metres from the shed rather than on top of it, so the reported distance is the one the
    // matcher measured and not a fixture artefact.
    const response = await observe(observeRequest(reading(northOf(4060), 0)), undefined);
    expect(await response.json()).toEqual({
      decision: "suggest",
      locationId: "shed",
      locationName: "Shed",
      distanceMeters: 60,
      reason: null
    });
    const stored = await storedSituation();
    expect(stored.situation.locationId).toBe("home");
    expect(stored.device.suggestion).toMatchObject({ kind: "move", locationId: "shed", source: "browser" });
  });

  it("asks again instead of quietly reinstating an assertion that had gone stale", async () => {
    await assertLocation(sql, userId, "home", new Date(Date.now() - 30 * 60 * 60_000));
    const body = await (await observe(observeRequest(reading(home, 0)), undefined)).json();
    expect(body).toMatchObject({ decision: "suggest", locationId: "home" });
  });

  it("ignores a reading it cannot pin to one place", async () => {
    await savePlace(sql, userId, { id: "studio", name: "Studio", ...northOf(60) });
    const ambiguous = await (await observe(observeRequest(reading(home, 0)), undefined)).json();
    expect(ambiguous).toEqual({
      decision: "ignored",
      locationId: null,
      locationName: null,
      distanceMeters: null,
      reason: "ambiguous"
    });
    const away = await (await observe(observeRequest(reading(northOf(80_000), 0)), undefined)).json();
    expect(away).toMatchObject({ decision: "ignored", reason: "no_match" });
  });

  it("says so when no saved place has coordinates at all", async () => {
    await sql`UPDATE condition_definitions SET latitude=NULL, longitude=NULL WHERE user_id=${userId}`;
    const body = await (await observe(observeRequest(reading(home, 0)), undefined)).json();
    expect(body).toMatchObject({ decision: "ignored", reason: "no_locations" });
  });

  it("refuses a reading dated hours in the past or in the future, on both doors", async () => {
    await assertLocation(sql, userId, "home");
    for (const minutesAgo of [180, -180]) {
      expect((await ping(pingRequest(reading(home, minutesAgo)), undefined)).status).toBe(400);
      expect((await observe(observeRequest(reading(home, minutesAgo)), undefined)).status).toBe(400);
    }
    expect((await storedSituation()).device.observations).toHaveLength(0);
  });

  it("refuses a body that is not a well-formed reading", async () => {
    const response = await observe(observeRequest({ latitude: home.latitude }), undefined);
    expect(response.status).toBe(400);
  });
});

describe("state exposes a phone-raised suggestion as pendingLocationSuggestion", () => {
  it("is null with nothing pending, and the named place once a ping raises one", async () => {
    await assertLocation(sql, userId, "home");
    expect((await readPortalState(sql))?.pendingLocationSuggestion).toBeNull();

    const shedReading = reading(shed, 12);
    await ping(pingRequest(shedReading), undefined);
    expect((await readPortalState(sql))?.pendingLocationSuggestion).toEqual({
      locationId: "shed",
      locationName: "Shed",
      observedAt: shedReading.observedAt
    });
  });

  it("does not expose an ambiguous or unmatched question, which have no single place to confirm", async () => {
    await assertLocation(sql, userId, "home");
    await savePlace(sql, userId, { id: "studio", name: "Studio", ...northOf(60) });
    await ping(pingRequest(reading(home, 0)), undefined);
    expect((await readPortalState(sql))?.pendingLocationSuggestion).toBeNull();
  });
});

describe("DELETE /api/location/suggestion", () => {
  it("clears a pending suggestion without touching the assertion", async () => {
    await assertLocation(sql, userId, "home");
    await observe(observeRequest(reading(northOf(4060), 0)), undefined);
    expect((await storedSituation()).device.suggestion).not.toBeNull();

    const response = await dismissSuggestion(
      new Request("http://localhost/api/location/suggestion", { method: "DELETE" }),
      undefined
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cleared: true });

    const stored = await storedSituation();
    expect(stored.device.suggestion).toBeNull();
    expect(stored.situation.locationId).toBe("home");
    expect((await readPortalState(sql))?.pendingLocationSuggestion).toBeNull();
  });

  it("is a no-op when nothing is pending", async () => {
    await assertLocation(sql, userId, "home");
    const response = await dismissSuggestion(
      new Request("http://localhost/api/location/suggestion", { method: "DELETE" }),
      undefined
    );
    expect(response.status).toBe(200);
    expect((await storedSituation()).device.suggestion).toBeNull();
  });
});
