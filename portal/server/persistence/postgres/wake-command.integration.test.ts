import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { buildNeeds, type WakeResult } from "@openrhen/contracts";
import { integrationDatabaseName, lockPlanForecastPublication } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { ensureUser } from "./ensure-user";
import {
  CommandConflictError,
  ForbiddenCommandError,
  InvalidCommandError,
  NotFoundCommandError
} from "./command-errors";
import { runActivityCommand } from "./activity-commands";
import { saveEntity } from "./entity-commands";
import { runWakeCommand } from "./wake-command";
import { readPortalState } from "./state-read";
import { runRevertCommand } from "./write-revert";

/**
 * `rhen wake`: one transaction that settles last night
 * around when the person woke. Covers the three things it can do (finish a running sleep, complete last night's
 * planned sleep, log the night), the overlap refusal that stops a second night, and `lastWokeAt` reading back as the
 * new wake, and that an agent's wake is undone whole by one revert. Runs against its own `_test` database, the same self-contained pattern as
 * `activity-commands-ended-at.integration.test.ts`.
 */

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.WAKE_TEST_DATABASE_NAME, "rhen_wake");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("WAKE_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const hoursAgo = (hours: number) => minutesAgo(hours * 60);
const iso = (date: Date) => date.toISOString();

interface PlanRow {
  status: string;
  planned_start_at: Date;
  planned_wake_at: Date;
  actual_start_at: Date | null;
  actual_wake_at: Date | null;
  allowed_minutes: number;
  sleep_deficit_minutes: number;
  input_version: string | null;
}

async function plan(id: string): Promise<PlanRow> {
  const rows = await sql<
    PlanRow[]
  >`SELECT status,planned_start_at,planned_wake_at,actual_start_at,actual_wake_at,allowed_minutes,sleep_deficit_minutes,input_version FROM sleep_plans WHERE id=${id}`;
  return rows[0]!;
}

async function plans(): Promise<{ id: string; status: string }[]> {
  return sql<{ id: string; status: string }[]>`SELECT id,status FROM sleep_plans ORDER BY planned_start_at`;
}

async function lastWokeAt(): Promise<Date | null> {
  const rows = await sql<
    { last_woke_at: Date | null }[]
  >`SELECT last_woke_at FROM user_preferences WHERE user_id=${userId}`;
  return rows[0]!.last_woke_at;
}

/** A planned sleep, as the engine leaves it before a night is slept. */
async function plannedSleep(
  startedAt: Date,
  wakesAt: Date,
  scoreComponents: Record<string, unknown> = {}
): Promise<string> {
  const id = crypto.randomUUID();
  const minutes = Math.round((wakesAt.getTime() - startedAt.getTime()) / 60_000);
  await sql`
    INSERT INTO sleep_plans (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,explanation,status,score_components)
    VALUES (${id},${userId},${startedAt},${wakesAt},480,${minutes},'Fixture','planned',${sql.json(scoreComponents as never)})
  `;
  return id;
}

/** A sleep begun with Start on Now: a `sleeping` plan row, and the running session on it. */
async function runningSleep(startedAt: Date): Promise<{ planId: string; sessionId: string }> {
  const planId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const plannedWake = new Date(startedAt.getTime() + 480 * 60_000);
  await sql`
    INSERT INTO sleep_plans (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,explanation,status,actual_start_at,input_version)
    VALUES (${planId},${userId},${startedAt},${plannedWake},480,480,'Fixture','sleeping',${startedAt},'override')
  `;
  await sql`
    INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
    VALUES (${sessionId},${userId},'sleep',${planId},'Sleep','running',${startedAt},${plannedWake},${startedAt},480,0)
  `;
  await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${sessionId},${startedAt})`;
  return { planId, sessionId };
}

/** A sleep paused and resumed: two stretches slept with a gap between them, the second still running. */
async function pausedAndResumedSleep(
  firstStart: Date,
  pausedAt: Date,
  resumedAt: Date
): Promise<{ planId: string; sessionId: string }> {
  const { planId, sessionId } = await runningSleep(firstStart);
  await sql`UPDATE session_segments SET ended_at=${pausedAt} WHERE session_id=${sessionId}`;
  await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${sessionId},${resumedAt})`;
  return { planId, sessionId };
}

async function segmentsOf(sessionId: string): Promise<{ started_at: Date; ended_at: Date | null }[]> {
  return sql<
    { started_at: Date; ended_at: Date | null }[]
  >`SELECT started_at,ended_at FROM session_segments WHERE session_id=${sessionId} ORDER BY started_at`;
}

const wake = (command: { at?: Date; sleptAt?: Date; commandId?: string } = {}) =>
  runWakeCommand(sql, {
    commandId: command.commandId ?? crypto.randomUUID(),
    type: "wake",
    ...(command.at ? { at: iso(command.at) } : {}),
    ...(command.sleptAt ? { sleptAt: iso(command.sleptAt) } : {})
  });

/** The night a wake settled; fails the test for a wake recorded alone. */
function nightOf(result: WakeResult | null | undefined): Exclude<WakeResult, { outcome: "recorded_wake" }> {
  if (!result || result.outcome === "recorded_wake") throw new Error(`Expected a night, got ${JSON.stringify(result)}`);
  return result;
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
    "TRUNCATE TABLE jobs, writes, write_rows, session_segments, sessions, sleep_plans, planning_runs RESTART IDENTITY CASCADE"
  );
  await sql`UPDATE user_preferences SET last_woke_at=NULL,current_situation='{}'::jsonb WHERE user_id=${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

describe("wake: a sleep is running", () => {
  it("finishes it at the given wake, not at the moment it was entered", async () => {
    const startedAt = hoursAgo(9);
    const { planId, sessionId } = await runningSleep(startedAt);
    const woke = hoursAgo(1);
    const { wake: result, state } = await wake({ at: woke });

    expect(result).toEqual({
      outcome: "finished_session",
      sleepPlanId: planId,
      sleptAt: iso(startedAt),
      wokeAt: iso(woke),
      startAssumed: false
    });
    const row = await plan(planId);
    expect(row.status).toBe("completed");
    expect(row.actual_wake_at?.getTime()).toBe(woke.getTime());
    expect(row.allowed_minutes).toBe(480);
    expect(row.sleep_deficit_minutes).toBe(0);
    const session = await sql<
      { status: string; ended_at: Date; active_minutes: number; ended_recorded_at: Date | null }[]
    >`SELECT status,ended_at,active_minutes,ended_recorded_at FROM sessions WHERE id=${sessionId}`;
    expect(session[0]).toMatchObject({ status: "completed", active_minutes: 480 });
    expect(session[0]!.ended_at.getTime()).toBe(woke.getTime());
    // A chosen end is marked as recorded later than it happened.
    expect(session[0]!.ended_recorded_at).not.toBeNull();
    expect((await lastWokeAt())?.getTime()).toBe(woke.getTime());
    expect(new Date(state.settings.lastWokeAt!).getTime()).toBe(woke.getTime());
  });

  it("finishes it at now when no wake is given", async () => {
    const { planId } = await runningSleep(hoursAgo(8));
    const before = Date.now();
    const { wake: result } = await wake();
    expect(result?.outcome).toBe("finished_session");
    const wokeAt = (await plan(planId)).actual_wake_at!.getTime();
    expect(wokeAt).toBeGreaterThanOrEqual(before - 1000);
    expect(wokeAt).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await lastWokeAt())?.getTime()).toBe(wokeAt);
  });

  it("moves the start to --slept-at, on the plan and the session alike", async () => {
    const { planId, sessionId } = await runningSleep(hoursAgo(9));
    const sleptAt = hoursAgo(8.5);
    const woke = hoursAgo(1);
    const { wake: result } = await wake({ at: woke, sleptAt });

    expect(result).toMatchObject({ outcome: "finished_session", sleptAt: iso(sleptAt), startAssumed: false });
    const row = await plan(planId);
    expect(row.actual_start_at?.getTime()).toBe(sleptAt.getTime());
    expect(row.allowed_minutes).toBe(450);
    expect(row.sleep_deficit_minutes).toBe(30);
    const session = await sql<
      { started_at: Date; ended_at: Date; active_minutes: number }[]
    >`SELECT started_at,ended_at,active_minutes FROM sessions WHERE id=${sessionId}`;
    expect(session[0]!.started_at.getTime()).toBe(sleptAt.getTime());
    expect(session[0]!.ended_at.getTime()).toBe(woke.getTime());
    expect(session[0]!.active_minutes).toBe(450);
    const segments = await sql<
      { started_at: Date; ended_at: Date }[]
    >`SELECT started_at,ended_at FROM session_segments WHERE session_id=${sessionId}`;
    expect(segments).toHaveLength(1);
    expect(segments[0]!.started_at.getTime()).toBe(sleptAt.getTime());
    expect(segments[0]!.ended_at.getTime()).toBe(woke.getTime());
  });

  // A pause splits the night into segments; a start and wake told later move only the outer ends, so history keeps
  // the gap and the minutes slept do not count it.
  it("keeps a paused and resumed sleep's segments apart when --slept-at moves its start", async () => {
    const [slept, paused, resumed, woke] = [hoursAgo(9.5), hoursAgo(7), hoursAgo(6), hoursAgo(1)];
    const { planId, sessionId } = await pausedAndResumedSleep(hoursAgo(9), paused, resumed);
    await wake({ at: woke, sleptAt: slept });
    expect((await segmentsOf(sessionId)).map((row) => [row.started_at.getTime(), row.ended_at?.getTime()])).toEqual([
      [slept.getTime(), paused.getTime()],
      [resumed.getTime(), woke.getTime()]
    ]);
    const [session] = await sql<
      { active_minutes: number; started_at: Date }[]
    >`SELECT active_minutes,started_at FROM sessions WHERE id=${sessionId}`;
    // 2.5 h before the pause and 5 h after it; the hour paused is not sleep.
    expect(session!.active_minutes).toBe(450);
    expect(session!.started_at.getTime()).toBe(slept.getTime());
    expect((await plan(planId)).status).toBe("completed");
  });

  // A paused sleep's end is its pause, already recorded; finishing it at now must not stretch that segment to now and
  // count the time paused as sleep.
  it("keeps a paused sleep's pause as its end when --slept-at is told without a wake", async () => {
    const [slept, paused] = [hoursAgo(9.5), hoursAgo(3)];
    const { planId, sessionId } = await runningSleep(hoursAgo(9));
    await sql`UPDATE session_segments SET ended_at=${paused} WHERE session_id=${sessionId}`;
    await sql`UPDATE sessions SET status='paused' WHERE id=${sessionId}`;
    await wake({ sleptAt: slept });
    expect((await segmentsOf(sessionId)).map((row) => [row.started_at.getTime(), row.ended_at?.getTime()])).toEqual([
      [slept.getTime(), paused.getTime()]
    ]);
    const [session] = await sql<
      { active_minutes: number; started_at: Date; status: string }[]
    >`SELECT active_minutes,started_at,status FROM sessions WHERE id=${sessionId}`;
    // 9.5 h ago to the pause 3 h ago; the three hours since are not sleep.
    expect(session).toMatchObject({ active_minutes: 390, status: "completed" });
    expect(session!.started_at.getTime()).toBe(slept.getTime());
    expect((await plan(planId)).status).toBe("completed");
  });

  it("refuses a start after a paused sleep's pause began, and leaves the sleep as it was", async () => {
    const { planId, sessionId } = await runningSleep(hoursAgo(9));
    await sql`UPDATE session_segments SET ended_at=${hoursAgo(3)} WHERE session_id=${sessionId}`;
    await sql`UPDATE sessions SET status='paused' WHERE id=${sessionId}`;
    await expect(wake({ sleptAt: hoursAgo(2) })).rejects.toThrow("paused");
    expect((await plan(planId)).status).toBe("sleeping");
    const [session] = await sql<{ status: string }[]>`SELECT status FROM sessions WHERE id=${sessionId}`;
    expect(session!.status).toBe("paused");
  });

  // A night of one stretch corrected wholly past its old wake: its start and end move together, or the segment
  // would stand for a moment with its start after its end.
  it("lets the sleep log move a night it finished wholly past its old wake", async () => {
    const { planId, sessionId } = await runningSleep(hoursAgo(6));
    await wake({ at: hoursAgo(5) });
    const [sleptAt, wokeAt] = [hoursAgo(4), hoursAgo(3)];
    const [row] = await sql<{ version: number }[]>`SELECT version FROM sleep_plans WHERE id=${planId}`;
    await saveEntity(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: row!.version,
      type: "save_entity",
      entityType: "sleep_log_entry",
      entity: { id: planId, sleepAt: iso(sleptAt), wakeAt: iso(wokeAt) }
    });
    expect((await segmentsOf(sessionId)).map((row) => [row.started_at.getTime(), row.ended_at?.getTime()])).toEqual([
      [sleptAt.getTime(), wokeAt.getTime()]
    ]);
    const [session] = await sql<
      { active_minutes: number }[]
    >`SELECT active_minutes FROM sessions WHERE id=${sessionId}`;
    expect(session!.active_minutes).toBe(60);
  });

  it("refuses a start after a paused sleep's first pause began, and leaves the sleep running", async () => {
    const { planId, sessionId } = await pausedAndResumedSleep(hoursAgo(9), hoursAgo(7), hoursAgo(6));
    await expect(wake({ at: hoursAgo(1), sleptAt: hoursAgo(6.5) })).rejects.toThrow("paused and resumed");
    expect((await plan(planId)).status).toBe("sleeping");
    expect(await segmentsOf(sessionId)).toHaveLength(2);
  });

  it("refuses a wake at or before the sleep's own start, and leaves the sleep running", async () => {
    const { planId, sessionId } = await runningSleep(hoursAgo(2));
    await expect(wake({ at: hoursAgo(3) })).rejects.toThrow(InvalidCommandError);
    expect((await plan(planId)).status).toBe("sleeping");
    const session = await sql<{ status: string }[]>`SELECT status FROM sessions WHERE id=${sessionId}`;
    expect(session[0]!.status).toBe("running");
    expect(await lastWokeAt()).toBeNull();
  });

  it("refuses a start before the last recorded wake", async () => {
    const earlier = await wake({ at: hoursAgo(14), sleptAt: hoursAgo(22) });
    expect(earlier.wake?.outcome).toBe("logged_night");
    const { planId } = await runningSleep(hoursAgo(9));
    await expect(wake({ at: hoursAgo(1), sleptAt: hoursAgo(15) })).rejects.toThrow("before your last recorded wake");
    expect((await plan(planId)).status).toBe("sleeping");
  });

  it("is what finishing a sleep with a chosen end does too: the wake is that end, not the time it was entered", async () => {
    const { planId, sessionId } = await runningSleep(hoursAgo(9));
    const version = await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${sessionId}`;
    const woke = hoursAgo(1);
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: version[0]!.version,
      type: "finish_activity",
      sessionId,
      outcome: "completed",
      endedAt: iso(woke)
    });
    expect((await plan(planId)).actual_wake_at?.getTime()).toBe(woke.getTime());
    expect((await lastWokeAt())?.getTime()).toBe(woke.getTime());
  });
});

describe("wake: last night was planned", () => {
  it("completes the planned sleep with the wake and the start it was told", async () => {
    const plannedStart = hoursAgo(9);
    const planId = await plannedSleep(plannedStart, hoursAgo(1));
    const woke = minutesAgo(30);
    const sleptAt = hoursAgo(8.5);
    const { wake: result, state } = await wake({ at: woke, sleptAt });

    expect(result).toEqual({
      outcome: "completed_plan",
      sleepPlanId: planId,
      sleptAt: iso(sleptAt),
      wokeAt: iso(woke),
      startAssumed: false
    });
    const row = await plan(planId);
    expect(row.status).toBe("completed");
    expect(row.actual_start_at?.getTime()).toBe(sleptAt.getTime());
    expect(row.actual_wake_at?.getTime()).toBe(woke.getTime());
    // What the engine scheduled stays as the evidence; only what happened moves.
    expect(row.planned_start_at.getTime()).toBe(plannedStart.getTime());
    expect(row.allowed_minutes).toBe(480);
    expect(row.sleep_deficit_minutes).toBe(0);
    expect(await plans()).toEqual([{ id: planId, status: "completed" }]);
    expect((await lastWokeAt())?.getTime()).toBe(woke.getTime());
    expect(new Date(state.settings.lastWokeAt!).getTime()).toBe(woke.getTime());
  });

  it("takes the planned start for the start when none is told, and says it was assumed", async () => {
    const plannedStart = hoursAgo(9);
    const planId = await plannedSleep(plannedStart, hoursAgo(1));
    const woke = minutesAgo(30);
    const { wake: result } = await wake({ at: woke });

    expect(result).toEqual({
      outcome: "completed_plan",
      sleepPlanId: planId,
      sleptAt: iso(plannedStart),
      wokeAt: iso(woke),
      startAssumed: true
    });
    const row = await plan(planId);
    expect(row.status).toBe("completed");
    expect(row.actual_start_at?.getTime()).toBe(plannedStart.getTime());
    expect(row.allowed_minutes).toBe(510);
    expect(row.sleep_deficit_minutes).toBe(0);
  });

  it("uses the latest plan that began before the wake, not tonight's", async () => {
    const lastNight = await plannedSleep(hoursAgo(9), hoursAgo(1));
    const tonight = await plannedSleep(minutesAgo(-12 * 60), minutesAgo(-20 * 60));
    const { wake: result } = await wake({ at: minutesAgo(30) });
    expect(nightOf(result).sleepPlanId).toBe(lastNight);
    expect((await plan(tonight)).status).toBe("planned");
  });

  it("does not take a plan the engine re-drew from a missed start as last night's: its start is the replan", async () => {
    const replanned = await plannedSleep(hoursAgo(2), hoursAgo(-4), { replannedFromMissedStart: true });
    // With no start told either, only the wake is recorded.
    expect((await wake({ at: minutesAgo(30) })).wake?.outcome).toBe("recorded_wake");
    expect((await plan(replanned)).status).toBe("planned");
    // With a start told, the night is logged on its own and the re-drawn plan is left for the planner to sweep.
    const { wake: result } = await wake({ at: minutesAgo(30), sleptAt: hoursAgo(8) });
    expect(result?.outcome).toBe("logged_night");
    expect((await plan(replanned)).status).toBe("planned");
  });

  it("does not take a plan that ends before the night the person says they slept", async () => {
    const early = await plannedSleep(hoursAgo(20), hoursAgo(14));
    const { wake: result } = await wake({ at: minutesAgo(30), sleptAt: hoursAgo(8) });
    expect(result?.outcome).toBe("logged_night");
    expect((await plan(early)).status).toBe("planned");
  });

  it("refuses a night that overlaps one already logged", async () => {
    await wake({ at: hoursAgo(10), sleptAt: hoursAgo(18) });
    const planId = await plannedSleep(hoursAgo(12), hoursAgo(4));
    await expect(wake({ at: hoursAgo(5) })).rejects.toThrow("overlaps one already logged");
    expect((await plan(planId)).status).toBe("planned");
  });
});

describe("wake: nothing is running or planned", () => {
  it("logs the night as the sleep log does, and reads back as the last wake", async () => {
    const sleptAt = hoursAgo(8);
    const woke = minutesAgo(30);
    const commandId = crypto.randomUUID();
    const { wake: result, state } = await wake({ at: woke, sleptAt, commandId });

    expect(result).toEqual({
      outcome: "logged_night",
      sleepPlanId: commandId,
      sleptAt: iso(sleptAt),
      wokeAt: iso(woke),
      startAssumed: false
    });
    const row = await plan(commandId);
    expect(row).toMatchObject({ status: "completed", input_version: "manual", allowed_minutes: 450 });
    expect(row.actual_start_at?.getTime()).toBe(sleptAt.getTime());
    expect(row.actual_wake_at?.getTime()).toBe(woke.getTime());
    expect(row.sleep_deficit_minutes).toBe(30);
    expect((await lastWokeAt())?.getTime()).toBe(woke.getTime());
    expect(new Date(state.settings.lastWokeAt!).getTime()).toBe(woke.getTime());
    expect(state.sleepPlans.find((item) => item.id === commandId)).toMatchObject({ status: "completed" });
  });

  it("defaults the wake to now", async () => {
    const before = Date.now();
    const { wake: result } = await wake({ sleptAt: hoursAgo(8) });
    expect(result?.outcome).toBe("logged_night");
    const wokeAt = Date.parse(result!.wokeAt);
    expect(wokeAt).toBeGreaterThanOrEqual(before - 1000);
    expect(wokeAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("records the wake alone when there is no start to take, and logs no night", async () => {
    const woke = minutesAgo(30);
    const { wake: result, state } = await wake({ at: woke });
    expect(result).toEqual({ outcome: "recorded_wake", wokeAt: iso(woke) });
    expect(await plans()).toEqual([]);
    expect((await lastWokeAt())?.getTime()).toBe(woke.getTime());
    expect(new Date(state.settings.lastWokeAt!).getTime()).toBe(woke.getTime());
  });

  it("never moves the last wake back when recording it alone", async () => {
    const newer = minutesAgo(10);
    await sql`UPDATE user_preferences SET last_woke_at=${newer} WHERE user_id=${userId}`;
    await expect(wake({ at: minutesAgo(60) })).rejects.toThrow("is later than this one");
    expect((await lastWokeAt())?.getTime()).toBe(newer.getTime());
  });

  // A stale-wake need answers with `rhen wake --at <time>` alone. After a break there is no running sleep and
  // last night's plan is missing or re-drawn from a missed start, so the answer it advertises must still settle it.
  it("settles a stale-wake need after a break with the need's own answer", async () => {
    await sql`UPDATE user_preferences SET last_woke_at=${hoursAgo(24 * 3)} WHERE user_id=${userId}`;
    const replanned = await plannedSleep(hoursAgo(2), hoursAgo(-4), { replannedFromMissedStart: true });
    const needsNow = async () =>
      buildNeeds({ state: (await readPortalState(sql))!, currentDirective: null, now: new Date() }, new Map());
    const need = (await needsNow()).find((item) => item.fact === "wake");
    expect(need?.answer).toMatchObject({ tool: "rhen_wake", fields: ["at"] });

    const woke = minutesAgo(45);
    const answer = Object.fromEntries(need!.answer.fields.map((field) => [field, woke]));
    expect((await wake(answer)).wake?.outcome).toBe("recorded_wake");
    expect((await needsNow()).map((item) => item.fact)).not.toContain("wake");
    expect((await plan(replanned)).status).toBe("planned");
    expect(await plans()).toHaveLength(1);
  });

  it("refuses a second night for hours already recorded, and the wake alone logs none", async () => {
    const woke = hoursAgo(1);
    const first = await wake({ at: woke, sleptAt: hoursAgo(9) });
    expect(first.wake?.outcome).toBe("logged_night");

    // The same night again, told differently: the overlap guard refuses it rather than counting the sleep twice.
    await expect(wake({ at: minutesAgo(50), sleptAt: hoursAgo(8) })).rejects.toThrow("overlaps one already logged");
    // The wake alone, repeated: it is recorded again, and no second night is logged.
    expect((await wake({ at: woke })).wake?.outcome).toBe("recorded_wake");
    expect(await plans()).toEqual([{ id: nightOf(first.wake).sleepPlanId, status: "completed" }]);
    expect((await lastWokeAt())?.getTime()).toBe(Date.parse(first.wake!.wokeAt));
  });

  it("refuses a night that overlaps the one a running sleep just became", async () => {
    await runningSleep(hoursAgo(3));
    // The running sleep would be finished first, so the overlap guard is for the night logged around it.
    const { wake: result } = await wake({ at: hoursAgo(1) });
    expect(result?.outcome).toBe("finished_session");
    await expect(wake({ at: minutesAgo(30), sleptAt: hoursAgo(2) })).rejects.toThrow("overlaps one already logged");
  });
});

describe("wake: the time and the record", () => {
  it("answers a repeat of the same command id with the state alone, and writes nothing twice", async () => {
    const commandId = crypto.randomUUID();
    // The same times both sends: a repeat is the same write, and a different time under one id is refused.
    const [at, sleptAt] = [minutesAgo(30), hoursAgo(8)];
    const first = await wake({ at, sleptAt, commandId });
    const again = await wake({ at, sleptAt, commandId });
    expect(first.wake?.outcome).toBe("logged_night");
    expect(again.wake).toBeNull();
    // The person's own time, changed under the same id, is a different write.
    await expect(wake({ at, sleptAt: hoursAgo(9), commandId })).rejects.toThrow("already used for a different write");
    expect(again.state.settings.lastWokeAt).toBe(first.state.settings.lastWokeAt);
    expect(await plans()).toHaveLength(1);
    expect(await sql`SELECT id FROM writes WHERE id=${commandId}`).toHaveLength(1);
    const changes = await sql<
      { entity_type: string; operation: string; evidence: Record<string, unknown> }[]
    >`SELECT entity_type,operation,evidence FROM write_rows WHERE write_id=${commandId}`;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      entity_type: "sleep_log_entry",
      operation: "wake",
      evidence: { outcome: "logged_night", startAssumed: false }
    });
  });

  it("refuses times outside the window, before it writes anything", async () => {
    await expect(wake({ at: minutesAgo(-10), sleptAt: hoursAgo(8) })).rejects.toThrow("in the future");
    await expect(wake({ at: hoursAgo(25), sleptAt: hoursAgo(30) })).rejects.toThrow("24 hours ago");
    await expect(wake({ at: minutesAgo(30), sleptAt: hoursAgo(25) })).rejects.toThrow("24 hours ago");
    await expect(wake({ at: hoursAgo(8), sleptAt: hoursAgo(8) })).rejects.toThrow("after the time slept");
    await expect(wake({ at: hoursAgo(9), sleptAt: hoursAgo(8) })).rejects.toThrow("after the time slept");
    expect(await plans()).toEqual([]);
    expect(await sql`SELECT id FROM writes`).toHaveLength(0);
  });

  it("takes a wake a few minutes ahead of the clock as now, as the sleep log does", async () => {
    const { wake: result } = await wake({ at: minutesAgo(-3), sleptAt: hoursAgo(8) });
    expect(Date.parse(result!.wokeAt)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("keeps a wake recorded directly that is newer than this one, as the sleep log does", async () => {
    const newer = minutesAgo(10);
    await sql`UPDATE user_preferences SET last_woke_at=${newer} WHERE user_id=${userId}`;
    await wake({ at: hoursAgo(2), sleptAt: hoursAgo(10) });
    expect((await lastWokeAt())?.getTime()).toBe(newer.getTime());
  });

  it("keeps a newer wake recorded directly when a back-dated wake finishes a running sleep", async () => {
    await runningSleep(hoursAgo(10));
    const newer = minutesAgo(10);
    await sql`UPDATE user_preferences SET last_woke_at=${newer} WHERE user_id=${userId}`;
    expect((await wake({ at: hoursAgo(2) })).wake?.outcome).toBe("finished_session");
    expect((await lastWokeAt())?.getTime()).toBe(newer.getTime());
  });

  it("replaces a stale wake recorded directly", async () => {
    await sql`UPDATE user_preferences SET last_woke_at=${hoursAgo(24 * 21)} WHERE user_id=${userId}`;
    const woke = minutesAgo(30);
    await wake({ at: woke, sleptAt: hoursAgo(8) });
    expect((await lastWokeAt())?.getTime()).toBe(woke.getTime());
  });

  it("re-asserts the place slept in as of the wake", async () => {
    const setAt = hoursAgo(12);
    await sql`UPDATE user_preferences SET current_situation=${sql.json({ locationId: "home", locationSetAt: iso(setAt) } as never)} WHERE user_id=${userId}`;
    const woke = minutesAgo(30);
    await wake({ at: woke, sleptAt: hoursAgo(8) });
    const state = await readPortalState(sql);
    expect(state!.currentSituation.locationSetAt).toBe(iso(woke));
  });
});

describe("wake: against a plan publish in flight", () => {
  /** Waits until another backend is blocked on a lock, so the worker side moves only once the wake is waiting. */
  async function untilABackendWaits(): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const waiting = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'`;
      if (waiting[0]!.count > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("The wake never waited on the publish in flight.");
  }

  // The worker's publish takes the publication lock, then the waiting jobs it supersedes, then deletes and upserts
  // the planned nights. A wake that locked last night's plan first would hold it while waiting for the job row its
  // own state change supersedes: a deadlock Postgres breaks by failing one side.
  it("waits for the publish instead of deadlocking with it", async () => {
    const id = await plannedSleep(hoursAgo(9), hoursAgo(1));
    const jobs = await sql<{ id: string }[]>`
      INSERT INTO jobs (type,payload,idempotency_key,status,available_at)
      VALUES ('plan_forecast.recalculate.v1',${sql.json({ userId, cause: "state_change" } as never)},${"plan_forecast.recalculate.v1:" + userId + ":waiting"},'pending',${new Date(0)})
      RETURNING id`;
    const order: string[] = [];
    let woke: Promise<unknown> = Promise.resolve();
    await sql.begin(async (worker) => {
      await lockPlanForecastPublication(worker as unknown as postgres.Sql, userId);
      await worker`SELECT id FROM jobs WHERE id=${jobs[0]!.id} FOR UPDATE`;
      woke = wake({ at: minutesAgo(30), sleptAt: hoursAgo(9) }).then(() => order.push("woke"));
      await untilABackendWaits();
      await worker`SELECT id FROM sleep_plans WHERE id=${id} FOR UPDATE`;
      order.push("published");
    });
    await woke;
    expect(order).toEqual(["published", "woke"]);
    expect((await plan(id)).status).toBe("completed");
  }, 20_000);
});

/**
 * An agent's wake is undoable like its other direct writes: the
 * portal keeps the rows the wake changed, and one revert puts all of them back, or takes the logged night away.
 */
describe("wake: undo", () => {
  const AGENT = "companion";
  const asAgent = <T>(fn: () => Promise<T>, agent: string | null = AGENT) => runWithActor(agent, fn);
  const revert = (target: string, direction: "undo" | "redo", agent: string | null = AGENT) =>
    asAgent(() => runRevertCommand(sql, { commandId: crypto.randomUUID(), target, direction }), agent);

  /** Everything a wake can touch, without the version and clock columns every save bumps. */
  async function world() {
    const clean = (rows: Record<string, unknown>[]) =>
      rows.map(({ version: _version, updated_at: _updatedAt, ...rest }) => rest);
    const [prefs] = await sql<
      { last_woke_at: Date | null; current_situation: unknown }[]
    >`SELECT last_woke_at,current_situation FROM user_preferences WHERE user_id=${userId}`;
    return {
      plans: clean(await sql<Record<string, unknown>[]>`SELECT * FROM sleep_plans ORDER BY id`),
      sessions: clean(await sql<Record<string, unknown>[]>`SELECT * FROM sessions ORDER BY id`),
      segments: clean(await sql<Record<string, unknown>[]>`SELECT * FROM session_segments ORDER BY id`),
      lastWokeAt: prefs!.last_woke_at,
      currentSituation: prefs!.current_situation
    };
  }

  async function seedPlaceAndOldWake() {
    await sql`UPDATE user_preferences SET last_woke_at=${hoursAgo(30)},current_situation=${sql.json({ locationId: "home", locationSetAt: iso(hoursAgo(14)) } as never)} WHERE user_id=${userId}`;
  }

  it("keeps the sleep plan, the session and its segment, and the last wake and place, under the wake's own id", async () => {
    await seedPlaceAndOldWake();
    await runningSleep(hoursAgo(9));
    const commandId = crypto.randomUUID();
    await asAgent(() => wake({ commandId, at: hoursAgo(1) }));
    const [header] = await sql<
      { kind: string; state: string; actor: string; images: { table: string; before: Record<string, unknown> }[] }[]
    >`SELECT kind,state,actor,images FROM writes WHERE id=${commandId}`;
    expect(header).toMatchObject({ kind: "wake", state: "applied", actor: AGENT });
    expect(header!.images.map((image) => image.table).sort()).toEqual([
      "session_segments",
      "sessions",
      "sleep_plans",
      "user_preferences"
    ]);
    // The settings row is imaged by the two columns a wake changes, not the whole row of preferences.
    const prefs = header!.images.find((image) => image.table === "user_preferences")!;
    expect(Object.keys(prefs.before).sort()).toEqual([
      "current_situation",
      "last_woke_at",
      "updated_at",
      "user_id",
      "version"
    ]);
  });

  it("puts a finished sleep back as it was, session and last wake included, and redo finishes it again", async () => {
    await seedPlaceAndOldWake();
    const { planId, sessionId } = await runningSleep(hoursAgo(9));
    const before = await world();
    const commandId = crypto.randomUUID();
    await asAgent(() => wake({ commandId, at: hoursAgo(1), sleptAt: hoursAgo(8.5) }));
    const after = await world();
    expect(after).not.toEqual(before);
    expect((await plan(planId)).status).toBe("completed");

    await revert(commandId, "undo");
    expect(await world()).toEqual(before);
    expect((await plan(planId)).status).toBe("sleeping");
    const [session] = await sql<
      { status: string; ended_at: Date | null }[]
    >`SELECT status,ended_at FROM sessions WHERE id=${sessionId}`;
    expect(session).toMatchObject({ status: "running", ended_at: null });

    await revert(commandId, "redo");
    expect(await world()).toEqual(after);
    await revert(commandId, "undo");
    expect(await world()).toEqual(before);
  });

  it("puts a completed plan back to planned with its own times, and the last wake to what it was", async () => {
    await seedPlaceAndOldWake();
    const planId = await plannedSleep(hoursAgo(10), hoursAgo(2));
    const before = await world();
    const commandId = crypto.randomUUID();
    await asAgent(() => wake({ commandId, at: hoursAgo(1) }));
    expect((await plan(planId)).status).toBe("completed");
    expect((await lastWokeAt())?.getTime()).not.toBe(before.lastWokeAt?.getTime());

    await revert(commandId, "undo");
    expect(await world()).toEqual(before);
    expect((await plan(planId)).status).toBe("planned");
    expect((await lastWokeAt())?.getTime()).toBe(before.lastWokeAt?.getTime());
  });

  // Undo puts last night back to planned, and a planned night is the planner's: the next publish deletes and redraws
  // it. Redo then finds the row gone and refuses; running the wake again settles the night.
  it("refuses a redo once a publish has redrawn the night it put back, and a fresh wake settles it", async () => {
    await seedPlaceAndOldWake();
    const planId = await plannedSleep(hoursAgo(10), hoursAgo(2));
    const commandId = crypto.randomUUID();
    await asAgent(() => wake({ commandId, at: hoursAgo(1) }));
    await revert(commandId, "undo");
    expect((await plan(planId)).status).toBe("planned");

    // The publish's own sweep of planned nights (plan-forecast-runtime.ts), with nothing redrawn for a past night.
    await sql`DELETE FROM sleep_plans WHERE user_id=${userId} AND status='planned'`;
    await expect(revert(commandId, "redo")).rejects.toBeInstanceOf(CommandConflictError);
    expect(await plans()).toEqual([]);

    const again = await asAgent(() => wake({ at: hoursAgo(1), sleptAt: hoursAgo(9) }));
    expect(again.wake?.outcome).toBe("logged_night");
  });

  it("takes a logged night away again, and brings it back on redo", async () => {
    await seedPlaceAndOldWake();
    const before = await world();
    const commandId = crypto.randomUUID();
    await asAgent(() => wake({ commandId, at: hoursAgo(1), sleptAt: hoursAgo(9) }));
    const after = await world();
    expect(after.plans).toHaveLength(1);

    await revert(commandId, "undo");
    expect(await world()).toEqual(before);
    expect(await plans()).toEqual([]);

    await revert(commandId, "redo");
    expect(await world()).toEqual(after);
    expect((await plans())[0]).toMatchObject({ id: commandId, status: "completed" });
  });

  // A night logged since the undo owns those hours now; redo must not bring a second night back over them. The newer
  // wake recorded directly keeps the settings row as the undo left it, so only the overlap stands in the way, and
  // forcing (which is for edits to the write's own rows) does not get past it either.
  it("refuses a redo that would bring back a night overlapping one logged since, changing nothing", async () => {
    await sql`UPDATE user_preferences SET last_woke_at=${minutesAgo(10)} WHERE user_id=${userId}`;
    const commandId = crypto.randomUUID();
    await asAgent(() => wake({ commandId, at: hoursAgo(1), sleptAt: hoursAgo(9) }));
    await revert(commandId, "undo");
    const replacement = await wake({ at: hoursAgo(2), sleptAt: hoursAgo(8) });
    const replacementId = nightOf(replacement.wake).sleepPlanId;
    const after = await world();

    const overlap = `This wake cannot be redone: a night logged since`;
    await expect(revert(commandId, "redo")).rejects.toThrow(overlap);
    await expect(
      asAgent(
        () =>
          runRevertCommand(sql, { commandId: crypto.randomUUID(), target: commandId, direction: "redo", force: true }),
        null
      )
    ).rejects.toThrow(`(id ${replacementId})`);
    expect(await world()).toEqual(after);
    expect(await plans()).toEqual([{ id: replacementId, status: "completed" }]);
  });

  it("is not blocked by an unrelated settings edit made since, and leaves that edit alone", async () => {
    await seedPlaceAndOldWake();
    const planId = await plannedSleep(hoursAgo(10), hoursAgo(2));
    const before = await world();
    const commandId = crypto.randomUUID();
    await asAgent(() => wake({ commandId, at: hoursAgo(1) }));
    await sql`UPDATE user_preferences SET default_setup_buffer_minutes=17,version=version+1 WHERE user_id=${userId}`;

    await revert(commandId, "undo");
    expect(await world()).toEqual(before);
    expect((await plan(planId)).status).toBe("planned");
    const [prefs] = await sql<
      { default_setup_buffer_minutes: number }[]
    >`SELECT default_setup_buffer_minutes FROM user_preferences WHERE user_id=${userId}`;
    expect(prefs!.default_setup_buffer_minutes).toBe(17);
    await sql`UPDATE user_preferences SET default_setup_buffer_minutes=10 WHERE user_id=${userId}`;
  });

  it("refuses when a later wake was recorded since, changing nothing", async () => {
    const planId = await plannedSleep(hoursAgo(10), hoursAgo(2));
    const commandId = crypto.randomUUID();
    await asAgent(() => wake({ commandId, at: hoursAgo(1) }));
    await sql`UPDATE user_preferences SET last_woke_at=${minutesAgo(5)} WHERE user_id=${userId}`;
    const after = await world();

    await expect(revert(commandId, "undo")).rejects.toBeInstanceOf(CommandConflictError);
    expect(await world()).toEqual(after);
    expect((await plan(planId)).status).toBe("completed");
  });

  it("refuses when the night was corrected since, changing nothing", async () => {
    const planId = await plannedSleep(hoursAgo(10), hoursAgo(2));
    const commandId = crypto.randomUUID();
    await asAgent(() => wake({ commandId, at: hoursAgo(1) }));
    await sql`UPDATE sleep_plans SET actual_wake_at=${minutesAgo(70)},version=version+1 WHERE id=${planId}`;
    const after = await world();

    await expect(revert(commandId, "undo")).rejects.toBeInstanceOf(CommandConflictError);
    expect(await world()).toEqual(after);
  });

  it("keeps nothing for the person's own wake, and lets only the same agent or the owner undo an agent's", async () => {
    await plannedSleep(hoursAgo(10), hoursAgo(2));
    const own = crypto.randomUUID();
    await wake({ commandId: own, at: hoursAgo(1) });
    const [kept] = await sql<{ images: unknown }[]>`SELECT images FROM writes WHERE id=${own}`;
    expect(kept!.images).toBeNull();
    await expect(revert(own, "undo", null)).rejects.toBeInstanceOf(NotFoundCommandError);

    await sql.unsafe("TRUNCATE TABLE writes, write_rows, sleep_plans CASCADE");
    await plannedSleep(hoursAgo(10), hoursAgo(2));
    const theirs = crypto.randomUUID();
    await asAgent(() => wake({ commandId: theirs, at: hoursAgo(1) }));
    await expect(revert(theirs, "undo", "another-agent")).rejects.toBeInstanceOf(ForbiddenCommandError);
    await revert(theirs, "undo", null);
    expect((await plans())[0]!.status).toBe("planned");
  });
});
