import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { PLAN_FORECAST_JOB_TYPE, integrationDatabaseName, processPlanForecastJob } from "@openrhen/database";
import { handleRequest } from "../../../../engine/service/src/server";
import { createSeedState } from "@/state/portal-state";
import { NormalizedPostgresStateStore } from "./state-store";
import { PostgresImportStore } from "./import-store";
import { DeliverableProposalStore } from "./deliverable-proposal-store";
import { planForecastResponseSchema } from "@openrhen/contracts";

/**
 * The fixture every `state-store-*.integration.test.ts` file shares.
 *
 * These journeys were one 6,800-line file until 2026-09-10, and that file was the integration gate's
 * wall clock: about ten minutes of a fourteen-minute run, so the other seventeen files finished long
 * before it and their workers then sat idle. Splitting the tests across several files lets them run
 * side by side; splitting the fixture would have meant maintaining the same eighty lines of database,
 * engine and planning-queue setup in each one, so the fixture lives here instead and the test bodies
 * moved unchanged.
 *
 * Each file calls `setupStateStoreSuite` with its own base name, so each gets its own
 * `<base>_<suffix>_test` database and they cannot truncate each other in `beforeEach`. The bindings
 * below are exported `let` — ES module live bindings, assigned in `beforeAll` — and vitest gives each
 * test file its own module instance, so one file's `store` is never another's.
 *
 * Pinning `TEST_DATABASE_NAME` still collapses every suite onto one exact database for post-mortem
 * inspection; the integration config already drops to serial execution in that case, which is what
 * keeps these files from truncating each other's tables.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");

export let sql: postgres.Sql;
export let store: NormalizedPostgresStateStore;
/**
 * The same store without `withPlanningRefresh`: its writes still enqueue a plan-forecast job, but
 * nothing drains the queue after each one. For building a fixture out of many commands whose
 * intermediate plans the test never reads — each drain is a whole engine run, and a newer enqueue
 * supersedes an older pending job, so the next `store` call plans the finished fixture once.
 */
export let unplannedStore: NormalizedPostgresStateStore;
export let importStore: PostgresImportStore;
export let deliverableProposalStore: DeliverableProposalStore;
export let engineUrl: string;
export const engineToken = "integration-plan-forecast-token";

/**
 * Fixed for the run, not for the calendar. Sleep, capacity, recurrence and session eligibility are all
 * resolved against the real clock, and the state store only loads recent sleep plans, so an anchor
 * pinned to a past date silently stops being loadable and takes time-sensitive fixtures down with it.
 */
export const fixedNow = new Date();

/**
 * Freezes `Date` (and only `Date`, so the database driver's timers still run) at `hour`:00 in the
 * seed's own timezone (a fixed non-UTC zone with DST) on the current date there. The store and the portal stamp
 * the planning run off the real clock, and the seed's planning day closes at 22:00 with bedtime at
 * 22:00, so a journey that needs the engine to hand out work, or to plan tonight's sleep ahead, can
 * pass at lunchtime and fail in the evening . Pinning the clock makes it independent of
 * the hour it runs in. Restored after the test by `setupStateStoreSuite`.
 */
let clockPinned = false;

export function pinClockToSeedZoneHour(hour = 10, minute = 0, second = 0): Date {
  const timeZone = "Australia/Sydney";
  const real = new Date();
  const parts = (at: Date) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-AU", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      })
        .formatToParts(at)
        .map((part) => [part.type, part.value])
    );
  const seedZone = parts(real);
  // Treat the seed-zone wall-clock reading as UTC, move it to `hour`:00, then subtract the zone offset.
  const asUtc = (p: Record<string, string>) =>
    Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const offsetMs = asUtc(seedZone) - Math.floor(real.getTime() / 1000) * 1000;
  const target = new Date(
    Date.UTC(Number(seedZone.year), Number(seedZone.month) - 1, Number(seedZone.day), hour, minute, second) - offsetMs
  );
  vi.useFakeTimers({ toFake: ["Date"], now: target });
  clockPinned = true;
  return target;
}

/**
 * The store stamps engine time with the real clock, and the seed's planning day closes at 22:00 with
 * bedtime at 22:00 local. A journey that needs the engine to hand out work therefore has to run in a
 * timezone where it is currently mid-morning, or after 22:00 in the seed zone it gets "none" and fails for the
 * hour of day rather than for anything it tests. Etc/GMT zones are fixed offsets with inverted sign.
 */
export function daytimeSeed(now: Date) {
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const offset = Math.max(-12, Math.min(14, Math.round(11 - utcHour)));
  const seed = createSeedState(now);
  seed.settings.timezone = offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
  return seed;
}

/**
 * `put()` leaves `current_situation` alone, so a seeded energy is undated and the plan reads it as unknown
 * Says it as the energy chip does, for a journey that needs the
 * seeded energy in force.
 */
export async function sayEnergy() {
  const state = (await store.get())!;
  await store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion: state.settings.version ?? null,
    type: "save_entity",
    entityType: "current_availability",
    entity: { currentEnergy: state.currentEnergy, assertedConditions: state.assertedConditions, energyAsserted: true }
  });
}

/**
 * The `daytimeSeed` trick run in the other direction: pins local time to 21:30, deep inside the
 * bedtime-routine evening window, whatever the real hour is. `preferredBedtime` defaults to "22:00"
 * (`createSeedState`), so this sits 30 minutes before it — used by a journey that needs to run the
 * bedtime routine's own evening replan deterministically, not by accident of when the suite happens
 * to run.
 */
export function eveningSeed(now: Date) {
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  // Wrap by a day rather than clamp: 21.5 - utcHour spans -2.5..21.5, and Etc/GMT offsets stop at +14.
  let offset = Math.round(21.5 - utcHour);
  if (offset > 14) offset -= 24;
  const seed = createSeedState(now);
  seed.settings.timezone = offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
  return seed;
}

export async function refreshPlanning() {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  for (let index = 0; index < 20; index += 1) {
    const result = await processPlanForecastJob(
      sql,
      { url: engineUrl, token: engineToken, timeoutMs: 10_000 },
      "integration-worker"
    );
    if (result === "idle" || result === "retrying" || result === "failed") return;
  }
  throw new Error("Integration planning queue did not drain.");
}

/** The projected day the current (not superseded) planning run wrote, straight from the run row. */
export async function currentDayPlan() {
  const rows = await sql<{ result: unknown }[]>`
    SELECT result FROM planning_runs WHERE superseded_at IS NULL ORDER BY calculated_at DESC LIMIT 1
  `;
  return planForecastResponseSchema.parse(rows[0]!.result).dayPlan;
}

/** The continuation the most recent enqueued plan-forecast job asked the engine to simulate. */
export async function latestContinuationRequest(targetId: string) {
  const rows = await sql<{ continuation: { actionId: string; requestedMinutes?: number } | null }[]>`
    SELECT payload->'request'->'continuation' AS continuation FROM jobs
    WHERE type=${PLAN_FORECAST_JOB_TYPE} AND payload->'request'->'continuation'->>'actionId'=${targetId}
    ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0]?.continuation ?? null;
}

export function withPlanningRefresh<T extends object>(target: T, methodNames: string[], returnCurrentState = false): T {
  const wrapped = new Set(methodNames);
  return new Proxy(target, {
    get(instance, property, receiver) {
      const value = Reflect.get(instance, property, receiver);
      if (typeof property !== "string" || !wrapped.has(property) || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await refreshPlanning();
        const result = await value.apply(instance, args);
        await refreshPlanning();
        return property !== "put" && returnCurrentState && "get" in instance && typeof instance.get === "function"
          ? instance.get()
          : result;
      };
    }
  });
}

/**
 * Register this file's database, engine service and planning queue. `base` must differ per test file:
 * it is what gives each one its own database, and two files sharing a base would truncate each other.
 * `resetBetweenTests: false` keeps the tables as the previous test left them (the default truncates them before
 * every test); the file then owns its own clean start.
 */
export function setupStateStoreSuite(base: string, options: { resetBetweenTests?: boolean } = {}): void {
  const resetBetweenTests = options.resetBetweenTests ?? true;
  const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, base);
  if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
    throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
  }
  const testUrl = new URL(adminUrl!);
  testUrl.pathname = `/${testDatabaseName}`;
  let engineServer: Server;

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
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
      await migrate(drizzle(migrationSql), {
        migrationsFolder: resolve(process.cwd(), "../platform/database/drizzle")
      });
    } finally {
      await migrationSql.end();
    }
    engineServer = createServer(
      (request, response) =>
        void handleRequest(request, response, { token: engineToken, maxPayloadBytes: 5 * 1024 * 1024 })
    );
    await new Promise<void>((resolveListen) => engineServer.listen(0, "127.0.0.1", resolveListen));
    const address = engineServer.address();
    if (!address || typeof address === "string") throw new Error("Integration engine did not bind.");
    engineUrl = `http://127.0.0.1:${address.port}`;
    // `fetch_types: true` matches `sqlPool`'s production connection (see that file's comment): without
    // it postgres.js cannot resolve an array parameter's element type OID and `= ANY(${ids})` (used by
    // `DeliverableProposalStore.chatContext`/`packSources`) fails as a malformed array literal.
    sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: true, prepare: true });
    store = withPlanningRefresh(
      new NormalizedPostgresStateStore(sql),
      [
        "put",
        "saveProject",
        "confirmProjectWanted",
        "closeEntity",
        "saveAction",
        "runSessionCommand",
        "runActivityCommand",
        "runWakeCommand",
        "runStretchCommand",
        "recalculate",
        "saveEntity",
        "saveCommitmentRecurrenceRule",
        "endRecurrenceGoal"
      ],
      true
    );
    unplannedStore = new NormalizedPostgresStateStore(sql);
    importStore = withPlanningRefresh(new PostgresImportStore(sql), ["commit"]);
    deliverableProposalStore = new DeliverableProposalStore(sql);
  }, 60_000);

  if (resetBetweenTests)
    beforeEach(async () => {
      // This suite is allowed to clear only a database whose validated name ends in _test.
      await sql.unsafe("TRUNCATE TABLE users, portal_state, jobs RESTART IDENTITY CASCADE");
    }, 60_000);

  // Only a clock this helper pinned: a suite that fakes `Date` itself for its whole run (the agent
  // contract replay) must keep its clock between tests.
  afterEach(() => {
    if (!clockPinned) return;
    clockPinned = false;
    vi.useRealTimers();
  });

  afterAll(async () => {
    await sql?.end();
    await new Promise<void>((resolveClose) => engineServer?.close(() => resolveClose()));
  });
}
