import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { InvalidCommandError } from "./command-errors";
import { formatZonedMoment } from "@/shared/date-format";
import { runActivityCommand } from "./activity-commands";
import { readPortalState } from "./state-read";

/**
 * `finish_activity`'s optional `endedAt` (the session reconciliation design note, "Two clocks" and
 * "Bounds"): a chosen retroactive end closes the open segment there instead of at real now, credits
 * `active_minutes` from the segments as always, and leaves `sessions.updated_at`/`ended_recorded_at`
 * on real now. Runs against its own `_test` database, same self-contained pattern as
 * `activity-commands-overtime.integration.test.ts`, and so belongs to `corepack pnpm test:integration`:
 * the plain unit run opens no database.
 */

// Resolved from this file rather than from `process.cwd()`, so the one `.env` is found whether the
// suite is collected from `portal/` or from the repository root.
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.ACTIVITY_ENDED_AT_TEST_DATABASE_NAME,
  "openrhen_activity_ended_at"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ACTIVITY_ENDED_AT_TEST_DATABASE_NAME must be an identifier ending in _test");
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

/** A paused session — its one segment is already closed, matching what `pause_activity` leaves behind. */
async function createPausedSession(commitmentId: string): Promise<{ id: string; version: number }> {
  const id = crypto.randomUUID();
  const startedAt = new Date(Date.now() - 3_600_000);
  const segmentEndedAt = new Date(Date.now() - 1_800_000);
  const plannedEnd = new Date(Date.now() + 3_600_000);
  await sql`
    INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes,paused_remaining_seconds)
    VALUES (${id},${userId},'fixed_commitment',${commitmentId},'Fixture session','paused',${startedAt},${plannedEnd},${startedAt},60,0,1800)
  `;
  await sql`INSERT INTO session_segments (session_id,started_at,ended_at) VALUES (${id},${startedAt},${segmentEndedAt})`;
  const rows = await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${id}`;
  return { id, version: rows[0]!.version };
}

/**
 * A session awaiting feedback, its one segment closed at the checkpoint. The status is set directly:
 * `request_feedback` itself only takes action and deliverable sessions, and `finish_activity`'s end
 * handling does not depend on the target.
 */
async function createAwaitingFeedbackSession(
  commitmentId: string
): Promise<{ id: string; version: number; segmentStartedAt: Date; segmentEndedAt: Date }> {
  const id = crypto.randomUUID();
  const startedAt = new Date(Date.now() - 90 * 60_000);
  const segmentEndedAt = new Date(Date.now() - 30 * 60_000);
  await sql`
    INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes,feedback_requested_at)
    VALUES (${id},${userId},'fixed_commitment',${commitmentId},'Fixture session','awaiting_feedback',${startedAt},${segmentEndedAt},${startedAt},60,0,${new Date()})
  `;
  await sql`INSERT INTO session_segments (session_id,started_at,ended_at) VALUES (${id},${startedAt},${segmentEndedAt})`;
  const rows = await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${id}`;
  return { id, version: rows[0]!.version, segmentStartedAt: startedAt, segmentEndedAt };
}

async function sessionRow(
  id: string
): Promise<{ status: string; ended_at: Date | null; ended_recorded_at: Date | null; active_minutes: number }> {
  const rows = await sql<
    { status: string; ended_at: Date | null; ended_recorded_at: Date | null; active_minutes: number }[]
  >`SELECT status,ended_at,ended_recorded_at,active_minutes FROM sessions WHERE id=${id}`;
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

describe("finish_activity's endedAt", () => {
  it("closes the open segment at the chosen time, credits active_minutes from it, and stamps ended_recorded_at at real now", async () => {
    const commitmentId = await createCommitment();
    const session = await createRunningSession(commitmentId, 60);
    const endedAt = new Date(Date.now() - 30 * 60_000);
    const before = Date.now();
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed",
      endedAt: endedAt.toISOString()
    });
    const after = Date.now();
    const row = await sessionRow(session.id);
    expect(row.status).toBe("completed");
    expect(row.ended_at?.getTime()).toBe(endedAt.getTime());
    // Started 60 minutes ago, closed 30 minutes ago: 30 minutes of active time, not the ~60 a
    // now-anchored close would have credited.
    expect(row.active_minutes).toBe(30);
    expect(row.ended_recorded_at).not.toBeNull();
    expect(row.ended_recorded_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.ended_recorded_at!.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it("refuses an endedAt at or before the open segment's start, naming the floor", async () => {
    const commitmentId = await createCommitment();
    const session = await createRunningSession(commitmentId, 60);
    await expect(
      runActivityCommand(sql, {
        commandId: crypto.randomUUID(),
        expectedVersion: session.version,
        type: "finish_activity",
        sessionId: session.id,
        outcome: "completed",
        endedAt: session.segmentStartedAt.toISOString()
      })
    ).rejects.toThrow(InvalidCommandError);
  });

  it("names that floor as a clock time in the person's timezone, not as UTC ISO text", async () => {
    await sql`UPDATE users SET timezone='Australia/Brisbane'`;
    const commitmentId = await createCommitment();
    const session = await createRunningSession(commitmentId, 60);
    const thrown = await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed",
      endedAt: session.segmentStartedAt.toISOString()
    }).catch((error: Error) => error);
    const floor = formatZonedMoment(session.segmentStartedAt, "Australia/Brisbane", new Date());
    expect((thrown as Error).message).toBe(`The end time must be after ${floor}.`);
    expect((thrown as Error).message).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses an endedAt later than now", async () => {
    const commitmentId = await createCommitment();
    const session = await createRunningSession(commitmentId, 60);
    const future = new Date(Date.now() + 5 * 60_000);
    await expect(
      runActivityCommand(sql, {
        commandId: crypto.randomUUID(),
        expectedVersion: session.version,
        type: "finish_activity",
        sessionId: session.id,
        outcome: "completed",
        endedAt: future.toISOString()
      })
    ).rejects.toThrow(InvalidCommandError);
  });

  it("refuses endedAt outright for a paused session, regardless of value", async () => {
    const commitmentId = await createCommitment();
    const session = await createPausedSession(commitmentId);
    await expect(
      runActivityCommand(sql, {
        commandId: crypto.randomUUID(),
        expectedVersion: session.version,
        type: "finish_activity",
        sessionId: session.id,
        outcome: "completed",
        endedAt: new Date(Date.now() - 60_000).toISOString()
      })
    ).rejects.toThrow(InvalidCommandError);
  });

  it("omitting endedAt behaves exactly as before: closes at real now and leaves ended_recorded_at null", async () => {
    const commitmentId = await createCommitment();
    const session = await createRunningSession(commitmentId, 10);
    const before = Date.now();
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    const after = Date.now();
    const row = await sessionRow(session.id);
    expect(row.status).toBe("completed");
    expect(row.ended_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.ended_at!.getTime()).toBeLessThanOrEqual(after + 1000);
    expect(row.ended_recorded_at).toBeNull();
  });

  // Audit, "sessions logged to a past day never show in History": the archived note deferred a dated
  // History because it took `completedToday` at its name. The read reaches back HISTORY_WINDOW_DAYS
  // local days by `ended_at`, and `/history` renders every row of it, so a session ended on an earlier
  // day is already there. This pins that, since the field's name keeps inviting a today-only filter.
  it("puts a session ended on an earlier day into the state read that /history renders", async () => {
    const commitmentId = await createCommitment();
    const session = await createRunningSession(commitmentId, 30 * 60);
    const endedAt = new Date(Date.now() - 26 * 3_600_000);
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed",
      endedAt: endedAt.toISOString()
    });
    const state = await readPortalState(sql);
    const row = state!.completedToday.find((item) => item.id === session.id);
    expect(row?.endedAt).toBe(endedAt.toISOString());
    expect(row?.activeMinutes).toBe(4 * 60);
  });
});

describe("finish_activity's endedAt on a session awaiting feedback", () => {
  it("replaces the end of the segment the checkpoint closed, and follows it into ended_at and active_minutes", async () => {
    const session = await createAwaitingFeedbackSession(await createCommitment());
    const endedAt = new Date(Date.now() - 45 * 60_000);
    const before = Date.now();
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed",
      endedAt: endedAt.toISOString()
    });
    const row = await sessionRow(session.id);
    expect(row.status).toBe("completed");
    expect(row.ended_at?.getTime()).toBe(endedAt.getTime());
    // Started 90 minutes ago, ended 45 minutes ago: not the 60 the checkpoint's own close credited.
    expect(row.active_minutes).toBe(45);
    expect(row.ended_recorded_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const segments = await sql<
      { ended_at: Date }[]
    >`SELECT ended_at FROM session_segments WHERE session_id=${session.id}`;
    expect(segments.map((segment) => segment.ended_at.getTime())).toEqual([endedAt.getTime()]);
  });

  it("refuses an endedAt at or before the segment's start, or later than now, leaving the checkpoint's close alone", async () => {
    const session = await createAwaitingFeedbackSession(await createCommitment());
    for (const [endedAt, message] of [
      [session.segmentStartedAt, /must be after/],
      [new Date(Date.now() + 5 * 60_000), /cannot be later than now/]
    ] as const)
      await expect(
        runActivityCommand(sql, {
          commandId: crypto.randomUUID(),
          expectedVersion: session.version,
          type: "finish_activity",
          sessionId: session.id,
          outcome: "completed",
          endedAt: endedAt.toISOString()
        })
      ).rejects.toThrow(message);
    expect((await sessionRow(session.id)).status).toBe("awaiting_feedback");
    const segments = await sql<
      { ended_at: Date }[]
    >`SELECT ended_at FROM session_segments WHERE session_id=${session.id}`;
    expect(segments[0]!.ended_at.getTime()).toBe(session.segmentEndedAt.getTime());
  });

  it("without endedAt, ends at real now and keeps the checkpoint's close", async () => {
    const session = await createAwaitingFeedbackSession(await createCommitment());
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    const row = await sessionRow(session.id);
    expect(row.active_minutes).toBe(60);
    expect(row.ended_recorded_at).toBeNull();
  });
});

describe("finish_activity's endedAt on a sleep", () => {
  it("records the chosen wake as actual_wake_at, last_woke_at and the night's length, not real now", async () => {
    const planId = crypto.randomUUID();
    const startedAt = new Date(Date.now() - 9 * 3_600_000);
    await sql`
      INSERT INTO sleep_plans (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,explanation,status,actual_start_at)
      VALUES (${planId},${userId},${startedAt},${new Date(startedAt.getTime() + 8 * 3_600_000)},480,480,'Fixture','sleeping',${startedAt})
    `;
    const sessionId = crypto.randomUUID();
    await sql`
      INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
      VALUES (${sessionId},${userId},'sleep',${planId},'Sleep','running',${startedAt},${new Date(startedAt.getTime() + 8 * 3_600_000)},${startedAt},480,0)
    `;
    await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${sessionId},${startedAt})`;
    const version = (await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${sessionId}`)[0]!.version;
    const wokeAt = new Date(startedAt.getTime() + 450 * 60_000);
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: version,
      type: "finish_activity",
      sessionId,
      outcome: "completed",
      endedAt: wokeAt.toISOString()
    });
    const plan = await sql<
      { actual_wake_at: Date; allowed_minutes: number; sleep_deficit_minutes: number }[]
    >`SELECT actual_wake_at,allowed_minutes,sleep_deficit_minutes FROM sleep_plans WHERE id=${planId}`;
    expect(plan[0]!.actual_wake_at.getTime()).toBe(wokeAt.getTime());
    expect(plan[0]!.allowed_minutes).toBe(450);
    expect(plan[0]!.sleep_deficit_minutes).toBe(30);
    const prefs = await sql<
      { last_woke_at: Date }[]
    >`SELECT last_woke_at FROM user_preferences WHERE user_id=${userId}`;
    expect(prefs[0]!.last_woke_at.getTime()).toBe(wokeAt.getTime());
  });
});
