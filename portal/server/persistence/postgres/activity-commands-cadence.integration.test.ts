import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { runActivityCommand } from "./activity-commands";

/**
 * Feature B's completion hook: finishing a `routine_step` row that carries a `cadence_action_id` also
 * records that action's cadence completion, the same as running the action directly — see
 * `recordCadenceStepCompletion` in `activity-commands.ts` and the cadence target per period design note.
 * A commitment's own preparation step and a bedtime/wake step are the same row shape now (
 * The one routine storage design note), so both are proved through the identical mechanism below —
 * only the anchor columns differ.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.ACTIVITY_CADENCE_TEST_DATABASE_NAME,
  "openrhen_activity_cadence"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ACTIVITY_CADENCE_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const TIMEZONE = "America/Chicago";

/** Builds a full area/outcome/project chain and one cadence action with its recurrence rule. */
async function createCadenceAction(schedulingMode: "cadence" | "one_off" = "cadence"): Promise<{
  actionId: string;
  ruleId: string | null;
}> {
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
    VALUES (${project[0]!.id},'Practice piano',${schedulingMode},'active',10,20,30,5,'medium',10,30)
    RETURNING id
  `;
  if (schedulingMode !== "cadence") return { actionId: action[0]!.id, ruleId: null };
  const rule = await sql<{ id: string }[]>`
    INSERT INTO action_recurrence_rules (action_id,timezone,start_date,interval_days,completion_mode)
    VALUES (${action[0]!.id},${TIMEZONE},'2020-01-01',1,'manual')
    RETURNING id
  `;
  return { actionId: action[0]!.id, ruleId: rule[0]!.id };
}

async function createCommitment(): Promise<string> {
  const id = crypto.randomUUID();
  const startsAt = new Date(Date.now() + 3_600_000);
  const endsAt = new Date(Date.now() + 7_200_000);
  await sql`
    INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status)
    VALUES (${id},${userId},'Fixture commitment',${startsAt},${endsAt},'confirmed')
  `;
  return id;
}

async function createRoutineStep(commitmentId: string, cadenceActionId: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO routine_steps (id,user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,status,cadence_action_id)
    VALUES (${id},${userId},${commitmentId},'commitment',${commitmentId},'Practice step',10,0,'contiguous','doing',${cadenceActionId})
  `;
  return id;
}

/** A wake-anchored `routine_steps` row, mirroring what `deriveSleepRoutineSteps` produces. */
async function createSleepRoutineStep(cadenceActionId: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO routine_steps (id,user_id,anchor_type,anchor_id,purpose,title,duration_minutes,sequence,timing_rule,status,cadence_action_id)
    VALUES (${id},${userId},'sleep_plan',${crypto.randomUUID()},'wake','Practice step',10,0,'contiguous','doing',${cadenceActionId})
  `;
  return id;
}

async function createRunningSession(targetId: string): Promise<{ id: string; version: number }> {
  const id = crypto.randomUUID();
  const startedAt = new Date(Date.now() - 5 * 60_000);
  const plannedEnd = new Date(Date.now() + 60_000);
  await sql`
    INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
    VALUES (${id},${userId},'routine_step',${targetId},'Fixture session','running',${startedAt},${plannedEnd},${startedAt},5,0)
  `;
  await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${id},${startedAt})`;
  const rows = await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${id}`;
  return { id, version: rows[0]!.version };
}

async function completions(ruleId: string): Promise<{ minutes: number; source: string }[]> {
  return sql<
    { minutes: number; source: string }[]
  >`SELECT minutes,source FROM action_cadence_completions WHERE rule_id=${ruleId}`;
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
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "../platform/database/drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, session_segments, sessions, routine_steps, commitments, routine_preset_steps, routine_presets, action_cadence_completions, action_recurrence_rules, actions, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

describe("cadence-linked routine_step completion", () => {
  it("records a cadence completion when a cadence-linked step is finished as completed", async () => {
    const { actionId, ruleId } = await createCadenceAction();
    const commitmentId = await createCommitment();
    const stepId = await createRoutineStep(commitmentId, actionId);
    const session = await createRunningSession(stepId);
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    const rows = await completions(ruleId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("session");
    const step = await sql<{ status: string }[]>`SELECT status FROM routine_steps WHERE id=${stepId}`;
    expect(step[0]!.status).toBe("completed");
  });

  it("records nothing for a routine_step with no cadence link (regression guard against over-firing)", async () => {
    const commitmentId = await createCommitment();
    const stepId = await createRoutineStep(commitmentId, null);
    const session = await createRunningSession(stepId);
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    const rows = await sql<{ id: string }[]>`SELECT id FROM action_cadence_completions`;
    expect(rows).toHaveLength(0);
  });

  it("does not record a completion when the outcome is not 'completed'", async () => {
    const { ruleId } = await createCadenceAction();
    const { actionId: linkedActionId } = await createCadenceAction();
    const commitmentId = await createCommitment();
    const stepId = await createRoutineStep(commitmentId, linkedActionId);
    const session = await createRunningSession(stepId);
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "did_not_start"
    });
    const rows = await sql<{ id: string }[]>`SELECT id FROM action_cadence_completions`;
    expect(rows).toHaveLength(0);
    void ruleId;
  });

  it("does not throw when the linked action's recurrence rule no longer exists", async () => {
    const { actionId } = await createCadenceAction();
    await sql`DELETE FROM action_recurrence_rules WHERE action_id=${actionId}`;
    const commitmentId = await createCommitment();
    const stepId = await createRoutineStep(commitmentId, actionId);
    const session = await createRunningSession(stepId);
    await expect(
      runActivityCommand(sql, {
        commandId: crypto.randomUUID(),
        expectedVersion: session.version,
        type: "finish_activity",
        sessionId: session.id,
        outcome: "completed"
      })
    ).resolves.toBeDefined();
    const step = await sql<{ status: string }[]>`SELECT status FROM routine_steps WHERE id=${stepId}`;
    expect(step[0]!.status).toBe("completed");
  });

  it("does not throw and skips recording when the linked action is no longer scheduling_mode 'cadence'", async () => {
    const { actionId } = await createCadenceAction("one_off");
    const commitmentId = await createCommitment();
    const stepId = await createRoutineStep(commitmentId, actionId);
    const session = await createRunningSession(stepId);
    await expect(
      runActivityCommand(sql, {
        commandId: crypto.randomUUID(),
        expectedVersion: session.version,
        type: "finish_activity",
        sessionId: session.id,
        outcome: "completed"
      })
    ).resolves.toBeDefined();
    const rows = await sql<{ id: string }[]>`SELECT id FROM action_cadence_completions`;
    expect(rows).toHaveLength(0);
  });
});

describe("cadence-linked wake-routine step completion", () => {
  it("records a cadence completion when a cadence-linked wake-routine step is finished as completed", async () => {
    const { actionId, ruleId } = await createCadenceAction();
    const stepId = await createSleepRoutineStep(actionId);
    const session = await createRunningSession(stepId);
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    const rows = await completions(ruleId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("session");
  });

  it("records nothing for a wake-routine step with no cadence link (regression guard against over-firing)", async () => {
    const stepId = await createSleepRoutineStep(null);
    const session = await createRunningSession(stepId);
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    const rows = await sql<{ id: string }[]>`SELECT id FROM action_cadence_completions`;
    expect(rows).toHaveLength(0);
  });
});
