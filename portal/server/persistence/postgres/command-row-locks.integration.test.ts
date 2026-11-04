import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { saveEntity } from "./entity-commands";
import { confirmProjectWanted } from "./project-commands";

/**
 * Entity and project commands lock only the row they change (a follow-up to the publication hold). They used to
 * `SELECT ... JOIN ... FOR UPDATE`, which row-locks every joined row too, and a plain `FOR UPDATE` on
 * the target conflicts with the `KEY SHARE` lock the worker's plan publish takes through its foreign
 * keys. A command then held a project row the publish needed while it waited on the job row the
 * publish held (the command's `recordStateChange` supersedes waiting jobs): Postgres failed one of
 * them with `deadlock detected`. Here a worker-style transaction holds a waiting job row across the
 * command and only then takes the key-share locks; both must finish.
 * Self-contained `_test` database, the same pattern as `session-start-publication-lock.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.COMMAND_ROW_LOCKS_TEST_DATABASE_NAME,
  "openrhen_command_row_locks"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("COMMAND_ROW_LOCKS_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

async function createProject(): Promise<{ areaId: string; outcomeId: string; projectId: string }> {
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<
    { id: string }[]
  >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Project','active') RETURNING id`;
  return { areaId: area[0]!.id, outcomeId: outcome[0]!.id, projectId: project[0]!.id };
}

/** A plan-forecast job still waiting, which the command's own state change supersedes. */
async function storeWaitingJob(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO jobs (type,payload,idempotency_key,status,available_at)
    VALUES ('plan_forecast.recalculate.v1',${sql.json({ userId, cause: "state_change" } as never)},${"plan_forecast.recalculate.v1:" + userId + ":waiting"},'pending',${new Date(0)})
    RETURNING id
  `;
  return rows[0]!.id;
}

/** Waits until another backend is blocked on a lock, so the worker side moves only once the command is waiting. */
async function untilABackendWaits(): Promise<void> {
  // Polled from the pool, not the holder: a transaction sees one pg_stat_activity snapshot throughout.
  for (let attempt = 0; attempt < 60; attempt++) {
    const waiting = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`;
    if (waiting[0]!.count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The command never waited on the job row the worker held.");
}

/**
 * Runs `command` while a worker-style transaction holds the waiting job row, then has the worker take
 * the key-share locks the publish takes through its foreign keys. The worker does not take the
 * publication lock here, so the command reaches its row locks before it waits on the job.
 */
async function commandAgainstPublish(
  command: () => Promise<unknown>,
  keyShare: (worker: postgres.TransactionSql) => Promise<unknown>
): Promise<void> {
  const jobId = await storeWaitingJob();
  let running: Promise<unknown> = Promise.resolve();
  await sql.begin(async (worker) => {
    await worker`SELECT id FROM jobs WHERE id=${jobId} FOR UPDATE`;
    running = command();
    // Keep a rejection from going unhandled while the worker side waits; it is awaited below.
    running.catch(() => undefined);
    await untilABackendWaits();
    await keyShare(worker);
  });
  await running;
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
    "TRUNCATE TABLE jobs, writes, write_rows, planning_runs, actions, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

describe("entity and project commands against a plan publish in flight", () => {
  it("lets a project command and the publish's key-share lock on the project both finish", async () => {
    const { projectId } = await createProject();
    const rows = await sql<{ version: number }[]>`SELECT version FROM projects WHERE id=${projectId}`;
    await commandAgainstPublish(
      () =>
        confirmProjectWanted(
          sql as never,
          {
            commandId: crypto.randomUUID(),
            type: "confirm_project_wanted",
            projectId,
            expectedVersion: rows[0]!.version
          } as never
        ),
      async (worker) => {
        await worker`SELECT id FROM projects WHERE id=${projectId} FOR KEY SHARE`;
      }
    );
    const after = await sql<{ version: number }[]>`SELECT version FROM projects WHERE id=${projectId}`;
    expect(after[0]!.version).toBe(rows[0]!.version + 1);
  }, 20_000);

  it("lets an entity command and the publish's key-share lock on the row both finish", async () => {
    const { areaId, outcomeId } = await createProject();
    const rows = await sql<{ version: number }[]>`SELECT version FROM outcomes WHERE id=${outcomeId}`;
    await commandAgainstPublish(
      () =>
        saveEntity(
          sql as never,
          {
            commandId: crypto.randomUUID(),
            expectedVersion: rows[0]!.version,
            type: "save_entity",
            entityType: "outcome",
            entity: {
              id: outcomeId,
              areaId,
              title: "Outcome, retitled",
              definitionOfDone: "Done",
              value: 3,
              status: "active"
            }
          } as never
        ),
      async (worker) => {
        await worker`SELECT id FROM outcomes WHERE id=${outcomeId} FOR KEY SHARE`;
      }
    );
    const after = await sql<{ title: string }[]>`SELECT title FROM outcomes WHERE id=${outcomeId}`;
    expect(after[0]!.title).toBe("Outcome, retitled");
  }, 20_000);
});
