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
import { runSessionCommand } from "./session-commands";

/**
 * Backfilling an action session (the design notes, "Ending a backfilled
 * session"). The activity commands used to accept an action session and fall through to the sleep
 * branch, setting `last_woke_at` to now so every later backfilled start was refused; a refused
 * `stopped` then left the session open for a later finish to close at now. They now refuse it before
 * writing, and the action `finish` takes the past `endedAt` instead, from a running session or one awaiting
 * feedback (a planned end that passed with no page open closes the segment at the planned end, and
 * `endedAt` then says when the work really stopped). Self-contained `_test` database, the same pattern as
 * `activity-commands-ended-at.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.ACTION_SESSION_BACKFILL_TEST_DATABASE_NAME,
  "openrhen_action_session_backfill"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ACTION_SESSION_BACKFILL_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function createAction(): Promise<string> {
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<
    { id: string }[]
  >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Project','active') RETURNING id`;
  const action = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${project[0]!.id},'Draft citations','one_off','doing',30,60,90,60,'medium',15,90)
    RETURNING id
  `;
  return action[0]!.id;
}

/** A running action session (`target_type` left at its default, `action`) with one open segment, as a backfilled start leaves it. */
async function createActionSession(
  actionId: string,
  startedMinutesAgo: number
): Promise<{ id: string; version: number; startedAt: Date }> {
  const id = crypto.randomUUID();
  const startedAt = minutesAgo(startedMinutesAgo);
  await sql`
    INSERT INTO sessions (id,user_id,action_id,status,planned_started_at,planned_end_at,started_at,started_recorded_at,planned_minutes,remaining_before_minutes)
    VALUES (${id},${userId},${actionId},'running',${startedAt},${new Date(startedAt.getTime() + 60 * 60_000)},${startedAt},${new Date()},60,60)
  `;
  await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${id},${startedAt})`;
  const rows = await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${id}`;
  return { id, version: rows[0]!.version, startedAt };
}

/** An action session already awaiting feedback, its segments closed as given (minutes ago, start then end). */
async function createAwaitingFeedbackSession(
  actionId: string,
  segments: [number, number][]
): Promise<{ id: string; version: number; startedAt: Date }> {
  const id = crypto.randomUUID();
  const startedAt = minutesAgo(segments[0]![0]);
  await sql`
    INSERT INTO sessions (id,user_id,action_id,status,planned_started_at,planned_end_at,started_at,started_recorded_at,planned_minutes,remaining_before_minutes,feedback_requested_at)
    VALUES (${id},${userId},${actionId},'awaiting_feedback',${startedAt},${minutesAgo(segments.at(-1)![1])},${startedAt},${new Date()},60,60,${new Date()})
  `;
  for (const [from, to] of segments)
    await sql`INSERT INTO session_segments (session_id,started_at,ended_at) VALUES (${id},${minutesAgo(from)},${minutesAgo(to)})`;
  const rows = await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${id}`;
  return { id, version: rows[0]!.version, startedAt };
}

/** A current engine result that allows a continuation of `minutes`, as the `continue` command requires. */
async function storeContinuation(actionId: string, minutes: number): Promise<void> {
  const now = new Date();
  const validUntil = new Date(now.getTime() + 3_600_000);
  await sql`
    INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
    VALUES (
      ${userId},${crypto.randomUUID()},'v1','1','v1',${now},${validUntil},
      ${sql.json({
        contractVersion: "1",
        requestId: crypto.randomUUID(),
        inputVersion: "v1",
        engineVersion: "v1",
        calculatedAt: now.toISOString(),
        validUntil: validUntil.toISOString(),
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
        currentDirective: { kind: "action", targetId: actionId, title: "Fixture", recommendedMinutes: minutes },
        upcomingDirectives: [],
        continuation: { safe: true, recommendedMinutes: minutes }
      } as never)}
    )
  `;
}

async function segmentEnds(sessionId: string): Promise<number[]> {
  const rows = await sql<
    { ended_at: Date | null }[]
  >`SELECT ended_at FROM session_segments WHERE session_id=${sessionId} ORDER BY started_at`;
  return rows.map((row) => row.ended_at!.getTime());
}

async function sessionRow(id: string) {
  const rows = await sql<
    {
      status: string;
      ended_at: Date | null;
      ended_recorded_at: Date | null;
      active_minutes: number | null;
      version: number;
    }[]
  >`SELECT status,ended_at,ended_recorded_at,active_minutes,version FROM sessions WHERE id=${id}`;
  return rows[0]!;
}

async function lastWokeAt(): Promise<Date | null> {
  const rows = await sql<
    { last_woke_at: Date | null }[]
  >`SELECT last_woke_at FROM user_preferences WHERE user_id=${userId}`;
  return rows[0]?.last_woke_at ?? null;
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
    "TRUNCATE TABLE writes, write_rows, session_segments, sessions, actions, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
  await sql`UPDATE user_preferences SET last_woke_at=${minutesAgo(8 * 60)} WHERE user_id=${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

describe("the activity commands on an action session", () => {
  it("refuses finish_activity with an endedAt, leaving the session open and the last wake where it was", async () => {
    const woke = await lastWokeAt();
    const session = await createActionSession(await createAction(), 90);
    await expect(
      runActivityCommand(sql, {
        commandId: crypto.randomUUID(),
        expectedVersion: session.version,
        type: "finish_activity",
        sessionId: session.id,
        outcome: "completed",
        endedAt: minutesAgo(45).toISOString()
      })
    ).rejects.toThrow(/action session/);
    const row = await sessionRow(session.id);
    expect(row.status).toBe("running");
    expect(row.ended_at).toBeNull();
    expect(row.version).toBe(session.version);
    expect((await lastWokeAt())?.getTime()).toBe(woke?.getTime());
  });

  it("refuses a stopped outcome and pause the same way, before any write", async () => {
    const session = await createActionSession(await createAction(), 90);
    for (const command of [
      { type: "finish_activity" as const, outcome: "stopped" as const },
      { type: "pause_activity" as const }
    ])
      await expect(
        runActivityCommand(sql, {
          commandId: crypto.randomUUID(),
          expectedVersion: session.version,
          sessionId: session.id,
          ...command
        })
      ).rejects.toThrow(InvalidCommandError);
    const row = await sessionRow(session.id);
    expect(row.status).toBe("running");
    expect(row.version).toBe(session.version);
    const open = await sql<
      { count: number }[]
    >`SELECT count(*)::int count FROM session_segments WHERE session_id=${session.id} AND ended_at IS NULL`;
    expect(open[0]!.count).toBe(1);
  });
});

describe("the action finish's endedAt", () => {
  it("ends the session and its segment at endedAt, credits the minutes to then, and stamps ended_recorded_at", async () => {
    const actionId = await createAction();
    const session = await createActionSession(actionId, 90);
    const endedAt = minutesAgo(45);
    const before = Date.now();
    await runSessionCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish",
      sessionId: session.id,
      outcome: "completed",
      endedAt: endedAt.toISOString()
    });
    const row = await sessionRow(session.id);
    expect(row.status).toBe("completed");
    expect(row.ended_at?.getTime()).toBe(endedAt.getTime());
    // 90 minutes ago to 45 minutes ago, not the 90 a close at now would have credited.
    expect(row.active_minutes).toBe(45);
    expect(row.ended_recorded_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const action = await sql<
      { status: string; last_worked_at: Date | null; completed_at: Date | null }[]
    >`SELECT status,last_worked_at,completed_at FROM actions WHERE id=${actionId}`;
    expect(action[0]!.status).toBe("done");
    expect(action[0]!.last_worked_at?.getTime()).toBe(endedAt.getTime());
    expect(action[0]!.completed_at?.getTime()).toBe(endedAt.getTime());
  });

  it("leaves the last wake alone, so a later backfilled start between endedAt and now is not refused for it", async () => {
    const woke = await lastWokeAt();
    const session = await createActionSession(await createAction(), 90);
    await runSessionCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish",
      sessionId: session.id,
      outcome: "progress",
      remainingMinutes: 20,
      endedAt: minutesAgo(45).toISOString()
    });
    expect((await lastWokeAt())?.getTime()).toBe(woke?.getTime());
    const row = await sessionRow(session.id);
    expect(row.status).toBe("stopped");
    expect(row.ended_at!.getTime()).toBeLessThan(minutesAgo(30).getTime());
  });

  it("refuses an endedAt at or before the start, or later than now, and leaves the session open", async () => {
    const session = await createActionSession(await createAction(), 90);
    for (const endedAt of [session.startedAt, new Date(Date.now() + 5 * 60_000)])
      await expect(
        runSessionCommand(sql, {
          commandId: crypto.randomUUID(),
          expectedVersion: session.version,
          type: "finish",
          sessionId: session.id,
          outcome: "completed",
          endedAt: endedAt.toISOString()
        })
      ).rejects.toThrow(InvalidCommandError);
    expect((await sessionRow(session.id)).status).toBe("running");
  });

  it("closes at real now with ended_recorded_at null when endedAt is omitted", async () => {
    const session = await createActionSession(await createAction(), 10);
    const before = Date.now();
    await runSessionCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish",
      sessionId: session.id,
      outcome: "completed"
    });
    const row = await sessionRow(session.id);
    expect(row.ended_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.ended_recorded_at).toBeNull();
  });
});

describe("the checkpoint when the planned end passed with no page open", () => {
  const requestFeedback = (session: { id: string; version: number }) =>
    runSessionCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "request_feedback",
      sessionId: session.id
    });

  it("closes a late request's segment at the planned end, not when the page opened", async () => {
    // Started 90 minutes ago for 60: the planned end was 30 minutes ago.
    const session = await createActionSession(await createAction(), 90);
    const before = Date.now();
    await requestFeedback(session);
    const row = await sessionRow(session.id);
    expect(row.status).toBe("awaiting_feedback");
    expect(await segmentEnds(session.id)).toEqual([session.startedAt.getTime() + 60 * 60_000]);
    // The request itself is still stamped with the real time it arrived.
    const requested = await sql<
      { feedback_requested_at: Date }[]
    >`SELECT feedback_requested_at FROM sessions WHERE id=${session.id}`;
    expect(requested[0]!.feedback_requested_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("closes an on-time request's segment at now, as before", async () => {
    const session = await createActionSession(await createAction(), 10);
    const before = Date.now();
    await requestFeedback(session);
    const after = Date.now();
    const [end] = await segmentEnds(session.id);
    expect(end).toBeGreaterThanOrEqual(before - 1000);
    expect(end).toBeLessThanOrEqual(after + 1000);
  });

  it("never closes a segment at or before its own start, however the planned end got behind it", async () => {
    // A resume with nothing left of the allowance puts the planned end at the new segment's start or before it.
    const session = await createActionSession(await createAction(), 5);
    await sql`UPDATE sessions SET planned_end_at=${minutesAgo(10)} WHERE id=${session.id}`;
    await requestFeedback(session);
    const [end] = await segmentEnds(session.id);
    expect(end).toBe(session.startedAt.getTime() + 1);
  });

  it("finishes it as of the chosen time, replacing the segment's end and following it everywhere", async () => {
    const actionId = await createAction();
    const session = await createActionSession(actionId, 90);
    await requestFeedback(session);
    const awaiting = await sessionRow(session.id);
    const endedAt = minutesAgo(45);
    const before = Date.now();
    await runSessionCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: awaiting.version,
      type: "finish",
      sessionId: session.id,
      outcome: "completed",
      endedAt: endedAt.toISOString()
    });
    const row = await sessionRow(session.id);
    expect(row.status).toBe("completed");
    expect(row.ended_at?.getTime()).toBe(endedAt.getTime());
    expect(await segmentEnds(session.id)).toEqual([endedAt.getTime()]);
    // 90 minutes ago to 45 minutes ago, not the 60 the planned end alone would have credited.
    expect(row.active_minutes).toBe(45);
    expect(row.ended_recorded_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const action = await sql<
      { status: string; last_worked_at: Date | null; completed_at: Date | null }[]
    >`SELECT status,last_worked_at,completed_at FROM actions WHERE id=${actionId}`;
    expect(action[0]!.status).toBe("done");
    expect(action[0]!.last_worked_at?.getTime()).toBe(endedAt.getTime());
    expect(action[0]!.completed_at?.getTime()).toBe(endedAt.getTime());
  });

  it("lets the chosen time run past the planned end, as far as now", async () => {
    const session = await createActionSession(await createAction(), 90);
    await requestFeedback(session);
    const awaiting = await sessionRow(session.id);
    await runSessionCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: awaiting.version,
      type: "finish",
      sessionId: session.id,
      outcome: "progress",
      remainingMinutes: 20,
      endedAt: minutesAgo(10).toISOString()
    });
    const row = await sessionRow(session.id);
    expect(row.status).toBe("stopped");
    expect(row.active_minutes).toBe(80);
  });

  it("moves only the last segment of a session that was continued before", async () => {
    const session = await createAwaitingFeedbackSession(await createAction(), [
      [120, 90],
      [60, 30]
    ]);
    const [firstEnd] = await segmentEnds(session.id);
    const endedAt = minutesAgo(40);
    await runSessionCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish",
      sessionId: session.id,
      outcome: "completed",
      endedAt: endedAt.toISOString()
    });
    expect(await segmentEnds(session.id)).toEqual([firstEnd, endedAt.getTime()]);
    // 30 minutes, then 20.
    expect((await sessionRow(session.id)).active_minutes).toBe(50);
  });

  it("refuses a chosen time at or before the last segment's start, or later than now, and leaves it awaiting feedback", async () => {
    const session = await createAwaitingFeedbackSession(await createAction(), [
      [120, 90],
      [60, 30]
    ]);
    const ends = await segmentEnds(session.id);
    const last = await sql<
      { started_at: Date }[]
    >`SELECT started_at FROM session_segments WHERE session_id=${session.id} ORDER BY started_at DESC LIMIT 1`;
    // At the last segment's start, and before it (though after the session itself began).
    for (const [endedAt, message] of [
      [last[0]!.started_at, /must be after/],
      [minutesAgo(75), /must be after/],
      [new Date(Date.now() + 5 * 60_000), /cannot be later than now/]
    ] as const)
      await expect(
        runSessionCommand(sql, {
          commandId: crypto.randomUUID(),
          expectedVersion: session.version,
          type: "finish",
          sessionId: session.id,
          outcome: "completed",
          endedAt: endedAt.toISOString()
        })
      ).rejects.toThrow(message);
    const row = await sessionRow(session.id);
    expect(row.status).toBe("awaiting_feedback");
    expect(row.version).toBe(session.version);
    expect(await segmentEnds(session.id)).toEqual(ends);
  });

  it("finishes without a chosen time as before: the segment stays at the checkpoint and ended_recorded_at stays null", async () => {
    const session = await createActionSession(await createAction(), 90);
    await requestFeedback(session);
    const awaiting = await sessionRow(session.id);
    const before = Date.now();
    await runSessionCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: awaiting.version,
      type: "finish",
      sessionId: session.id,
      outcome: "completed"
    });
    const row = await sessionRow(session.id);
    expect(await segmentEnds(session.id)).toEqual([session.startedAt.getTime() + 60 * 60_000]);
    expect(row.active_minutes).toBe(60);
    expect(row.ended_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.ended_recorded_at).toBeNull();
  });

  it("never stretches a paused session's last segment across the pause once it awaits feedback", async () => {
    // Pause, then the checkpoint from paused, then a chosen end after the pause: the paused time is not work.
    const session = await createActionSession(await createAction(), 30);
    const run = (expectedVersion: number, rest: { type: "pause" | "request_feedback" }) =>
      runSessionCommand(sql, { commandId: crypto.randomUUID(), expectedVersion, sessionId: session.id, ...rest });
    await run(session.version, { type: "pause" });
    await run((await sessionRow(session.id)).version, { type: "request_feedback" });
    const awaiting = await sessionRow(session.id);
    const [pausedAt] = await segmentEnds(session.id);
    const finish = (endedAt: Date) =>
      runSessionCommand(sql, {
        commandId: crypto.randomUUID(),
        expectedVersion: awaiting.version,
        type: "finish",
        sessionId: session.id,
        outcome: "completed",
        endedAt: endedAt.toISOString()
      });
    await expect(finish(new Date())).rejects.toThrow(/when this session stopped/);
    expect(await segmentEnds(session.id)).toEqual([pausedAt]);
    expect((await sessionRow(session.id)).status).toBe("awaiting_feedback");
    // An earlier time is still a correction it can take.
    const chosen = minutesAgo(20);
    await finish(chosen);
    expect(await segmentEnds(session.id)).toEqual([chosen.getTime()]);
  });

  it("forgets the pause once a session awaiting feedback is continued, so a later late checkpoint can run on", async () => {
    const actionId = await createAction();
    const session = await createActionSession(actionId, 30);
    const run = (rest: { type: "pause" | "request_feedback" } | { type: "continue"; requestedMinutes: number }) =>
      sessionRow(session.id).then((row) =>
        runSessionCommand(sql, {
          commandId: crypto.randomUUID(),
          expectedVersion: row.version,
          sessionId: session.id,
          ...rest
        })
      );
    await run({ type: "pause" });
    await run({ type: "request_feedback" });
    await storeContinuation(actionId, 15);
    await run({ type: "continue", requestedMinutes: 15 });
    const rows = await sql<
      { status: string; paused_remaining_seconds: number | null }[]
    >`SELECT status,paused_remaining_seconds FROM sessions WHERE id=${session.id}`;
    expect(rows[0]).toEqual({ status: "running", paused_remaining_seconds: null });
  });

  it("refuses to run past a checkpoint the person reached on time", async () => {
    // The segment ended when feedback was asked for, so that end was seen, not assumed.
    const session = await createAwaitingFeedbackSession(await createAction(), [[40, 10]]);
    await sql`UPDATE sessions SET feedback_requested_at=(SELECT ended_at FROM session_segments WHERE session_id=${session.id}) WHERE id=${session.id}`;
    await expect(
      runSessionCommand(sql, {
        commandId: crypto.randomUUID(),
        expectedVersion: session.version,
        type: "finish",
        sessionId: session.id,
        outcome: "completed",
        endedAt: minutesAgo(5).toISOString()
      })
    ).rejects.toThrow(/when this session stopped/);
    expect((await sessionRow(session.id)).status).toBe("awaiting_feedback");
  });

  it("pauses a session past its planned end with nothing left, never a negative remainder", async () => {
    const session = await createActionSession(await createAction(), 90);
    await runSessionCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "pause",
      sessionId: session.id
    });
    const rows = await sql<
      { status: string; paused_remaining_seconds: number | null }[]
    >`SELECT status,paused_remaining_seconds FROM sessions WHERE id=${session.id}`;
    expect(rows[0]).toEqual({ status: "paused", paused_remaining_seconds: 0 });
  });

  it("still refuses a chosen time for a paused session", async () => {
    const session = await createActionSession(await createAction(), 30);
    await runSessionCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "pause",
      sessionId: session.id
    });
    const paused = await sessionRow(session.id);
    await expect(
      runSessionCommand(sql, {
        commandId: crypto.randomUUID(),
        expectedVersion: paused.version,
        type: "finish",
        sessionId: session.id,
        outcome: "completed",
        endedAt: minutesAgo(15).toISOString()
      })
    ).rejects.toThrow(/paused session cannot be given/);
    expect((await sessionRow(session.id)).status).toBe("paused");
  });
});
