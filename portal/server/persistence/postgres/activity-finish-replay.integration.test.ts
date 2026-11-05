import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { CommandIdReusedError } from "./command-errors";
import { runActivityCommand } from "./activity-commands";

/**
 * A `finish_activity` repeated under the same command id after the first try landed. The first try closed the
 * session, so the repeat has no open session to address; the receipt is checked before the session is read, so
 * it replays (current state, nothing written again) instead of failing "not found". A different write under the
 * same id is still refused. This is what lets the CLI answer `replayed: true, applied: false` to a retried finish.
 * Own `_test` database; belongs to `corepack pnpm test:integration`.
 */

// Resolved from this file rather than from `process.cwd()`, so the one `.env` is found whether the
// suite is collected from `portal/` or from the repository root.
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.ACTIVITY_FINISH_REPLAY_TEST_DATABASE_NAME,
  "openrhen_activity_finish_replay"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ACTIVITY_FINISH_REPLAY_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

async function createCommitment(): Promise<string> {
  const id = crypto.randomUUID();
  const startsAt = new Date(Date.now() - 3_600_000);
  const endsAt = new Date(Date.now() + 3_600_000);
  await sql`
    INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status)
    VALUES (${id},${userId},'Work',${startsAt},${endsAt},'confirmed')
  `;
  return id;
}

/** A running session with one open segment started `startedMinutesAgo` minutes ago. */
async function createRunningSession(
  commitmentId: string,
  startedMinutesAgo: number
): Promise<{ id: string; version: number; segmentStartedAt: Date }> {
  const id = crypto.randomUUID();
  const startedAt = new Date(Date.now() - startedMinutesAgo * 60_000);
  const plannedEnd = new Date(Date.now() + 3_600_000);
  await sql`
    INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
    VALUES (${id},${userId},'fixed_commitment',${commitmentId},'Fixture session','running',${startedAt},${plannedEnd},${startedAt},60,0)
  `;
  await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${id},${startedAt})`;
  const rows = await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${id}`;
  return { id, version: rows[0]!.version, segmentStartedAt: startedAt };
}

async function sessionRow(id: string): Promise<{ status: string; ended_at: Date | null; active_minutes: number }> {
  const rows = await sql<
    { status: string; ended_at: Date | null; active_minutes: number }[]
  >`SELECT status,ended_at,active_minutes FROM sessions WHERE id=${id}`;
  return rows[0]!;
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
    "TRUNCATE TABLE writes, write_rows, session_segments, sessions, routine_steps, commitments, sleep_plans RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

describe("finish_activity retried under the same command id", () => {
  it("replays from the receipt once the first try has closed the session", async () => {
    const commitmentId = await createCommitment();
    const session = await createRunningSession(commitmentId, 30);
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity" as const,
      sessionId: session.id,
      outcome: "completed" as const
    };
    await runActivityCommand(sql, command);
    const closed = await sessionRow(session.id);
    expect(closed.status).toBe("completed");

    // The honest repeat re-reads the plan: no running session, so no version to send.
    const replay = await runActivityCommand(sql, { ...command, expectedVersion: null });
    expect(replay.activeSession).toBeNull();
    const after = await sessionRow(session.id);
    expect(after.ended_at?.getTime()).toBe(closed.ended_at?.getTime());
    expect(after.active_minutes).toBe(closed.active_minutes);
    const receipts = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM writes WHERE id=${command.commandId}`;
    expect(receipts[0]!.n).toBe(1);
  });

  it("refuses the same command id for a different finish", async () => {
    const commitmentId = await createCommitment();
    const session = await createRunningSession(commitmentId, 30);
    const commandId = crypto.randomUUID();
    await runActivityCommand(sql, {
      commandId,
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    await expect(
      runActivityCommand(sql, {
        commandId,
        expectedVersion: null,
        type: "finish_activity",
        sessionId: session.id,
        outcome: "stopped"
      })
    ).rejects.toBeInstanceOf(CommandIdReusedError);
  });
});
