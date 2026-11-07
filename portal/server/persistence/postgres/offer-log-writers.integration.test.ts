import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { runActivityCommand } from "./activity-commands";
import { runCheckInCommand } from "./check-in-commands";
import { ensureUser } from "./ensure-user";
import { runSessionCommand } from "./session-commands";

/**
 * The Now offer log's outcome writers: a session or activity command, a check-in answer and a snooze each append one
 * row in their own transaction, with the target's rank in the latest offered row, the request's actor, and one row per
 * (command, event, target). Self-contained `_test` database, the same pattern as `session-commands-snapshot.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.OFFER_LOG_WRITERS_TEST_DATABASE_NAME,
  "openrhen_offer_log_writers"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("OFFER_LOG_WRITERS_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const asAgent = <T>(run: () => Promise<T>) => runWithActor("claude", run);
/** A person in the portal: the request scope with no agent. Outside any scope the actor is `system`. */
const asPerson = <T>(run: () => Promise<T>) => runWithActor(null, run);
const personSession = (command: Parameters<typeof runSessionCommand>[1]) =>
  asPerson(() => runSessionCommand(sql, command));
const personActivity = (command: Parameters<typeof runActivityCommand>[1]) =>
  asPerson(() => runActivityCommand(sql, command));
const personCheckIn = (command: Parameters<typeof runCheckInCommand>[1]) =>
  asPerson(() => runCheckInCommand(sql, command));

interface LogRow {
  event: string;
  recommendation_id: string | null;
  resolution_kind: string | null;
  target_type: string | null;
  target_id: string | null;
  label: string | null;
  rank: number | null;
  rank_basis: string | null;
  actor: string | null;
  command_id: string | null;
  detail: Record<string, unknown>;
}

const logRows = (event?: string) =>
  event
    ? sql<LogRow[]>`SELECT * FROM offer_log WHERE user_id=${userId} AND event=${event} ORDER BY occurred_at, id`
    : sql<LogRow[]>`SELECT * FROM offer_log WHERE user_id=${userId} ORDER BY occurred_at, id`;

async function createAction(title = "Draft citations"): Promise<{ actionId: string; version: number }> {
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
    INSERT INTO actions (project_id,title,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${project[0]!.id},${title},'active',30,60,90,60,'medium',15,90) RETURNING id, version`;
  return { actionId: action[0]!.id, version: action[0]!.version };
}

async function storePlanningRun(
  directive: Record<string, unknown>,
  sleepPlans: Record<string, unknown>[] = []
): Promise<void> {
  const now = new Date();
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
        recommendation: {},
        currentDirective: directive,
        upcomingDirectives: [],
        continuation: null
      } as never)}
    )`;
}

/** An `offered` row as `persistPlanForecastResult` leaves it: the given actions are the top five, in order. */
async function seedOffered(actionIds: string[], recommendationId: string | null = null): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO offer_log (user_id, event, recommendation_id, target_type, target_id, candidates, actor, detail)
    VALUES (${userId}, 'offered', ${recommendationId}, 'action', ${actionIds[0] ?? null},
      ${sql.json(
        actionIds.map((targetId, index) => ({
          targetType: "action",
          targetId,
          executionOptionId: null,
          rank: index + 1,
          score: 10 - index,
          eligible: true,
          minutes: 30
        })) as never
      )}, 'system', ${sql.json({ hash: "seed" } as never)})
    RETURNING id`;
  return rows[0]!.id;
}

async function createRunningSession(actionId: string): Promise<{ id: string; version: number }> {
  const id = crypto.randomUUID();
  const startedAt = minutesAgo(30);
  await sql`
    INSERT INTO sessions (id,user_id,action_id,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes,started_by)
    VALUES (${id},${userId},${actionId},'running',${startedAt},${new Date(Date.now() + 30 * 60_000)},${startedAt},60,60,NULL)`;
  await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${id},${startedAt})`;
  const rows = await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${id}`;
  return { id, version: rows[0]!.version };
}

async function createRoutineStep(title = "Prep"): Promise<{ id: string; version: number }> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO routine_steps (id,user_id,anchor_type,anchor_id,purpose,title,duration_minutes,sequence,timing_rule,status)
    VALUES (${id},${userId},'sleep_plan',${crypto.randomUUID()},'wake',${title},10,0,'contiguous','pending')`;
  const rows = await sql<{ version: number }[]>`SELECT version FROM routine_steps WHERE id=${id}`;
  return { id, version: rows[0]!.version };
}

beforeAll(async () => {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
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
    "TRUNCATE TABLE offer_log, check_in, writes, write_rows, planning_runs, recommendation_candidates, recommendations, session_segments, sessions, routine_steps, actions, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
  await sql`UPDATE user_preferences SET last_woke_at=${minutesAgo(8 * 60)} WHERE user_id=${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

describe("session commands", () => {
  it("start appends one started row with the rank from the latest offered row, in the same transaction", async () => {
    const top = await createAction("Top");
    const chosen = await createAction("Chosen");
    await storePlanningRun({ kind: "action", targetId: chosen.actionId, title: "Chosen", recommendedMinutes: 30 });
    const offeredId = await seedOffered([top.actionId, chosen.actionId]);
    const commandId = crypto.randomUUID();
    await personSession({
      commandId,
      type: "start",
      actionId: chosen.actionId,
      expectedVersion: chosen.version,
      plannedMinutes: 30
    });
    const rows = await logRows("started");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_type: "action",
      target_id: chosen.actionId,
      label: "Chosen",
      rank: 2,
      rank_basis: "offered_row",
      actor: "person",
      command_id: commandId
    });
    expect(rows[0]!.detail).toMatchObject({ command: "start", plannedMinutes: 30, offered_row_id: offeredId });
    expect(rows[0]!.detail.off_plan).toBeUndefined();
  });

  it("records an agent's start under the agent and an off-plan target with a null rank", async () => {
    const top = await createAction("Top");
    const other = await createAction("Other");
    await storePlanningRun({ kind: "action", targetId: other.actionId, title: "Other", recommendedMinutes: 30 });
    await seedOffered([top.actionId]);
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId: crypto.randomUUID(),
        type: "start",
        actionId: other.actionId,
        expectedVersion: other.version,
        plannedMinutes: 30,
        startedAt: minutesAgo(10).toISOString()
      })
    );
    const row = (await logRows("started"))[0]!;
    expect(row).toMatchObject({ actor: "claude", rank: null, rank_basis: "offered_row" });
    expect(row.detail.off_plan).toBe(true);
    // A backfilled start keeps its real start time in detail; occurred_at is real now.
    expect(typeof row.detail.started_at).toBe("string");
  });

  it("select_alternative logs the chosen alternative with the reason", async () => {
    const top = await createAction("Top");
    const alt = await createAction("Alt");
    await storePlanningRun({ kind: "action", targetId: top.actionId, title: "Top", recommendedMinutes: 30 });
    const recommendation = await sql<{ id: string }[]>`
      INSERT INTO recommendations (user_id,input_version,kind,headline,explanation,primary_action_id)
      VALUES (${userId},'v1','action','Do it','Because',${top.actionId}) RETURNING id`;
    for (const [rank, id] of [top.actionId, alt.actionId].entries())
      await sql`INSERT INTO recommendation_candidates (recommendation_id,action_id,target_type,target_id,rank,total_score,score_components,eligible,exclusion_reasons,recommended_minutes)
        VALUES (${recommendation[0]!.id},${id},'action',${id},${rank + 1},1,'{}'::jsonb,true,'[]'::jsonb,30)`;
    await seedOffered([top.actionId, alt.actionId], recommendation[0]!.id);
    await personSession({
      commandId: crypto.randomUUID(),
      type: "select_alternative",
      actionId: alt.actionId,
      expectedVersion: alt.version,
      plannedMinutes: 30,
      recommendationId: recommendation[0]!.id,
      reason: "better_fit"
    });
    const row = (await logRows("started"))[0]!;
    expect(row).toMatchObject({
      target_id: alt.actionId,
      rank: 2,
      recommendation_id: recommendation[0]!.id,
      resolution_kind: "recommended"
    });
    expect(row.detail).toMatchObject({ command: "select_alternative", overrideReason: "better_fit" });
  });

  it("did_not_start and block append their own outcome rows; finishing appends none", async () => {
    const one = await createAction("One");
    const two = await createAction("Two");
    const three = await createAction("Three");
    const a = await createRunningSession(one.actionId);
    await personSession({
      commandId: crypto.randomUUID(),
      type: "did_not_start",
      sessionId: a.id,
      expectedVersion: a.version
    });
    const b = await createRunningSession(two.actionId);
    await personSession({
      commandId: crypto.randomUUID(),
      type: "block",
      sessionId: b.id,
      expectedVersion: b.version,
      reason: "waiting_on_someone",
      actionStatus: "waiting"
    });
    const c = await createRunningSession(three.actionId);
    await personSession({
      commandId: crypto.randomUUID(),
      type: "finish",
      sessionId: c.id,
      expectedVersion: c.version,
      outcome: "completed"
    });
    expect((await logRows("did_not_start")).map((row) => [row.target_id, row.label])).toEqual([[one.actionId, "One"]]);
    const blocked = (await logRows("blocked"))[0]!;
    expect(blocked).toMatchObject({ target_id: two.actionId, label: "Two" });
    expect(blocked.detail).toMatchObject({ reason: "waiting_on_someone", actionStatus: "waiting" });
    expect(await logRows()).toHaveLength(2);
  });

  it("leaves no row when the command fails after the log insert, and none for a replayed command id", async () => {
    const a = await createAction("A");
    await storePlanningRun({ kind: "action", targetId: a.actionId, title: "A", recommendedMinutes: 30 });
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION offer_log_test_refuse() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'segment refused'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER offer_log_test_refuse BEFORE INSERT ON session_segments FOR EACH ROW EXECUTE FUNCTION offer_log_test_refuse();`);
    const commandId = crypto.randomUUID();
    const command = {
      commandId,
      type: "start" as const,
      actionId: a.actionId,
      expectedVersion: a.version,
      plannedMinutes: 30
    };
    try {
      await expect(runSessionCommand(sql, command)).rejects.toThrow("segment refused");
    } finally {
      await sql.unsafe("DROP TRIGGER offer_log_test_refuse ON session_segments; DROP FUNCTION offer_log_test_refuse()");
    }
    expect(await logRows()).toHaveLength(0);
    expect(await sql`SELECT 1 FROM sessions WHERE id=${commandId}`).toHaveLength(0);

    await personSession(command);
    await personSession(command);
    expect(await logRows("started")).toHaveLength(1);
  });
});

describe("activity commands", () => {
  it("start_activity on a routine step logs started with its kind and an off-plan rank", async () => {
    const step = await createRoutineStep("Pack bag");
    const top = await createAction("Top");
    await seedOffered([top.actionId]);
    await storePlanningRun({ kind: "routine_step", targetId: step.id, title: "Pack bag", recommendedMinutes: 10 });
    await personActivity({
      commandId: crypto.randomUUID(),
      type: "start_activity",
      targetType: "routine_step",
      targetId: step.id,
      expectedVersion: step.version,
      plannedMinutes: 10
    });
    const row = (await logRows("started"))[0]!;
    expect(row).toMatchObject({
      target_type: "routine_step",
      target_id: step.id,
      resolution_kind: "routine_step",
      label: "Pack bag",
      rank: null,
      rank_basis: "offered_row",
      actor: "person"
    });
    expect(row.detail.off_plan).toBe(true);
  });

  it("skip_routine_step logs skipped; reopen logs nothing", async () => {
    const step = await createRoutineStep("Water plants");
    await personActivity({
      commandId: crypto.randomUUID(),
      type: "skip_routine_step",
      stepId: step.id,
      expectedVersion: step.version
    });
    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "skipped",
      target_type: "routine_step",
      target_id: step.id,
      label: "Water plants",
      rank_basis: "none"
    });
    const reopened = await sql<{ version: number }[]>`SELECT version FROM routine_steps WHERE id=${step.id}`;
    await personActivity({
      commandId: crypto.randomUUID(),
      type: "reopen_routine_step",
      stepId: step.id,
      expectedVersion: reopened[0]!.version
    });
    expect(await logRows()).toHaveLength(1);
  });

  it("finish_activity with a did-not-go-ahead outcome logs it; a completed finish logs nothing", async () => {
    const step = await createRoutineStep("Stretch");
    await storePlanningRun({ kind: "routine_step", targetId: step.id, title: "Stretch", recommendedMinutes: 10 });
    const startId = crypto.randomUUID();
    await personActivity({
      commandId: startId,
      type: "start_activity",
      targetType: "routine_step",
      targetId: step.id,
      expectedVersion: step.version,
      plannedMinutes: 10
    });
    const session = await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${startId}`;
    await personActivity({
      commandId: crypto.randomUUID(),
      type: "finish_activity",
      sessionId: startId,
      expectedVersion: session[0]!.version,
      outcome: "did_not_start"
    });
    expect((await logRows()).map((row) => row.event)).toEqual(["started", "did_not_start"]);
    expect((await logRows("did_not_start"))[0]).toMatchObject({
      target_type: "routine_step",
      target_id: step.id,
      label: "Stretch",
      resolution_kind: "routine_step"
    });
  });
});

describe("check-in answers", () => {
  it("logs checked_in for a single answer and for each slot of a batch", async () => {
    const first = await sql<{ id: string }[]>`
      INSERT INTO check_in (user_id, slot_at, directive_kind, directive_title, status)
      VALUES (${userId}, ${minutesAgo(5)}, 'action', 'Write the report', 'pending') RETURNING id`;
    await personCheckIn({
      commandId: crypto.randomUUID(),
      type: "answer_check_in",
      checkInId: first[0]!.id,
      expectedVersion: 1,
      status: "deviated",
      deviationCategory: "family",
      answerSource: "in_app_banner"
    });
    const single = (await logRows("checked_in"))[0]!;
    expect(single).toMatchObject({
      target_type: "check_in",
      target_id: first[0]!.id,
      label: "Write the report",
      rank: null
    });
    expect(single.detail).toMatchObject({ status: "deviated", deviationCategory: "family" });

    const a = await sql<{ id: string }[]>`
      INSERT INTO check_in (user_id, slot_at, directive_kind, directive_title, status)
      VALUES (${userId}, ${minutesAgo(180)}, 'action', 'Slot A', 'unknown') RETURNING id`;
    const b = await sql<{ id: string }[]>`
      INSERT INTO check_in (user_id, slot_at, directive_kind, directive_title, status)
      VALUES (${userId}, ${minutesAgo(60)}, 'action', 'Slot B', 'unknown') RETURNING id`;
    await personCheckIn({
      commandId: crypto.randomUUID(),
      type: "answer_check_ins",
      checkInIds: [a[0]!.id, b[0]!.id],
      upTo: minutesAgo(120).toISOString(),
      tail: { status: "unknown" }
    });
    const rows = await logRows("checked_in");
    expect(rows).toHaveLength(3);
    expect(rows.slice(1).map((row) => [row.label, row.detail.status])).toEqual([
      ["Slot A", "on_track"],
      ["Slot B", "unknown"]
    ]);
  });
});
