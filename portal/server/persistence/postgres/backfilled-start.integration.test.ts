import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { runActivityCommand } from "./activity-commands";
import { runSessionCommand } from "./session-commands";
import { InvalidCommandError } from "./command-errors";
import { formatZonedMoment } from "@/shared/date-format";

/**
 * `start_activity` and the action `start` with a past `startedAt`:
 * the `backfill` switch, each bound, the `started_recorded_at` stamp, and which columns follow `startedAt`.
 * Self-contained `_test` database, the same pattern as `activity-commands-ended-at.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.ACTIVITY_BACKFILL_TEST_DATABASE_NAME,
  "openrhen_activity_backfill"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ACTIVITY_BACKFILL_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

/** Minimal valid `planForecastResponseSchema` result, naming `directive` as the current directive and
    `recommendation` as given — enough for `requireCurrentPlanForecast`/`currentEngineResultIncludesActivity`
    to accept the activity being started, and for `deriveSessionSanction` to resolve deterministically. */
async function storePlanningRun(
  now: Date,
  directive: Record<string, unknown>,
  recommendation: Record<string, unknown> = {},
  sleepPlans: Record<string, unknown>[] = []
): Promise<void> {
  await sql`
    INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
    VALUES (
      ${userId},${crypto.randomUUID()},'v1','1','v1',${now},${new Date(now.getTime() + 3_600_000)},
      ${sql.json({
        contractVersion: "1",
        requestId: crypto.randomUUID(),
        inputVersion: "v1",
        engineVersion: "v1",
        calculatedAt: now.toISOString(),
        validUntil: new Date(now.getTime() + 3_600_000).toISOString(),
        derivedState: {
          sleepPlans,
          occurrences: [],
          routineSteps: [],
          commitmentRepeats: [],
          commitmentTimelines: [],
          stepPlacements: []
        },
        schedule: {},
        recommendation,
        currentDirective: directive,
        upcomingDirectives: [],
        continuation: null
      } as never)}
    )
  `;
}

async function createRoutineStep(): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO routine_steps
      (id,user_id,anchor_type,anchor_id,purpose,title,duration_minutes,sequence,timing_rule,status)
    VALUES (${id},${userId},'sleep_plan',${crypto.randomUUID()},'wake','Prep',10,0,'contiguous','pending')
  `;
  return id;
}

async function createSleepPlan(now: Date, plannedMinutes: number): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO sleep_plans
      (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,explanation,status)
    VALUES
      (${id},${userId},${now},${new Date(now.getTime() + plannedMinutes * 60_000)},${plannedMinutes},${plannedMinutes},'Fixture','planned')
  `;
  return id;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function startRequest(startedAt: Date | string | undefined, stepId?: string) {
  const id = stepId ?? (await createRoutineStep());
  await storePlanningRun(new Date(), { kind: "routine_step", targetId: id, title: "Prep", recommendedMinutes: 10 });
  const version = await sql<{ version: number }[]>`SELECT version FROM routine_steps WHERE id=${id}`;
  const commandId = crypto.randomUUID();
  return {
    stepId: id,
    commandId,
    command: {
      commandId,
      expectedVersion: version[0]!.version,
      type: "start_activity" as const,
      targetType: "routine_step" as const,
      targetId: id,
      plannedMinutes: 10,
      ...(startedAt ? { startedAt: startedAt instanceof Date ? startedAt.toISOString() : startedAt } : {})
    }
  };
}

async function row(id: string) {
  const rows = await sql<
    { started_at: Date; started_recorded_at: Date | null; planned_end_at: Date; updated_at: Date }[]
  >`SELECT started_at,started_recorded_at,planned_end_at,updated_at FROM sessions WHERE id=${id}`;
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
    "TRUNCATE TABLE writes, write_rows, session_segments, sessions, routine_steps, commitments, sleep_plans, planning_runs, plan_map_switches, plan_shadow_log, deliverables, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
  await sql`UPDATE user_preferences SET last_woke_at=NULL WHERE user_id=${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

describe("start_activity's startedAt", () => {
  it("starts at startedAt, stamping started_recorded_at at real now and moving planned times", async () => {
    const startedAt = minutesAgo(30);
    const { command, commandId } = await startRequest(startedAt);
    const before = Date.now();
    await runActivityCommand(sql, command);
    const session = await row(commandId);
    expect(session.started_at.getTime()).toBe(startedAt.getTime());
    expect(session.planned_end_at.getTime()).toBe(startedAt.getTime() + 10 * 60_000);
    expect(session.started_recorded_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(session.updated_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const segments = await sql<
      { started_at: Date }[]
    >`SELECT started_at FROM session_segments WHERE session_id=${commandId}`;
    expect(segments[0]!.started_at.getTime()).toBe(startedAt.getTime());
  });

  it("leaves started_recorded_at null when startedAt is omitted", async () => {
    const { command, commandId } = await startRequest(undefined);
    await runActivityCommand(sql, command);
    expect((await row(commandId)).started_recorded_at).toBeNull();
  });

  it("refuses a future start beyond the 5 minute grace", async () => {
    const { command } = await startRequest(new Date(Date.now() + 10 * 60_000));
    await expect(runActivityCommand(sql, command)).rejects.toThrow(InvalidCommandError);
  });

  it("refuses a start more than 24 hours back", async () => {
    const { command } = await startRequest(minutesAgo(25 * 60));
    await expect(runActivityCommand(sql, command)).rejects.toThrow("24 hours");
  });

  it("refuses a start before the last recorded wake", async () => {
    await sql`UPDATE user_preferences SET last_woke_at=${minutesAgo(20)} WHERE user_id=${userId}`;
    const { command } = await startRequest(minutesAgo(30));
    await expect(runActivityCommand(sql, command)).rejects.toThrow("last recorded wake");
  });

  it("names the last wake in the person's own timezone, not as UTC ISO text", async () => {
    await sql`UPDATE users SET timezone='Australia/Brisbane' WHERE id=${userId}`;
    const wake = minutesAgo(20);
    await sql`UPDATE user_preferences SET last_woke_at=${wake} WHERE user_id=${userId}`;
    const { command } = await startRequest(minutesAgo(30));
    const thrown = await runActivityCommand(sql, command).catch((error: Error) => error);
    expect((thrown as Error).message).toContain(
      `before your last recorded wake (${formatZonedMoment(wake, "Australia/Brisbane", new Date())})`
    );
    expect((thrown as Error).message).not.toMatch(/\d{4}-\d{2}-\d{2}T|Z\)/);
  });

  it("refuses a start that overlaps an earlier session", async () => {
    const earlier = crypto.randomUUID();
    await sql`
      INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,ended_at,planned_minutes,remaining_before_minutes)
      VALUES (${earlier},${userId},'routine_step',${crypto.randomUUID()},'Earlier','completed',${minutesAgo(60)},${minutesAgo(20)},${minutesAgo(60)},${minutesAgo(20)},40,0)
    `;
    const { command } = await startRequest(minutesAgo(30));
    // The error names the other session and the exact way out, so the caller does not guess.
    const refused = await runActivityCommand(sql, command).catch((error: Error) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain(`id ${earlier}`);
    expect((refused as Error).message).toContain("started-at later than");
    expect((refused as Error).message).toContain("rhen_undo");
  });

  it("refuses a sleep target, pointing at the sleep log", async () => {
    const planId = await createSleepPlan(new Date(), 480);
    await storePlanningRun(new Date(), { kind: "none", title: "Sleep", recommendedMinutes: 0 }, {}, [
      {
        id: planId,
        plannedStartAt: new Date().toISOString(),
        plannedWakeAt: new Date(Date.now() + 8 * 3_600_000).toISOString()
      }
    ]);
    await expect(
      runActivityCommand(sql, {
        commandId: crypto.randomUUID(),
        expectedVersion: 1,
        type: "start_activity",
        targetType: "sleep",
        targetId: planId,
        plannedMinutes: 480,
        startedAt: minutesAgo(30).toISOString()
      })
    ).rejects.toThrow('"entityType":"sleep_log_entry"');
  });
});

describe("correct_start on an open session", () => {
  async function openSession() {
    const { command, commandId } = await startRequest(undefined);
    await runActivityCommand(sql, command);
    const rows = await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${commandId}`;
    return { id: commandId, version: rows[0]!.version };
  }
  const correct = (id: string, version: number, startedAt: Date) =>
    runSessionCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: version,
      type: "correct_start",
      sessionId: id,
      startedAt: startedAt.toISOString()
    });

  it("moves the start, the first segment and the planned end, and stamps started_recorded_at", async () => {
    const session = await openSession();
    const before = await row(session.id);
    const target = minutesAgo(30);
    await correct(session.id, session.version, target);
    const after = await row(session.id);
    expect(after.started_at.getTime()).toBe(target.getTime());
    expect(after.started_recorded_at).not.toBeNull();
    expect(after.planned_end_at.getTime() - before.planned_end_at.getTime()).toBe(
      target.getTime() - before.started_at.getTime()
    );
    const segments = await sql<
      { started_at: Date }[]
    >`SELECT started_at FROM session_segments WHERE session_id=${session.id}`;
    expect(segments).toHaveLength(1);
    expect(segments[0]!.started_at.getTime()).toBe(target.getTime());
  });

  async function sanctionAfterCorrection(sanctionUntilEqualsEnd: boolean) {
    const session = await openSession();
    await sql`UPDATE sessions SET sanction_until=${sanctionUntilEqualsEnd ? sql`planned_end_at` : null} WHERE id=${session.id}`;
    await correct(session.id, session.version, minutesAgo(30));
    const rows = await sql<
      { sanction_until: Date | null; planned_end_at: Date }[]
    >`SELECT sanction_until, planned_end_at FROM sessions WHERE id=${session.id}`;
    return rows[0]!;
  }

  it("shifts sanction_until with the planned end", async () => {
    const after = await sanctionAfterCorrection(true);
    expect(after.sanction_until!.getTime()).toBe(after.planned_end_at.getTime());
  });

  it("leaves a null sanction_until null", async () => {
    expect((await sanctionAfterCorrection(false)).sanction_until).toBeNull();
  });

  it("refuses a start before the last wake, more than 24 hours back, or in the future", async () => {
    const session = await openSession();
    await expect(correct(session.id, session.version, minutesAgo(25 * 60))).rejects.toThrow("24 hours");
    await expect(correct(session.id, session.version, new Date(Date.now() + 30 * 60_000))).rejects.toThrow("future");
    await sql`UPDATE user_preferences SET last_woke_at=${minutesAgo(10)} WHERE user_id=${userId}`;
    await expect(correct(session.id, session.version, minutesAgo(20))).rejects.toThrow("last recorded wake");
  });

  it("refuses an overlap with an earlier session but not with itself", async () => {
    const session = await openSession();
    await sql`INSERT INTO sessions (id,user_id,status,planned_started_at,planned_end_at,started_at,ended_at,planned_minutes,remaining_before_minutes)
      VALUES (${crypto.randomUUID()},${userId},'completed',${minutesAgo(120)},${minutesAgo(40)},${minutesAgo(120)},${minutesAgo(40)},80,0)`;
    await expect(correct(session.id, session.version, minutesAgo(60))).rejects.toThrow("overlaps an earlier session");
    await correct(session.id, session.version, minutesAgo(30));
  });
});
