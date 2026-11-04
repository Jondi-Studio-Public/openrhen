import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { settleCatchUpCommandSchema, type SettleCatchUpCommand } from "@openrhen/contracts";
import { runWithActor } from "@/server/agent-actor";
import { ensureUser } from "./ensure-user";
import { readCatchUpLedger, settleCatchUp } from "./catch-up";
import { runRevertCommand } from "./write-revert";

/**
 * Catch-up's "right now" entries: an open session and a wake that
 * `resolveFreshness` calls stale, and the open check-in, each settled through the write that owns it; and
 * the whole-window `skip_older_than` bulk. Real time throughout: a session ends no later than the wall clock.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_catch_up_current");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const HOUR = 3_600_000;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR);

async function createAction(): Promise<{ projectId: string; actionId: string }> {
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<
    { id: string }[]
  >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Thesis','active') RETURNING id`;
  const action = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${project[0]!.id},'Draft citations','one_off','doing',30,60,90,60,'medium',15,90) RETURNING id`;
  return { projectId: project[0]!.id, actionId: action[0]!.id };
}

/** A running action session started `startedHoursAgo` hours ago and planned for an hour. */
async function runningSession(actionId: string, startedHoursAgo: number): Promise<string> {
  const id = crypto.randomUUID();
  const startedAt = hoursAgo(startedHoursAgo);
  await sql`
    INSERT INTO sessions (id,user_id,action_id,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
    VALUES (${id},${userId},${actionId},'running',${startedAt},${new Date(startedAt.getTime() + HOUR)},${startedAt},60,60)`;
  await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${id},${startedAt})`;
  return id;
}

function command(overrides: Partial<SettleCatchUpCommand> & Pick<SettleCatchUpCommand, "verdicts">) {
  return settleCatchUpCommandSchema.parse({ commandId: crypto.randomUUID(), ...overrides });
}

const sessionRow = async (id: string) =>
  (
    await sql<
      { status: string; ended_at: Date | null; version: number }[]
    >`SELECT status,ended_at,version FROM sessions WHERE id=${id}`
  )[0]!;

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
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
    "TRUNCATE TABLE writes, write_rows, catch_up_runs, check_in, session_segments, sessions, sleep_plans, routine_steps, commitments, action_occurrences, action_recurrence_windows, action_recurrence_rules, actions, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
  await sql`UPDATE user_preferences SET last_woke_at=NULL, max_awake_hours=18 WHERE user_id=${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

describe("catch-up's right-now entries", () => {
  it("lists a stale open session first, with Now's question and the verdicts it takes", async () => {
    const { actionId } = await createAction();
    const sessionId = await runningSession(actionId, 5);
    const ledger = await readCatchUpLedger(sql);
    expect(ledger.entries[0]).toMatchObject({
      id: `session:${sessionId}`,
      kind: "open_session",
      title: "Draft citations",
      verdicts: ["done", "ended", "skipped", "pending"],
      atRequired: ["done", "ended"],
      asksRemainingMinutes: true,
      version: 1
    });
    expect(ledger.entries[0]!.question).toMatch(/^Running 5(\.0)? h, planned 1 h\. When did it stop\?$/);
  });

  it("leaves out a session still inside its grace, by the freshness rule", async () => {
    const { actionId } = await createAction();
    await runningSession(actionId, 1.5);
    expect((await readCatchUpLedger(sql)).entries).toEqual([]);
  });

  it("lists a wake older than the awake limit, and not a recent one", async () => {
    await sql`UPDATE user_preferences SET last_woke_at=${hoursAgo(10)} WHERE user_id=${userId}`;
    expect((await readCatchUpLedger(sql)).entries).toEqual([]);
    await sql`UPDATE user_preferences SET last_woke_at=${hoursAgo(30)} WHERE user_id=${userId}`;
    const [wake] = (await readCatchUpLedger(sql)).entries;
    expect(wake).toMatchObject({ id: "wake", kind: "stale_wake", verdicts: ["done", "pending"], atRequired: ["done"] });
    expect(wake!.question).toBe("Last woke 30 h ago. When did you wake up?");
  });

  it("lists only the latest check-in, and only while it is unanswered", async () => {
    await sql`INSERT INTO check_in (user_id,slot_at,directive_kind,directive_title,status) VALUES (${userId},${hoursAgo(5)},'action','Older slot','unknown')`;
    await sql`INSERT INTO check_in (user_id,slot_at,directive_kind,directive_title,status) VALUES (${userId},${hoursAgo(2)},'action','Draft citations','unknown')`;
    const entries = (await readCatchUpLedger(sql)).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "check_in",
      title: "Draft citations",
      question: "Were you on Draft citations 2 h ago?"
    });
    await sql`UPDATE check_in SET answered_at=now() WHERE directive_title='Draft citations'`;
    expect((await readCatchUpLedger(sql)).entries).toEqual([]);
  });
});

describe("settling the right-now entries", () => {
  it("ends a forgotten action session at the time given, through the session finish", async () => {
    const { actionId } = await createAction();
    const sessionId = await runningSession(actionId, 5);
    const stoppedAt = hoursAgo(3.5);
    const result = await settleCatchUp(
      sql as never,
      command({
        verdicts: [
          { entryId: `session:${sessionId}`, verdict: "ended", at: stoppedAt.toISOString(), remainingMinutes: 20 }
        ]
      })
    );
    expect(result.results).toEqual([{ entryId: `session:${sessionId}`, outcome: "applied" }]);
    const row = await sessionRow(sessionId);
    expect(row.status).toBe("stopped");
    expect(row.ended_at!.getTime()).toBe(stoppedAt.getTime());
    const action = await sql<
      { remaining_minutes: number }[]
    >`SELECT remaining_minutes FROM actions WHERE id=${actionId}`;
    expect(action[0]!.remaining_minutes).toBe(20);
    expect((await readCatchUpLedger(sql)).entries).toEqual([]);
  });

  it("logs one change for a settle that ends a session, not one for the session and one for the batch", async () => {
    const { actionId } = await createAction();
    const sessionId = await runningSession(actionId, 5);
    const cmd = command({
      verdicts: [{ entryId: `session:${sessionId}`, verdict: "done", at: hoursAgo(4).toISOString() }]
    });
    expect((await settleCatchUp(sql as never, cmd)).results[0]).toMatchObject({ outcome: "applied" });
    const rows = await sql<
      { entity_type: string }[]
    >`SELECT entity_type FROM write_rows WHERE write_id=${cmd.commandId}`;
    expect(rows.map((row) => row.entity_type)).toEqual(["catch_up"]);
  });

  it("refuses a session end with no time, or one before the session started, and leaves the session open", async () => {
    const { actionId } = await createAction();
    const sessionId = await runningSession(actionId, 5);
    const result = await settleCatchUp(
      sql as never,
      command({
        verdicts: [{ entryId: `session:${sessionId}`, verdict: "done" }]
      })
    );
    expect(result.results[0]).toMatchObject({ outcome: "invalid" });
    const early = await settleCatchUp(
      sql as never,
      command({ verdicts: [{ entryId: `session:${sessionId}`, verdict: "done", at: hoursAgo(6).toISOString() }] })
    );
    expect(early.results[0]).toMatchObject({ outcome: "invalid" });
    expect((await sessionRow(sessionId)).status).toBe("running");
  });

  it("keeps the rest of a settle when one session verdict is refused", async () => {
    const { actionId } = await createAction();
    const sessionId = await runningSession(actionId, 5);
    await sql`UPDATE user_preferences SET last_woke_at=${hoursAgo(30)} WHERE user_id=${userId}`;
    const wokeAt = hoursAgo(6);
    const result = await settleCatchUp(
      sql as never,
      command({
        verdicts: [
          { entryId: `session:${sessionId}`, verdict: "done", at: hoursAgo(6).toISOString() },
          { entryId: "wake", verdict: "done", at: wokeAt.toISOString() }
        ]
      })
    );
    expect(result.results.map((item) => item.outcome)).toEqual(["invalid", "applied"]);
    const prefs = await sql<
      { last_woke_at: Date }[]
    >`SELECT last_woke_at FROM user_preferences WHERE user_id=${userId}`;
    expect(prefs[0]!.last_woke_at.getTime()).toBe(wokeAt.getTime());
  });

  it("records a wake only after the one already recorded", async () => {
    await sql`UPDATE user_preferences SET last_woke_at=${hoursAgo(30)} WHERE user_id=${userId}`;
    const result = await settleCatchUp(
      sql as never,
      command({ verdicts: [{ entryId: "wake", verdict: "done", at: hoursAgo(31).toISOString() }] })
    );
    expect(result.results[0]).toMatchObject({ outcome: "invalid" });
  });

  it("settles a stale wake through the wake verb: last night's planned sleep is completed, and undo reopens it", async () => {
    const earlier = hoursAgo(30);
    await sql`UPDATE user_preferences SET last_woke_at=${earlier} WHERE user_id=${userId}`;
    const planId = crypto.randomUUID();
    const plannedStart = hoursAgo(10);
    await sql`
      INSERT INTO sleep_plans (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,explanation,status,score_components)
      VALUES (${planId},${userId},${plannedStart},${hoursAgo(2)},480,480,'Fixture','planned',${sql.json({} as never)})`;
    const woke = hoursAgo(3);
    const cmd = command({ verdicts: [{ entryId: "wake", verdict: "done", at: woke.toISOString() }] });
    const result = await runWithActor("companion", () => settleCatchUp(sql as never, cmd));
    expect(result.results[0]).toMatchObject({ outcome: "applied" });
    const plan = async () =>
      (
        await sql<
          { status: string; actual_wake_at: Date | null }[]
        >`SELECT status,actual_wake_at FROM sleep_plans WHERE id=${planId}`
      )[0]!;
    expect(await plan()).toMatchObject({ status: "completed" });
    expect((await plan()).actual_wake_at!.getTime()).toBe(woke.getTime());
    const prefs = async () =>
      (await sql<{ last_woke_at: Date }[]>`SELECT last_woke_at FROM user_preferences WHERE user_id=${userId}`)[0]!;
    expect((await prefs()).last_woke_at.getTime()).toBe(woke.getTime());
    await runWithActor("companion", () =>
      runRevertCommand(sql as never, { commandId: crypto.randomUUID(), target: cmd.commandId, direction: "undo" })
    );
    expect((await plan()).status).toBe("planned");
    expect((await prefs()).last_woke_at.getTime()).toBe(earlier.getTime());
  });

  it("answers the open check-in on track, or not sure", async () => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO check_in (user_id,slot_at,directive_kind,directive_title,status) VALUES (${userId},${hoursAgo(2)},'action','Draft citations','unknown') RETURNING id`;
    const id = rows[0]!.id;
    const result = await settleCatchUp(
      sql as never,
      command({ verdicts: [{ entryId: `check-in:${id}`, verdict: "skipped" }] })
    );
    expect(result.results[0]).toMatchObject({ outcome: "applied" });
    const after = await sql<
      { status: string; answered_at: Date | null }[]
    >`SELECT status,answered_at FROM check_in WHERE id=${id}`;
    expect(after[0]!.status).toBe("unknown");
    expect(after[0]!.answered_at).not.toBeNull();
    const again = await settleCatchUp(
      sql as never,
      command({ verdicts: [{ entryId: `check-in:${id}`, verdict: "done" }] })
    );
    expect(again.results[0]).toMatchObject({ outcome: "conflict" });
  });

  it("refuses a verdict an entry does not take", async () => {
    await sql`UPDATE user_preferences SET last_woke_at=${hoursAgo(30)} WHERE user_id=${userId}`;
    const result = await settleCatchUp(sql as never, command({ verdicts: [{ entryId: "wake", verdict: "dropped" }] }));
    expect(result.results[0]).toMatchObject({ outcome: "invalid" });
  });

  it("lets an agent's session end be undone: the session is open again", async () => {
    const { actionId } = await createAction();
    const sessionId = await runningSession(actionId, 5);
    const cmd = command({
      verdicts: [{ entryId: `session:${sessionId}`, verdict: "done", at: hoursAgo(3.5).toISOString() }]
    });
    await runWithActor("companion", () => settleCatchUp(sql as never, cmd));
    expect((await sessionRow(sessionId)).status).toBe("completed");
    await runWithActor("companion", () =>
      runRevertCommand(sql as never, { commandId: crypto.randomUUID(), target: cmd.commandId, direction: "undo" })
    );
    const row = await sessionRow(sessionId);
    expect(row.status).toBe("running");
    expect(row.ended_at).toBeNull();
    const action = await sql<{ status: string }[]>`SELECT status FROM actions WHERE id=${actionId}`;
    expect(action[0]!.status).toBe("doing");
  });

  it("lets an agent's wake be undone", async () => {
    const earlier = hoursAgo(30);
    await sql`UPDATE user_preferences SET last_woke_at=${earlier} WHERE user_id=${userId}`;
    const cmd = command({ verdicts: [{ entryId: "wake", verdict: "done", at: hoursAgo(6).toISOString() }] });
    await runWithActor("companion", () => settleCatchUp(sql as never, cmd));
    await runWithActor("companion", () =>
      runRevertCommand(sql as never, { commandId: crypto.randomUUID(), target: cmd.commandId, direction: "undo" })
    );
    const prefs = await sql<
      { last_woke_at: Date }[]
    >`SELECT last_woke_at FROM user_preferences WHERE user_id=${userId}`;
    expect(prefs[0]!.last_woke_at.getTime()).toBe(earlier.getTime());
  });
});

describe("a paused session, and settles that cannot be undone", () => {
  /** A paused action session: worked from 6 h ago until its pause 5 h ago. */
  async function pausedSession(actionId: string, status: "paused" | "awaiting_feedback" = "paused") {
    const id = crypto.randomUUID();
    const startedAt = hoursAgo(6);
    const pausedAt = hoursAgo(5);
    await sql`
      INSERT INTO sessions (id,user_id,action_id,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes,paused_remaining_seconds,feedback_requested_at)
      VALUES (${id},${userId},${actionId},${status},${startedAt},${new Date(startedAt.getTime() + 2 * HOUR)},${startedAt},120,120,3600,${status === "awaiting_feedback" ? hoursAgo(4) : null})`;
    await sql`INSERT INTO session_segments (session_id,started_at,ended_at) VALUES (${id},${startedAt},${pausedAt})`;
    return { id, pausedAt };
  }

  it("ends a paused session at its pause, not now, and refuses a time for it", async () => {
    const { actionId } = await createAction();
    const { id, pausedAt } = await pausedSession(actionId);
    const [entry] = (await readCatchUpLedger(sql)).entries;
    expect(entry).toMatchObject({ id: `session:${id}`, atRequired: [] });
    const timed = await settleCatchUp(
      sql as never,
      command({ verdicts: [{ entryId: `session:${id}`, verdict: "done", at: hoursAgo(5.5).toISOString() }] })
    );
    expect(timed.results[0]).toMatchObject({ outcome: "invalid" });
    const result = await settleCatchUp(
      sql as never,
      command({ verdicts: [{ entryId: `session:${id}`, verdict: "done" }] })
    );
    expect(result.results[0]).toMatchObject({ outcome: "applied" });
    expect((await sessionRow(id)).ended_at!.getTime()).toBe(pausedAt.getTime());
  });

  it("treats a paused session that went on to await feedback as paused", async () => {
    const { actionId } = await createAction();
    const { id, pausedAt } = await pausedSession(actionId, "awaiting_feedback");
    const [entry] = (await readCatchUpLedger(sql)).entries;
    expect(entry).toMatchObject({ id: `session:${id}`, atRequired: [] });
    const result = await settleCatchUp(
      sql as never,
      command({ verdicts: [{ entryId: `session:${id}`, verdict: "ended" }] })
    );
    expect(result.results[0]).toMatchObject({ outcome: "applied" });
    expect((await sessionRow(id)).ended_at!.getTime()).toBe(pausedAt.getTime());
  });

  it("keeps no undo for an agent's settle that ended an activity session, and says so", async () => {
    const id = crypto.randomUUID();
    const startedAt = hoursAgo(9);
    await sql`
      INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
      VALUES (${id},${userId},'fixed_commitment',${crypto.randomUUID()},'Shift','running',${startedAt},${new Date(startedAt.getTime() + HOUR)},${startedAt},60,60)`;
    await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${id},${startedAt})`;
    const [entry] = (await readCatchUpLedger(sql)).entries;
    expect(entry!.asksRemainingMinutes).toBeUndefined();
    const withMinutes = await settleCatchUp(
      sql as never,
      command({
        verdicts: [{ entryId: `session:${id}`, verdict: "done", at: hoursAgo(8).toISOString(), remainingMinutes: 5 }]
      })
    );
    expect(withMinutes.results[0]).toMatchObject({ outcome: "invalid" });
    const cmd = command({ verdicts: [{ entryId: `session:${id}`, verdict: "done", at: hoursAgo(8).toISOString() }] });
    const result = await runWithActor("companion", () => settleCatchUp(sql as never, cmd));
    expect(result).toMatchObject({ results: [{ outcome: "applied" }], revertible: false });
    expect((await sessionRow(id)).status).toBe("completed");
    const kept = await sql`SELECT 1 FROM writes WHERE id=${cmd.commandId} AND images IS NOT NULL`;
    expect(kept).toHaveLength(0);
  });

  it("puts a routine step back to pending when its stale session is answered didn't start", async () => {
    const commitmentId = crypto.randomUUID();
    await sql`
      INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status,transition_after_minutes)
      VALUES (${commitmentId},${userId},'Work',${hoursAgo(10)},${hoursAgo(9)},'confirmed',0)`;
    const stepId = crypto.randomUUID();
    await sql`
      INSERT INTO routine_steps (id,user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,phase,status,scheduled_start_at,scheduled_end_at)
      VALUES (${stepId},${userId},${commitmentId},'commitment',${commitmentId},'Pack bag',15,1,'contiguous','before','doing',${hoursAgo(11)},${hoursAgo(10)})`;
    const id = crypto.randomUUID();
    const startedAt = hoursAgo(11);
    await sql`
      INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
      VALUES (${id},${userId},'routine_step',${stepId},'Pack bag','running',${startedAt},${new Date(startedAt.getTime() + HOUR)},${startedAt},15,15)`;
    await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${id},${startedAt})`;
    const result = await settleCatchUp(
      sql as never,
      command({ verdicts: [{ entryId: `session:${id}`, verdict: "skipped" }] })
    );
    expect(result.results[0]).toMatchObject({ outcome: "applied" });
    expect((await sessionRow(id)).status).toBe("did_not_start");
    const step = await sql<{ status: string }[]>`SELECT status FROM routine_steps WHERE id=${stepId}`;
    expect(step[0]!.status).toBe("pending");
  });

  it("still undoes an agent's wake after the device state and the horizon move", async () => {
    const earlier = hoursAgo(30);
    await sql`UPDATE user_preferences SET last_woke_at=${earlier} WHERE user_id=${userId}`;
    const cmd = command({ verdicts: [{ entryId: "wake", verdict: "done", at: hoursAgo(6).toISOString() }] });
    await runWithActor("companion", () => settleCatchUp(sql as never, cmd));
    // What a device report and any later write do to the row, neither bumping its version.
    await sql`UPDATE user_preferences SET device_location_state=${sql.json({ pinged: true } as never)}, current_horizon_end_at=now() + interval '8 days' WHERE user_id=${userId}`;
    await runWithActor("companion", () =>
      runRevertCommand(sql as never, { commandId: crypto.randomUUID(), target: cmd.commandId, direction: "undo" })
    );
    const prefs = await sql<
      { last_woke_at: Date }[]
    >`SELECT last_woke_at FROM user_preferences WHERE user_id=${userId}`;
    expect(prefs[0]!.last_woke_at.getTime()).toBe(earlier.getTime());
  });
});

describe("a recurring action's open session, and paging", () => {
  async function recurringOccurrence(actionId: string, endsHoursAgo: number) {
    await sql`UPDATE actions SET scheduling_mode='recurring', status='active' WHERE id=${actionId}`;
    const rule = await sql<{ id: string }[]>`
      INSERT INTO action_recurrence_rules (action_id,timezone,start_date,interval_days,completion_mode)
      VALUES (${actionId},'UTC','2026-01-01',1,'manual') RETURNING id`;
    const window = await sql<{ id: string }[]>`
      INSERT INTO action_recurrence_windows (rule_id,name,anchor,local_start_time,local_end_time)
      VALUES (${rule[0]!.id},'Day','local_time','00:00','23:59') RETURNING id`;
    return { ruleId: rule[0]!.id, windowId: window[0]!.id, endsHoursAgo };
  }

  it("names an open session on a recurring occurrence by its action, and settles it", async () => {
    const { actionId } = await createAction();
    const { ruleId, windowId } = await recurringOccurrence(actionId, 0);
    const startedAt = hoursAgo(5);
    const occurrenceId = `${ruleId}:2026-10-28:${windowId}`;
    await sql`
      INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source)
      VALUES (${occurrenceId},${actionId},${ruleId},${windowId},'2026-10-28',${hoursAgo(6)},${new Date(Date.now() + HOUR)},'local_time')`;
    const id = crypto.randomUUID();
    await sql`
      INSERT INTO sessions (id,user_id,action_id,occurrence_id,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
      VALUES (${id},${userId},${actionId},${occurrenceId},'running',${startedAt},${new Date(startedAt.getTime() + HOUR)},${startedAt},60,60)`;
    await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${id},${startedAt})`;
    const [entry] = (await readCatchUpLedger(sql)).entries;
    expect(entry).toMatchObject({ id: `session:${id}`, title: "Draft citations" });
    const result = await settleCatchUp(
      sql as never,
      command({ verdicts: [{ entryId: `session:${id}`, verdict: "done", at: hoursAgo(4).toISOString() }] })
    );
    expect(result.results[0]).toMatchObject({ outcome: "applied" });
    expect((await sessionRow(id)).status).toBe("completed");
  });

  it("carries the right-now entries on page 1 as extras and says where page 2 starts", async () => {
    const { actionId } = await createAction();
    const { ruleId, windowId } = await recurringOccurrence(actionId, 0);
    for (let index = 0; index < 51; index += 1) {
      const ends = hoursAgo(24 + index);
      await sql`
        INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source)
        VALUES (${`occ-${index}`},${actionId},${ruleId},${windowId},'2026-10-10',${new Date(ends.getTime() - HOUR)},${ends},'local_time')`;
    }
    await sql`UPDATE user_preferences SET last_woke_at=${hoursAgo(30)} WHERE user_id=${userId}`;
    const first = await readCatchUpLedger(sql);
    expect(first.entries).toHaveLength(51);
    expect(first.entries[0]!.kind).toBe("stale_wake");
    expect(first).toMatchObject({ remaining: 1, nextOffset: 50 });
    const second = await readCatchUpLedger(sql, { offset: first.nextOffset! });
    expect(second.entries.map((entry) => entry.id)).toEqual(["occurrence:occ-50"]);
    expect(second).toMatchObject({ remaining: 0, nextOffset: null });
  });
});

describe("skip everything older than N days", () => {
  it("skips old occurrences, clears old self-set dates and answers an old check-in, across the whole window", async () => {
    const { projectId, actionId } = await createAction();
    const rule = await sql<{ id: string }[]>`
      INSERT INTO action_recurrence_rules (action_id,timezone,start_date,interval_days,completion_mode)
      VALUES (${actionId},'UTC','2026-01-01',1,'manual') RETURNING id`;
    const window = await sql<{ id: string }[]>`
      INSERT INTO action_recurrence_windows (rule_id,name,anchor,local_start_time,local_end_time)
      VALUES (${rule[0]!.id},'Day','local_time','08:00','20:00') RETURNING id`;
    const occurrence = async (endedHoursAgo: number) => {
      const id = `occ-${crypto.randomUUID()}`;
      const ends = hoursAgo(endedHoursAgo);
      await sql`
        INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source)
        VALUES (${id},${actionId},${rule[0]!.id},${window[0]!.id},'2026-10-10',${new Date(ends.getTime() - HOUR)},${ends},'local_time')`;
      return id;
    };
    const old = await occurrence(10 * 24);
    const recent = await occurrence(2 * 24);
    await sql`UPDATE projects SET internal_deadline_at=${hoursAgo(9 * 24)} WHERE id=${projectId}`;
    await sql`INSERT INTO check_in (user_id,slot_at,directive_kind,directive_title,status) VALUES (${userId},${hoursAgo(8 * 24)},'action','Old slot','unknown')`;

    const result = await settleCatchUp(sql as never, command({ verdicts: [{ bulk: "skip_older_than", days: 7 }] }));
    expect(result.results.map((item) => item.outcome)).toEqual(["applied", "applied", "applied"]);
    const status = async (id: string) =>
      (await sql<{ status: string }[]>`SELECT status FROM action_occurrences WHERE id=${id}`)[0]!.status;
    expect(await status(old)).toBe("missed");
    expect(await status(recent)).toBe("pending");
    const project = await sql<
      { internal_deadline_at: Date | null }[]
    >`SELECT internal_deadline_at FROM projects WHERE id=${projectId}`;
    expect(project[0]!.internal_deadline_at).toBeNull();
    const ledger = await readCatchUpLedger(sql);
    expect(ledger.entries.map((entry) => entry.id)).toEqual([`occurrence:${recent}`]);
  });
});
