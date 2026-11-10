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
import { runCheckInCommand } from "./check-in-commands";
import { InvalidCommandError } from "./command-errors";
import { runWithActor } from "@/server/agent-actor";
import { collectOccurredAtReport } from "@/server/occurred-at-report";

/**
 * `occurredAt` on the commands an owner's device queues while offline (`docs/design/real-times-for-owner-commands.md`):
 * accepted only from the owner, always recorded beside receipt time, applied only where it fits, and the reply says
 * in words when it was not. Self-contained `_test` database, the same pattern as `backfilled-start.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.OCCURRED_AT_TEST_DATABASE_NAME, "openrhen_occurred_at");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("OCCURRED_AT_TEST_DATABASE_NAME must be an identifier ending in _test");
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

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const iso = (date: Date) => date.toISOString();

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

async function createCommitmentSession(startedMinutesAgo: number): Promise<{ id: string; version: number }> {
  const commitment = crypto.randomUUID();
  await sql`INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status) VALUES (${commitment},${userId},'Work',${minutesAgo(300)},${new Date(Date.now() + 3_600_000)},'confirmed')`;
  const id = crypto.randomUUID();
  const startedAt = minutesAgo(startedMinutesAgo);
  await sql`
    INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
    VALUES (${id},${userId},'fixed_commitment',${commitment},'Fixture','running',${startedAt},${new Date(Date.now() + 3_600_000)},${startedAt},300,0)
  `;
  await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${id},${startedAt})`;
  return { id, version: (await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${id}`)[0]!.version };
}

async function versionOf(id: string): Promise<number> {
  return (await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${id}`)[0]!.version;
}

async function segments(sessionId: string) {
  return sql<
    {
      started_at: Date;
      ended_at: Date | null;
      start_occurred_at: Date | null;
      start_occurred_note: string | null;
      end_occurred_at: Date | null;
      end_occurred_note: string | null;
    }[]
  >`SELECT started_at,ended_at,start_occurred_at,start_occurred_note,end_occurred_at,end_occurred_note FROM session_segments WHERE session_id=${sessionId} ORDER BY started_at`;
}

async function startStep(occurredAt: string | undefined, extra: Record<string, unknown> = {}) {
  const id = await createRoutineStep();
  await storePlanningRun(new Date(), { kind: "routine_step", targetId: id, title: "Prep", recommendedMinutes: 10 });
  const version = (await sql<{ version: number }[]>`SELECT version FROM routine_steps WHERE id=${id}`)[0]!.version;
  const commandId = crypto.randomUUID();
  const { value, report } = await collectOccurredAtReport(() =>
    runActivityCommand(sql, {
      commandId,
      expectedVersion: version,
      type: "start_activity",
      targetType: "routine_step",
      targetId: id,
      plannedMinutes: 10,
      ...(occurredAt ? { occurredAt } : {}),
      ...extra
    })
  );
  void value;
  return { commandId, report };
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
    "TRUNCATE TABLE writes, write_rows, session_segments, sessions, routine_steps, commitments, sleep_plans, planning_runs, check_in, captures, sources, actions, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
  await sql`UPDATE user_preferences SET last_woke_at=NULL WHERE user_id=${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

describe("occurredAt on a start", () => {
  it("starts at the claimed time, up to 7 days back, and keeps the claim beside it", async () => {
    const claimed = minutesAgo(3 * 24 * 60);
    const { commandId, report } = await startStep(iso(claimed));
    const session = (
      await sql<
        { started_at: Date; started_recorded_at: Date | null }[]
      >`SELECT started_at,started_recorded_at FROM sessions WHERE id=${commandId}`
    )[0]!;
    expect(session.started_at.getTime()).toBe(claimed.getTime());
    expect(session.started_recorded_at).not.toBeNull();
    const [segment] = await segments(commandId);
    expect(segment!.started_at.getTime()).toBe(claimed.getTime());
    expect(segment!.start_occurred_at!.getTime()).toBe(claimed.getTime());
    expect(segment!.start_occurred_note).toBeNull();
    expect(report).toMatchObject({ applied: true, claimedAt: iso(claimed) });
    expect(report!.message).toContain("the time you did it");
  });

  it("applies at receipt, keeping the claim and the reason, when it is more than 7 days old", async () => {
    const claimed = minutesAgo(8 * 24 * 60);
    const before = Date.now();
    const { commandId, report } = await startStep(iso(claimed));
    const [segment] = await segments(commandId);
    expect(segment!.started_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(segment!.start_occurred_at!.getTime()).toBe(claimed.getTime());
    expect(segment!.start_occurred_note).toContain("7 days");
    expect(report!.applied).toBe(false);
    expect(report!.message).toContain("when the server received it");
    expect(report!.message).toContain("kept on the record");
  });

  it("applies at receipt when the claim is more than 5 minutes ahead, and holds one inside the grace at receipt", async () => {
    const ahead = new Date(Date.now() + 10 * 60_000);
    const first = await startStep(iso(ahead));
    expect((await segments(first.commandId))[0]!.start_occurred_note).toContain("5 minutes ahead");
    await sql`DELETE FROM sessions`;
    await sql`DELETE FROM planning_runs`;
    const near = new Date(Date.now() + 3 * 60_000);
    const second = await startStep(iso(near));
    const [segment] = await segments(second.commandId);
    expect(segment!.start_occurred_note).toBeNull();
    expect(segment!.start_occurred_at!.getTime()).toBe(near.getTime());
    expect(segment!.started_at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("applies at receipt when the claim is before the last recorded wake", async () => {
    await sql`UPDATE user_preferences SET last_woke_at=${minutesAgo(60)} WHERE user_id=${userId}`;
    const { commandId, report } = await startStep(iso(minutesAgo(120)));
    expect((await segments(commandId))[0]!.start_occurred_note).toContain("last recorded wake");
    expect(report!.applied).toBe(false);
  });

  it("applies at receipt when the claim overlaps a finished session", async () => {
    await sql`INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,ended_at,planned_minutes,remaining_before_minutes) VALUES (${crypto.randomUUID()},${userId},'fixed_commitment',${crypto.randomUUID()},'Earlier','completed',${minutesAgo(90)},${minutesAgo(30)},${minutesAgo(90)},${minutesAgo(30)},60,0)`;
    const { commandId } = await startStep(iso(minutesAgo(60)));
    expect((await segments(commandId))[0]!.start_occurred_note).toContain("overlaps an earlier session");
  });

  it("keeps receipt time for a sleep start and records the claim", async () => {
    const plan = crypto.randomUUID();
    const now = new Date();
    await sql`INSERT INTO sleep_plans (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,explanation,status) VALUES (${plan},${userId},${now},${new Date(now.getTime() + 480 * 60_000)},480,480,'Fixture','planned')`;
    await storePlanningRun(now, { kind: "sleep", targetId: plan, title: "Sleep", recommendedMinutes: 480 }, {}, [
      {
        id: plan,
        plannedStartAt: now.toISOString(),
        plannedWakeAt: new Date(now.getTime() + 480 * 60_000).toISOString(),
        allowedMinutes: 480
      }
    ]);
    const commandId = crypto.randomUUID();
    const claimed = minutesAgo(60);
    const { report } = await collectOccurredAtReport(() =>
      runActivityCommand(sql, {
        commandId,
        expectedVersion: 1,
        type: "start_activity",
        targetType: "sleep",
        targetId: plan,
        plannedMinutes: 480,
        occurredAt: iso(claimed)
      })
    );
    const [segment] = await segments(commandId);
    expect(segment!.started_at.getTime()).toBeGreaterThan(claimed.getTime() + 30 * 60_000);
    expect(segment!.start_occurred_at!.getTime()).toBe(claimed.getTime());
    expect(report!.applied).toBe(false);
    expect(report!.message).toContain("sleep start");
  });

  it("starts an action session at the claimed time through the session commands", async () => {
    const actionId = await createAction();
    await storePlanningRun(new Date(), { kind: "action", targetId: actionId, title: "Draft", recommendedMinutes: 30 });
    const version = (await sql<{ version: number }[]>`SELECT version FROM actions WHERE id=${actionId}`)[0]!.version;
    const claimed = minutesAgo(5 * 60);
    const commandId = crypto.randomUUID();
    await runSessionCommand(sql, {
      commandId,
      expectedVersion: version,
      type: "start",
      actionId,
      plannedMinutes: 30,
      occurredAt: iso(claimed)
    });
    const session = (
      await sql<
        { started_at: Date; planned_end_at: Date }[]
      >`SELECT started_at,planned_end_at FROM sessions WHERE id=${commandId}`
    )[0]!;
    expect(session.started_at.getTime()).toBe(claimed.getTime());
    expect(session.planned_end_at.getTime()).toBe(claimed.getTime() + 30 * 60_000);
    expect((await segments(commandId))[0]!.start_occurred_at!.getTime()).toBe(claimed.getTime());
  });
});

describe("occurredAt from an agent", () => {
  it("is refused with the fix, and nothing is written", async () => {
    const id = await createRoutineStep();
    await storePlanningRun(new Date(), { kind: "routine_step", targetId: id, title: "Prep", recommendedMinutes: 10 });
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      type: "start_activity" as const,
      targetType: "routine_step" as const,
      targetId: id,
      plannedMinutes: 10,
      occurredAt: iso(minutesAgo(30))
    };
    await expect(runWithActor("mark", () => runActivityCommand(sql, command))).rejects.toThrow(InvalidCommandError);
    await expect(runWithActor("mark", () => runActivityCommand(sql, command))).rejects.toThrow(
      /only from the owner.*startedAt.*endedAt.*without occurredAt/s
    );
    expect(await sql`SELECT 1 FROM sessions WHERE id=${command.commandId}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM writes WHERE id=${command.commandId}`).toHaveLength(0);
  });

  it("is refused on a session command and a check-in answer too", async () => {
    await expect(
      runWithActor("mark", () =>
        runSessionCommand(sql, {
          commandId: crypto.randomUUID(),
          expectedVersion: 1,
          type: "pause",
          sessionId: crypto.randomUUID(),
          occurredAt: iso(minutesAgo(5))
        })
      )
    ).rejects.toThrow("only from the owner");
    await expect(
      runWithActor("mark", () =>
        runCheckInCommand(sql, {
          commandId: crypto.randomUUID(),
          expectedVersion: null,
          type: "answer_check_in",
          checkInId: crypto.randomUUID(),
          status: "on_track",
          answerSource: "app",
          occurredAt: iso(minutesAgo(5))
        })
      )
    ).rejects.toThrow("only from the owner");
  });
});

describe("ordered offline replay on one session", () => {
  it("pauses, resumes and finishes at the times they happened, with remaining time read from them", async () => {
    const session = await createCommitmentSession(100);
    const at = (m: number) => iso(minutesAgo(m));
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "pause_activity",
      sessionId: session.id,
      occurredAt: at(80)
    });
    const paused = (
      await sql<
        { paused_remaining_seconds: number; planned_end_at: Date }[]
      >`SELECT paused_remaining_seconds,planned_end_at FROM sessions WHERE id=${session.id}`
    )[0]!;
    // Planned end is one hour from receipt; paused 80 minutes ago, so the remainder is read from the pause time.
    expect(
      Math.abs(
        paused.paused_remaining_seconds - Math.ceil((paused.planned_end_at.getTime() - minutesAgo(80).getTime()) / 1000)
      )
    ).toBeLessThanOrEqual(2);
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: await versionOf(session.id),
      type: "resume_activity",
      sessionId: session.id,
      occurredAt: at(60)
    });
    const resumed = (
      await sql<{ planned_end_at: Date }[]>`SELECT planned_end_at FROM sessions WHERE id=${session.id}`
    )[0]!;
    expect(
      Math.abs(resumed.planned_end_at.getTime() - (minutesAgo(60).getTime() + paused.paused_remaining_seconds * 1000))
    ).toBeLessThanOrEqual(2000);
    const finishId = crypto.randomUUID();
    const finishAt = at(10);
    const { report } = await collectOccurredAtReport(async () =>
      runActivityCommand(sql, {
        commandId: finishId,
        expectedVersion: await versionOf(session.id),
        type: "finish_activity",
        sessionId: session.id,
        outcome: "completed",
        occurredAt: finishAt
      })
    );
    expect(report!.applied).toBe(true);
    const rows = await segments(session.id);
    expect(rows).toHaveLength(2);
    expect(Math.abs(rows[0]!.ended_at!.getTime() - minutesAgo(80).getTime())).toBeLessThanOrEqual(2000);
    expect(rows[1]!.started_at.getTime()).toBeGreaterThan(rows[0]!.ended_at!.getTime());
    expect(rows[1]!.end_occurred_at).not.toBeNull();
    const done = (
      await sql<
        { ended_at: Date; active_minutes: number; ended_recorded_at: Date | null }[]
      >`SELECT ended_at,active_minutes,ended_recorded_at FROM sessions WHERE id=${session.id}`
    )[0]!;
    // 20 minutes before the pause plus 50 minutes after the resume.
    expect(done.active_minutes).toBe(70);
    expect(Math.abs(done.ended_at.getTime() - minutesAgo(10).getTime())).toBeLessThanOrEqual(1000);
    expect(done.ended_recorded_at).not.toBeNull();
    // The claim rides in the change log, so a retry of the finish is answered with the same sentence.
    const replay = await collectOccurredAtReport(async () =>
      runActivityCommand(sql, {
        commandId: finishId,
        expectedVersion: await versionOf(session.id),
        type: "finish_activity",
        sessionId: session.id,
        outcome: "completed",
        occurredAt: finishAt
      })
    );
    expect(replay.report!.applied).toBe(true);
  });

  it("applies a claim that comes before the session's last change at receipt, with the reason", async () => {
    const session = await createCommitmentSession(100);
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "pause_activity",
      sessionId: session.id,
      occurredAt: iso(minutesAgo(50))
    });
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: await versionOf(session.id),
      type: "resume_activity",
      sessionId: session.id,
      occurredAt: iso(minutesAgo(70))
    });
    const rows = await segments(session.id);
    const last = rows.at(-1)!;
    expect(last.start_occurred_note).toContain("not after this session's last recorded change");
    expect(Math.abs(last.start_occurred_at!.getTime() - minutesAgo(70).getTime())).toBeLessThanOrEqual(2000);
    expect(Date.now() - last.started_at.getTime()).toBeLessThan(5_000);
  });

  it("finishes an action session at the claimed time and credits the action", async () => {
    const actionId = await createAction();
    const id = crypto.randomUUID();
    const startedAt = minutesAgo(120);
    await sql`INSERT INTO sessions (id,user_id,action_id,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes) VALUES (${id},${userId},${actionId},'running',${startedAt},${minutesAgo(-30)},${startedAt},150,60)`;
    await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${id},${startedAt})`;
    const claimed = minutesAgo(60);
    await runSessionCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: await versionOf(id),
      type: "finish",
      sessionId: id,
      outcome: "completed",
      occurredAt: iso(claimed)
    });
    const session = (
      await sql<
        { ended_at: Date; active_minutes: number }[]
      >`SELECT ended_at,active_minutes FROM sessions WHERE id=${id}`
    )[0]!;
    expect(session.ended_at.getTime()).toBe(claimed.getTime());
    expect(session.active_minutes).toBe(60);
    const action = (
      await sql<
        { last_worked_at: Date; completed_at: Date; status: string }[]
      >`SELECT last_worked_at,completed_at,status FROM actions WHERE id=${actionId}`
    )[0]!;
    expect(action.status).toBe("done");
    expect(action.last_worked_at.getTime()).toBe(claimed.getTime());
    expect(action.completed_at.getTime()).toBe(claimed.getTime());
  });

  it("keeps receipt time for the wake that ends a sleep session", async () => {
    const plan = crypto.randomUUID();
    const startedAt = minutesAgo(400);
    await sql`INSERT INTO sleep_plans (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,explanation,status,actual_start_at) VALUES (${plan},${userId},${startedAt},${minutesAgo(-80)},480,480,'Fixture','sleeping',${startedAt})`;
    const id = crypto.randomUUID();
    await sql`INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes) VALUES (${id},${userId},'sleep',${plan},'Sleep','running',${startedAt},${minutesAgo(-80)},${startedAt},480,0)`;
    await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${id},${startedAt})`;
    const { report } = await collectOccurredAtReport(() =>
      runActivityCommand(sql, {
        commandId: crypto.randomUUID(),
        expectedVersion: 1,
        type: "finish_activity",
        sessionId: id,
        outcome: "completed",
        occurredAt: iso(minutesAgo(30))
      })
    );
    expect(report!.applied).toBe(false);
    expect(report!.message).toContain("wake");
    const [segment] = await segments(id);
    expect(Date.now() - segment!.ended_at!.getTime()).toBeLessThan(5_000);
    expect(segment!.end_occurred_at!.getTime()).toBeLessThan(Date.now() - 25 * 60_000);
  });
});

describe("check-ins answered offline", () => {
  async function createCheckIn(status: "pending" | "unknown" | "on_track", slotMinutesAgo: number) {
    const id = crypto.randomUUID();
    await sql`INSERT INTO check_in (id,user_id,slot_at,directive_kind,directive_title,status,answered_at) VALUES (${id},${userId},${minutesAgo(slotMinutesAgo)},'action','Draft',${status},${status === "on_track" ? minutesAgo(slotMinutesAgo - 1) : null})`;
    return id;
  }
  const answer = (checkInId: string, extra: Record<string, unknown>) =>
    collectOccurredAtReport(() =>
      runCheckInCommand(sql, {
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "answer_check_in",
        checkInId,
        status: "on_track",
        answerSource: "app",
        ...extra
      } as never)
    );

  it("answers a pending row at the claimed time and keeps the claim", async () => {
    const id = await createCheckIn("pending", 120);
    const claimed = minutesAgo(90);
    const { report } = await answer(id, { occurredAt: iso(claimed), deviationNote: "Working on the draft" });
    const row = (
      await sql<
        { answered_at: Date; occurred_at: Date; occurred_note: string | null; status: string }[]
      >`SELECT answered_at,occurred_at,occurred_note,status FROM check_in WHERE id=${id}`
    )[0]!;
    expect(row.answered_at.getTime()).toBe(claimed.getTime());
    expect(row.occurred_at.getTime()).toBe(claimed.getTime());
    expect(row.occurred_note).toBeNull();
    expect(report!.applied).toBe(true);
  });

  it("answers an unanswered timed-out row, and applies at receipt a claim from before the check-in was asked", async () => {
    const id = await createCheckIn("unknown", 60);
    const { report } = await answer(id, { occurredAt: iso(minutesAgo(90)) });
    const row = (
      await sql<
        { answered_at: Date; occurred_at: Date; occurred_note: string }[]
      >`SELECT answered_at,occurred_at,occurred_note FROM check_in WHERE id=${id}`
    )[0]!;
    expect(row.occurred_note).toContain("before the check-in was asked");
    expect(Date.now() - row.answered_at.getTime()).toBeLessThan(5_000);
    expect(report!.applied).toBe(false);
  });

  it("keeps his words as a capture marked with the check-in's time when the row had closed, and touches nothing else", async () => {
    const id = await createCheckIn("on_track", 120);
    const before = (
      await sql<{ version: number; answered_at: Date }[]>`SELECT version,answered_at FROM check_in WHERE id=${id}`
    )[0]!;
    const commandId = crypto.randomUUID();
    const claimedAt = iso(minutesAgo(100));
    const send = () =>
      collectOccurredAtReport(() =>
        runCheckInCommand(sql, {
          commandId,
          expectedVersion: null,
          type: "answer_check_in",
          checkInId: id,
          status: "deviated",
          answerSource: "app",
          deviationNote: "Actually I was at the shop",
          occurredAt: claimedAt
        })
      );
    const { report } = await send();
    expect(report).toMatchObject({ delivered: false, applied: false });
    expect(report!.message).toContain("Not delivered: the check-in closed");
    const after = (
      await sql<
        { version: number; answered_at: Date; status: string }[]
      >`SELECT version,answered_at,status FROM check_in WHERE id=${id}`
    )[0]!;
    expect(after.version).toBe(before.version);
    expect(after.status).toBe("on_track");
    expect(await sql`SELECT 1 FROM check_in`).toHaveLength(1);
    const kept = await sql<
      { captured_text: string; occurred_at: Date; source_type: string }[]
    >`SELECT captured_text,occurred_at,source_type FROM sources`;
    expect(kept).toHaveLength(1);
    expect(kept[0]!.captured_text).toBe("Actually I was at the shop");
    expect(kept[0]!.source_type).toBe("manual_capture");
    const slot = (await sql<{ slot_at: Date }[]>`SELECT slot_at FROM check_in WHERE id=${id}`)[0]!.slot_at;
    expect(kept[0]!.occurred_at.getTime()).toBe(slot.getTime());
    const capture = (
      await sql<
        { status: string; proposed_fields: Record<string, unknown> }[]
      >`SELECT status,proposed_fields FROM captures`
    )[0]!;
    expect(capture.status).toBe("pending");
    expect(capture.proposed_fields).toMatchObject({ text: "Actually I was at the shop", checkInId: id });
    // A retry is answered the same way and saves the words once.
    const retry = await send();
    expect(retry.report!.delivered).toBe(false);
    expect(await sql`SELECT 1 FROM captures`).toHaveLength(1);
  });

  it("saves nothing when a closed row's answer had no words, and says so", async () => {
    const id = await createCheckIn("on_track", 120);
    const { report } = await answer(id, { occurredAt: iso(minutesAgo(100)) });
    expect(report!.delivered).toBe(false);
    expect(report!.message).toContain("no words to keep");
    expect(await sql`SELECT 1 FROM sources`).toHaveLength(0);
  });

  it("still refuses an answer to a closed row when it carries no occurredAt", async () => {
    const id = await createCheckIn("on_track", 120);
    await expect(answer(id, {})).rejects.toThrow();
  });
});
