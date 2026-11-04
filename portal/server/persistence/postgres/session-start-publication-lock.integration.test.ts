import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName, lockPlanForecastPublication } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { runSessionCommand } from "./session-commands";

/**
 * A session `start` and the worker's plan publish must take their locks in one order. The
 * publish takes the per-user publication lock, then locks rows: the user's waiting plan-forecast jobs
 * it supersedes and, through its foreign keys, a key-share lock on each action and project it names.
 * A `start` used to lock its action and project rows first and take the publication lock only for a
 * plan past its boundary, so with a current plan it could hold the action while waiting for the job
 * row the publish held, while the publish waited for the action: Postgres then failed one of them with
 * `deadlock detected` (a 500 during the demo seed). Here a worker-style transaction holds the lock and
 * the job row across a `start`, then takes the key-share lock; both must finish.
 * Self-contained `_test` database, the same pattern as `session-commands-snapshot.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.SESSION_START_LOCK_TEST_DATABASE_NAME,
  "openrhen_session_start_lock"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("SESSION_START_LOCK_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

async function createAction(): Promise<{ actionId: string; projectId: string; version: number }> {
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<
    { id: string }[]
  >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Project','active') RETURNING id`;
  const action = await sql<{ id: string; version: number }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${project[0]!.id},'Easy 5 km run','one_off','active',30,60,90,60,'medium',15,90)
    RETURNING id, version
  `;
  return { actionId: action[0]!.id, projectId: project[0]!.id, version: action[0]!.version };
}

/** A plan still inside its validity window: the case that used to skip the publication lock. */
async function storeCurrentPlanningRun(actionId: string): Promise<void> {
  const now = new Date();
  const requestId = crypto.randomUUID();
  await sql`
    INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
    VALUES (
      ${userId},${requestId},'v1','1','v1',${now},${new Date(now.getTime() + 3_600_000)},
      ${sql.json({
        contractVersion: "1",
        requestId,
        inputVersion: "v1",
        engineVersion: "v1",
        calculatedAt: now.toISOString(),
        validUntil: new Date(now.getTime() + 3_600_000).toISOString(),
        derivedState: {
          sleepPlans: [],
          occurrences: [],
          routineSteps: [],
          commitmentRepeats: [],
          commitmentTimelines: [],
          stepPlacements: []
        },
        schedule: {},
        recommendation: {},
        currentDirective: { kind: "action", targetId: actionId, title: "Easy 5 km run", recommendedMinutes: 30 },
        upcomingDirectives: [],
        continuation: null
      } as never)}
    )
  `;
}

/** A plan-forecast job still waiting, which the `start`'s own enqueue supersedes. */
async function storeWaitingJob(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO jobs (type,payload,idempotency_key,status,available_at)
    VALUES ('plan_forecast.recalculate.v1',${sql.json({ userId, cause: "state_change" } as never)},${"plan_forecast.recalculate.v1:" + userId + ":waiting"},'pending',${new Date(0)})
    RETURNING id
  `;
  return rows[0]!.id;
}

/** Waits until another backend is blocked on a lock, so the worker side moves only once `start` is waiting. */
async function untilABackendWaits(): Promise<void> {
  // Polled from the pool, not the holder: a transaction sees one pg_stat_activity snapshot throughout.
  for (let attempt = 0; attempt < 60; attempt++) {
    const waiting = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`;
    if (waiting[0]!.count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The start never waited on the publish in flight.");
}

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
      migrationsFolder: fileURLToPath(new URL("../../../../platform/database/drizzle", import.meta.url))
    });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE jobs, writes, write_rows, planning_runs, session_segments, sessions, action_occurrences, actions, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

describe("session start against a plan publish in flight", () => {
  it("waits for the publish instead of deadlocking with it", async () => {
    const { actionId, projectId, version } = await createAction();
    await storeCurrentPlanningRun(actionId);
    const jobId = await storeWaitingJob();
    const commandId = crypto.randomUUID();
    const order: string[] = [];
    let start: Promise<unknown> = Promise.resolve();
    await sql.begin(async (worker) => {
      // The publish's own order: the publication lock, then the waiting jobs it supersedes.
      await lockPlanForecastPublication(worker as unknown as postgres.Sql, userId);
      await worker`SELECT id FROM jobs WHERE id=${jobId} FOR UPDATE`;
      start = runSessionCommand(sql, {
        commandId,
        type: "start",
        actionId,
        expectedVersion: version,
        plannedMinutes: 30
      }).then(() => order.push("started"));
      await untilABackendWaits();
      // Then the foreign-key checks of its forecast and recommendation rows.
      await worker`SELECT id FROM projects WHERE id=${projectId} FOR KEY SHARE`;
      await worker`SELECT id FROM actions WHERE id=${actionId} FOR KEY SHARE`;
      order.push("published");
    });
    await start;
    expect(order).toEqual(["published", "started"]);
    const sessions = await sql<{ status: string }[]>`SELECT status FROM sessions WHERE id=${commandId}`;
    expect(sessions).toEqual([{ status: "running" }]);
  }, 20_000);
});
