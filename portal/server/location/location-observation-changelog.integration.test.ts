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
  assertLocation,
  home,
  pingRequest as locationPingRequest,
  reading,
  savePlace,
  shed
} from "@/server/location/location-test-fixtures";

/**
 * Fixed. `location-observation-store.ts`'s `write()` now calls `recordStateChange`
 * (`planning-evidence.ts`) in the same transaction as the assertion move and the
 * `skipMootRoutineSteps` skip, exactly like every other write path that touches state the engine
 * consumes (`entity-commands.ts`, `activity-commands.ts`, `session-commands.ts`,
 * `recurrence-commands.ts`, `project-commands.ts`, `import-store.ts`). A `write_rows` row is now
 * written whenever the assertion actually moves — a place change, or a stale assertion turning
 * fresh — and a plan-forecast job is enqueued in the same call (the one write path design note,
 * invariant 4). A same-place reading on an assertion that was still fresh writes no row, enqueues no
 * job and leaves `user_preferences.version` unchanged, because it changes nothing the plan or a
 * settings save can see.
 *
 * `platform/database/src/planning/plan-forecast-runtime.ts`'s `stateChangedSince` decides whether a
 * chained `validity_boundary` job (built from an old portal-state snapshot) has been superseded purely
 * by checking for a `write_rows` row newer than the snapshot's `stateCapturedAt`. Because arrivals now
 * log one, a boundary job snapshotted before the ping is correctly seen as superseded rather than
 * silently persisting a plan computed from the pre-arrival state.
 *
 * This models the existing "auto-skips the arrived-at commitment's leftover preparation"
 * scenario in `location-observation.integration.test.ts`, then asks the same question
 * `stateChangedSince` asks.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
// Its own variable, like the newer portal suites, so pinning this suite never pins its sibling too.
const testDatabaseName = integrationDatabaseName(
  process.env.LOCATION_CHANGELOG_TEST_DATABASE_NAME,
  "openrhen_location_observation_changelog"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("LOCATION_CHANGELOG_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;
const pingToken = "integration-location-ping-changelog-token";

let sql: postgres.Sql;
let userId: string;

const pingRequest = (body: unknown) => locationPingRequest(body, pingToken);

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

describe("location-observation writes and write_rows", () => {
  it("does not log write_rows when a sustained phone ping moves the asserted location and skips prep for the arrived-at commitment", async () => {
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

    // A snapshot a plan-forecast job would have captured just before the arrival ping. Backdated a
    // few seconds, as the sibling suites do (`plan-forecast-claim.integration.test.ts`), so a small
    // clock skew between this process and the database server cannot make a genuine write look older
    // than the snapshot.
    const stateCapturedAt = new Date(Date.now() - 5_000);

    // One disagreeing reading only suggests; presence sustained over a second moves the assertion
    // and (per `skipMootRoutineSteps`) skips the leftover "before" step.
    await ping(pingRequest(reading(shed, 12)), undefined);
    await ageStoredReadings(sql, userId, 12);
    await ping(pingRequest(reading(shed, 0)), undefined);

    // Sanity: the arrival really did move state the engine/portal-state read depends on.
    const step = await sql<{ status: string }[]>`SELECT status FROM routine_steps WHERE id=${stepId}`;
    expect(step[0]?.status).toBe("skipped");
    const situation = await sql<{ current_situation: { locationId: string } }[]>`
      SELECT current_situation FROM user_preferences WHERE user_id=${userId}
    `;
    expect(situation[0]?.current_situation.locationId).toBe("shed");

    // A write that changes engine-consumed state must be visible to `stateChangedSince` (in
    // platform/database/src/planning/plan-forecast-runtime.ts): a `write_rows` row for this
    // user, newer than the pre-arrival snapshot. Currently `write()`/`skipMootRoutineSteps` insert none,
    // so a chained `validity_boundary` job snapshotted at `stateCapturedAt` will persist a plan that
    // never learned about the arrival or the skipped step.
    const changed = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM write_rows WHERE user_id=${userId} AND created_at > ${stateCapturedAt}
      ) AS exists
    `;
    // Fixed.
    expect(changed[0]?.exists).toBe(true);
  });

  it("enqueues a pending plan-forecast job for the user after an arrival", async () => {
    await assertLocation(sql, userId, "home");

    await ping(pingRequest(reading(shed, 12)), undefined);
    await ageStoredReadings(sql, userId, 12);
    await ping(pingRequest(reading(shed, 0)), undefined);

    const situation = await sql<{ current_situation: { locationId: string } }[]>`
      SELECT current_situation FROM user_preferences WHERE user_id=${userId}
    `;
    expect(situation[0]?.current_situation.locationId).toBe("shed");

    const jobs = await sql<{ status: string }[]>`
      SELECT status FROM jobs WHERE type='plan_forecast.recalculate.v1' AND payload->>'userId'=${userId}
    `;
    expect(jobs.some((job) => job.status === "pending")).toBe(true);
  });

  it("a same-place ping while the assertion is still fresh writes no write_rows row, enqueues nothing and leaves version unchanged", async () => {
    await assertLocation(sql, userId, "home");
    const before = await sql<{ version: number }[]>`SELECT version FROM user_preferences WHERE user_id=${userId}`;

    await ping(pingRequest(reading(home, 0)), undefined);

    const after = await sql<{ version: number }[]>`SELECT version FROM user_preferences WHERE user_id=${userId}`;
    expect(after[0]?.version).toBe(before[0]?.version);

    const changed = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM write_rows WHERE user_id=${userId}) AS exists
    `;
    expect(changed[0]?.exists).toBe(false);

    const jobs =
      await sql`SELECT id FROM jobs WHERE type='plan_forecast.recalculate.v1' AND payload->>'userId'=${userId}`;
    expect(jobs.length).toBe(0);
  });

  it("a same-place reading on a stale assertion logs one row and enqueues one job", async () => {
    // Older than the 480-minute default staleness horizon (DEFAULT_LOCATION_STALE_AFTER_MINUTES).
    const staleSetAt = new Date(Date.now() - 500 * 60_000);
    await assertLocation(sql, userId, "home", staleSetAt);

    await ping(pingRequest(reading(home, 0)), undefined);

    const changed = await sql<{ id: string }[]>`SELECT id FROM write_rows WHERE user_id=${userId}`;
    expect(changed.length).toBe(1);

    const jobs = await sql<{ status: string }[]>`
      SELECT status FROM jobs WHERE type='plan_forecast.recalculate.v1' AND payload->>'userId'=${userId}
    `;
    expect(jobs.some((job) => job.status === "pending")).toBe(true);
  });
});
