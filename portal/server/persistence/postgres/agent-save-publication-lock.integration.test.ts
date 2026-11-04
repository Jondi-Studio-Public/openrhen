import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName, lockPlanForecastPublication } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { runWithActor } from "@/server/agent-actor";
import { saveAction } from "./project-commands";

/**
 * An agent's save keeps row images, and its snapshot locks rows `FOR UPDATE` (the action, its occurrences, steps ...)
 * that the worker's plan publish also locks, after taking the per-user publication lock. A command must take that lock
 * before any row lock: otherwise the save holds the action while waiting for the publication lock the worker
 * holds, and the worker waits for the action's key-share lock, so Postgres fails one with `deadlock detected` (a 500
 * on `rhen save action --id` in the demo seed). Here a worker-style transaction holds the lock across the
 * agent's save and then takes the key-share lock; both must finish.
 * Self-contained `_test` database, the pattern of `session-start-publication-lock.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.AGENT_SAVE_LOCK_TEST_DATABASE_NAME,
  "openrhen_agent_save_lock"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("AGENT_SAVE_LOCK_TEST_DATABASE_NAME must be an identifier ending in _test");
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

/** A plan-forecast job still waiting, which the save's own enqueue supersedes. */
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
  throw new Error("The save never waited on the publish in flight.");
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

describe("an agent's action save against a plan publish in flight", () => {
  it("waits for the publish instead of deadlocking with it", async () => {
    const { actionId, projectId, version } = await createAction();
    const jobId = await storeWaitingJob();
    const order: string[] = [];
    let save: Promise<unknown> = Promise.resolve();
    await sql.begin(async (worker) => {
      // The publish's own order: the publication lock first, then the foreign-key locks on the rows it names.
      await lockPlanForecastPublication(worker as unknown as postgres.Sql, userId);
      await worker`SELECT id FROM jobs WHERE id=${jobId} FOR UPDATE`;
      save = runWithActor("claude", () =>
        saveAction(sql, {
          commandId: crypto.randomUUID(),
          expectedVersion: version,
          action: {
            id: actionId,
            projectId,
            title: "Easy 5 km run",
            status: "blocked",
            optimisticMinutes: 30,
            expectedMinutes: 60,
            pessimisticMinutes: 90,
            remainingMinutes: 60,
            energy: "medium",
            minimumSessionMinutes: 15,
            maximumSessionMinutes: 90,
            splittable: true,
            setupMinutes: 0,
            importance: 3,
            consequence: 3,
            contexts: [],
            dependencyIds: []
          }
        } as never)
      ).then(() => order.push("saved"));
      await untilABackendWaits();
      await worker`SELECT id FROM projects WHERE id=${projectId} FOR KEY SHARE`;
      await worker`SELECT id FROM actions WHERE id=${actionId} FOR KEY SHARE`;
      order.push("published");
    });
    await save;
    expect(order).toEqual(["published", "saved"]);
    expect(await sql`SELECT status FROM actions WHERE id=${actionId}`).toEqual([{ status: "blocked" }]);
  }, 20_000);
});
