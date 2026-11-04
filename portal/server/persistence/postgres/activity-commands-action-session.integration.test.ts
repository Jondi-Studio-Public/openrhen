import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { InvalidCommandError } from "./command-errors";
import { runActivityCommand } from "./activity-commands";

/**
 * `finish_activity` is for the activity surface (routine steps, sleep, commitments, deliverables). An
 * action session ends through the session command, which also settles the action; finishing one here
 * would close the session and leave its action `doing`. Runs against its own `_test` database, same
 * self-contained pattern as `activity-commands-ended-at.integration.test.ts`, so it belongs to
 * `corepack pnpm test:integration`.
 */

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.ACTIVITY_ACTION_SESSION_TEST_DATABASE_NAME,
  "openrhen_activity_action_session"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ACTIVITY_ACTION_SESSION_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

async function createRunningActionSession(): Promise<{ id: string; version: number }> {
  const id = crypto.randomUUID();
  const startedAt = new Date(Date.now() - 5 * 60_000);
  const plannedEnd = new Date(Date.now() + 10 * 60_000);
  await sql`
    INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
    VALUES (${id},${userId},'action',${crypto.randomUUID()},'Fixture action','running',${startedAt},${plannedEnd},${startedAt},15,15)
  `;
  await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${id},${startedAt})`;
  const rows = await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${id}`;
  return { id, version: rows[0]!.version };
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
  await sql.unsafe("TRUNCATE TABLE writes, write_rows, session_segments, sessions RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await sql?.end();
});

describe("finish_activity on an action session", () => {
  it("refuses, naming the session command, and leaves the session running", async () => {
    const session = await createRunningActionSession();
    await expect(
      runActivityCommand(sql, {
        commandId: crypto.randomUUID(),
        expectedVersion: session.version,
        type: "finish_activity",
        sessionId: session.id,
        outcome: "completed"
      })
    ).rejects.toThrow(InvalidCommandError);
    await expect(
      runActivityCommand(sql, {
        commandId: crypto.randomUUID(),
        expectedVersion: session.version,
        type: "finish_activity",
        sessionId: session.id,
        outcome: "completed",
        endedAt: new Date(Date.now() - 60_000).toISOString()
      })
    ).rejects.toThrow("rhen session finish");
    const rows = await sql<{ status: string; ended_at: Date | null }[]>`
      SELECT status,ended_at FROM sessions WHERE id=${session.id}
    `;
    expect(rows[0]).toMatchObject({ status: "running", ended_at: null });
  });
});
