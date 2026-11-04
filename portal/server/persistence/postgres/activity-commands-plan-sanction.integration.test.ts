import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { judgePulse, type JudgePulseInput } from "@openrhen/contracts";
import { ensureUser } from "./ensure-user";
import { runActivityCommand } from "./activity-commands";

/**
 * The pulse criteria and publish design note (Decision Q2, "Self-started session"): `plan_sanction`
 * is decided once, at start, and frozen — mirrors `state-store-b.integration.test.ts`'s own
 * `plan_sanction`/`sanction_until` coverage of `session-commands.ts`, but for the four target types
 * `activity-commands.ts`'s own `start_activity` branch handles (step, commitment, sleep, deliverable).
 * Self-contained `_test` database, the same pattern as `activity-commands-ended-at.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.ACTIVITY_PLAN_SANCTION_TEST_DATABASE_NAME,
  "openrhen_activity_plan_sanction"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ACTIVITY_PLAN_SANCTION_TEST_DATABASE_NAME must be an identifier ending in _test");
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

async function createCommitment(): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status)
    VALUES (${id},${userId},'Work',${new Date(Date.now() - 3_600_000)},${new Date(Date.now() + 3_600_000)},'confirmed')
  `;
  return id;
}

async function createDeliverable(): Promise<string> {
  const area = await sql<{ id: string }[]>`
    INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id
  `;
  const outcome = await sql<{ id: string }[]>`
    INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id
  `;
  const project = await sql<{ id: string }[]>`
    INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Project','active') RETURNING id
  `;
  const deliverable = await sql<{ id: string }[]>`
    INSERT INTO deliverables (project_id,title) VALUES (${project[0]!.id},'Ship it') RETURNING id
  `;
  return deliverable[0]!.id;
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

async function sessionRow(id: string): Promise<{
  plan_sanction: string | null;
  sanction_until: Date | null;
  planned_end_at: Date;
  started_at: Date;
  target_type: string;
  target_id: string;
}> {
  const rows = await sql<
    {
      plan_sanction: string | null;
      sanction_until: Date | null;
      planned_end_at: Date;
      started_at: Date;
      target_type: string;
      target_id: string;
    }[]
  >`SELECT plan_sanction,sanction_until,planned_end_at,started_at,target_type,target_id FROM sessions WHERE id=${id}`;
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
    "TRUNCATE TABLE writes, write_rows, session_segments, sessions, routine_steps, commitments, sleep_plans, planning_runs, deliverables, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

describe("start_activity stores plan_sanction and sanction_until", () => {
  it("routine step: directive-sanctioned, sanction_until matches planned_end_at", async () => {
    const stepId = await createRoutineStep();
    const now = new Date();
    await storePlanningRun(now, { kind: "routine_step", targetId: stepId, title: "Prep", recommendedMinutes: 10 });
    const stepBefore = await sql<{ version: number }[]>`SELECT version FROM routine_steps WHERE id=${stepId}`;

    const commandId = crypto.randomUUID();
    await runActivityCommand(sql, {
      commandId,
      expectedVersion: stepBefore[0]!.version,
      type: "start_activity",
      targetType: "routine_step",
      targetId: stepId,
      plannedMinutes: 10
    });

    const row = await sessionRow(commandId);
    expect(row.plan_sanction).toBe("directive");
    expect(row.sanction_until?.getTime()).toBe(row.planned_end_at.getTime());
  });

  it("fixed commitment: day_plan_block-sanctioned (no `commitment` directive kind exists), sanction_until matches planned_end_at", async () => {
    const commitmentId = await createCommitment();
    const now = new Date();
    await storePlanningRun(
      now,
      { kind: "none", title: "Nothing directed", recommendedMinutes: 0 },
      { protectedCommitment: { id: commitmentId } }
    );
    const commitmentBefore = await sql<{ version: number }[]>`SELECT version FROM commitments WHERE id=${commitmentId}`;

    const commandId = crypto.randomUUID();
    await runActivityCommand(sql, {
      commandId,
      expectedVersion: commitmentBefore[0]!.version,
      type: "start_activity",
      targetType: "fixed_commitment",
      targetId: commitmentId,
      plannedMinutes: 30
    });

    const row = await sessionRow(commandId);
    expect(row.plan_sanction).toBe("day_plan_block");
    expect(row.sanction_until?.getTime()).toBe(row.planned_end_at.getTime());
  });

  it("deliverable: directive-sanctioned, sanction_until matches planned_end_at", async () => {
    const deliverableId = await createDeliverable();
    const now = new Date();
    await storePlanningRun(now, {
      kind: "deliverable",
      targetId: deliverableId,
      title: "Ship it",
      recommendedMinutes: 25
    });
    const deliverableBefore = await sql<
      { version: number }[]
    >`SELECT version FROM deliverables WHERE id=${deliverableId}`;

    const commandId = crypto.randomUUID();
    await runActivityCommand(sql, {
      commandId,
      expectedVersion: deliverableBefore[0]!.version,
      type: "start_activity",
      targetType: "deliverable",
      targetId: deliverableId,
      plannedMinutes: 25
    });

    const row = await sessionRow(commandId);
    expect(row.plan_sanction).toBe("directive");
    expect(row.sanction_until?.getTime()).toBe(row.planned_end_at.getTime());
  });

  it("sleep: directive-sanctioned at start — and, fed back through the judge, reads asleep all night, never on", async () => {
    const now = new Date();
    const plannedMinutes = 480;
    const sleepId = await createSleepPlan(now, plannedMinutes);
    await storePlanningRun(
      now,
      { kind: "sleep", targetId: sleepId, title: "Tonight", recommendedMinutes: plannedMinutes },
      {},
      [{ id: sleepId, allowedMinutes: plannedMinutes }]
    );
    const sleepBefore = await sql<{ version: number }[]>`SELECT version FROM sleep_plans WHERE id=${sleepId}`;

    const commandId = crypto.randomUUID();
    await runActivityCommand(sql, {
      commandId,
      expectedVersion: sleepBefore[0]!.version,
      type: "start_activity",
      targetType: "sleep",
      targetId: sleepId,
      plannedMinutes
    });

    const row = await sessionRow(commandId);
    // The fixed sanction: the recommended sleep night is the current directive, so it is sanctioned
    // as `directive`, held until the planned wake.
    expect(row.plan_sanction).toBe("directive");
    expect(row.sanction_until?.getTime()).toBe(row.planned_end_at.getTime());

    // Starting sleep also flips `sleep_plans.status` to `sleeping` (activity-commands.ts). Feeding
    // this exact stored session — target sleep, its own frozen sanction and sanction_until — into the
    // fixed judge, mid-night, must not read "on plan: sleep": the whole point of the fix is that a
    // tracked night reads asleep, not on, regardless of the session's own sanction.
    const midnight = new Date(row.started_at.getTime() + 4 * 60 * 60_000);
    const input: JudgePulseInput = {
      now: midnight,
      directive: null,
      dayPlanBlocks: [],
      protectedInForce: [{ kind: "sleep", id: sleepId, title: "Tonight" }],
      session: {
        target: { kind: "sleep", id: sleepId, title: "Tonight" },
        sanction: row.plan_sanction as "directive",
        sanctionedUntil: row.sanction_until,
        startedAt: row.started_at
      },
      checkIns: [],
      arrival: null,
      underway: null,
      sleep: { state: "sleeping" },
      privateTargets: new Set()
    };
    const judgement = judgePulse(input);
    expect(judgement.state).toBe("asleep");
    expect(judgement.state).not.toBe("on");
  });
});
