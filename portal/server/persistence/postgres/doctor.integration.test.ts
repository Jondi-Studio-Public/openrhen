import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { readDoctorReport } from "./doctor";

/**
 * The data health check's reader: each fact it reads from the tables lands as the
 * right item, and a plan with nothing wrong reports healthy.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "rhen_doctor");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const NOW = new Date("2026-10-18T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const daysAhead = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

async function createProject(title: string, lastWorkedAt: Date | null = null): Promise<string> {
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<{ id: string }[]>`
    INSERT INTO projects (outcome_id,title,status,last_worked_at,created_at)
    VALUES (${outcome[0]!.id},${title},'active',${lastWorkedAt},${lastWorkedAt ?? NOW}) RETURNING id`;
  return project[0]!.id;
}

async function createAction(projectId: string, title: string, needsReview: boolean): Promise<string> {
  const action = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,estimate_needs_review)
    VALUES (${projectId},${title},'one_off','planned',30,60,90,60,'medium',15,60,${needsReview}) RETURNING id`;
  return action[0]!.id;
}

async function createCommitment(title: string, startsAt: Date, withPlace: boolean): Promise<string> {
  const row = await sql<{ id: string }[]>`
    INSERT INTO commitments (user_id,title,starts_at,ends_at,status,location_id,transport_mode)
    VALUES (${userId},${title},${startsAt},${new Date(startsAt.getTime() + 3_600_000)},'confirmed',
      ${withPlace ? "home" : null},${withPlace ? "car" : null}) RETURNING id`;
  return row[0]!.id;
}

interface RoutineOptions {
  start: string;
  end?: string;
  periodUnit?: "days" | "month";
  periodLength?: number;
  createdAt?: Date;
}

async function createRoutine(projectId: string, title: string, options: RoutineOptions): Promise<string> {
  const action = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,created_at)
    VALUES (${projectId},${title},'recurring','active',5,10,15,10,'low',5,15,${options.createdAt ?? daysAgo(200)}) RETURNING id`;
  await sql`
    INSERT INTO action_recurrence_rules (action_id,timezone,start_date,end_date,interval_days,completion_mode,period_unit,period_length,target_occurrences)
    VALUES (${action[0]!.id},'Australia/Sydney',${options.start},${options.end ?? null},1,${options.end ? "end_date" : "manual"},
      ${options.periodUnit ?? null},${options.periodLength ?? null},${options.periodUnit ? 1 : null})`;
  return action[0]!.id;
}

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
    "TRUNCATE TABLE writes, write_rows, catch_up_runs, integration_sync_runs, planning_runs, commitments, action_occurrences, action_recurrence_windows, action_recurrence_rules, actions, deliverables, projects, outcomes, areas, captures, plan_findings, import_batches, pulse_segments, push_outbox RESTART IDENTITY CASCADE"
  );
  // Energy with no date reads as stale by the freshness rule, so a fresh install is not "healthy" until it is said.
  await sql`DELETE FROM users WHERE id <> ${userId}`;
  // A plan with nothing wrong has a recent backup on record; tests for the recording checks clear it.
  await sql`INSERT INTO integration_sync_runs (user_id,provider,trigger,started_at,finished_at,status,summary)
    VALUES (${userId},'backup','scheduled',${NOW.toISOString()},${NOW.toISOString()},'synced','{}'::jsonb)`;
  await sql`UPDATE user_preferences SET last_woke_at = NULL,
    current_situation = (current_situation - 'locationId' - 'locationSetAt') || ${sql.json({ energySetAt: NOW.toISOString() } as never)} WHERE user_id=${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

describe("readDoctorReport", () => {
  it("reports an empty database healthy", async () => {
    const report = await readDoctorReport(sql as never, { now: NOW });
    expect(report.items).toEqual([]);
    expect(report.healthy).toBe(true);
    expect(report.counts).toEqual({ blocking: 0, degrading: 0, tidy: 0 });
    expect(report.generatedAt).toBe(NOW.toISOString());
  });

  it("reports a sync whose last success is over a day old as blocking, status only", async () => {
    await sql`INSERT INTO integration_sync_runs (user_id,provider,trigger,started_at,finished_at,status,summary)
      VALUES (${userId},'google_calendar','scheduled',${daysAgo(3)},${daysAgo(3)},'synced','{}'),
             (${userId},'google_calendar','scheduled',${daysAgo(1)},${daysAgo(1)},'failed','{"error":"secret detail"}')`;
    const report = await readDoctorReport(sql as never, { now: NOW });
    const item = report.items.find((entry) => entry.id === "sync_failing:google_calendar");
    expect(item).toMatchObject({ tier: "blocking", area: "integrations" });
    expect(JSON.stringify(report)).not.toContain("secret detail");
  });

  it("does not flag one failed tick after a recent success", async () => {
    await sql`INSERT INTO integration_sync_runs (user_id,provider,trigger,started_at,finished_at,status)
      VALUES (${userId},'example_shared','scheduled',${new Date(NOW.getTime() - 7_200_000)},${new Date(NOW.getTime() - 7_200_000)},'synced'),
             (${userId},'example_shared','scheduled',${new Date(NOW.getTime() - 600_000)},${new Date(NOW.getTime() - 600_000)},'failed')`;
    expect((await readDoctorReport(sql as never, { now: NOW })).healthy).toBe(true);
  });

  it("ignores namespaced run rows (import:, ingest:, job:, device:), which are not a sync", async () => {
    await sql`INSERT INTO integration_sync_runs (user_id,provider,trigger,started_at,finished_at,status,summary)
      VALUES (${userId},'import:timeline','manual',${daysAgo(3)},${daysAgo(3)},'failed','{}'),
             (${userId},'ingest:unknown','scheduled',${daysAgo(3)},${daysAgo(3)},'needs_review','{}'),
             (${userId},'job:plan-map-sweep','scheduled',${daysAgo(3)},${daysAgo(3)},'failed','{}'),
             (${userId},'device:handheld','scheduled',${daysAgo(3)},${daysAgo(3)},'failed','{}')`;
    const report = await readDoctorReport(sql as never, { now: NOW });
    expect(report.items.filter((entry) => entry.id.startsWith("sync_failing"))).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  it("reports an action whose estimate needs review as degrading", async () => {
    const projectId = await createProject("Active", NOW);
    const actionId = await createAction(projectId, "Guess", true);
    await createAction(projectId, "Known", false);
    const report = await readDoctorReport(sql as never, { now: NOW });
    expect(report.items.map((entry) => entry.id)).toEqual([`no_estimate:${actionId}`]);
    expect(report.items[0]).toMatchObject({ tier: "degrading", area: "plan", handles: [`action:${actionId}`] });
  });

  it("reports a remaining time the stored forecast aged, and nothing without a plan", async () => {
    const projectId = await createProject("Behind", NOW);
    const actionId = await createAction(projectId, "Old guess", false);
    await sql`UPDATE actions SET remaining_set_at=${daysAgo(20)} WHERE id=${actionId}`;
    expect((await readDoctorReport(sql as never, { now: NOW })).items).toEqual([]);
    const requestId = crypto.randomUUID();
    await sql`INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
      VALUES (${userId},${requestId},'v1','1','v1',${NOW},${new Date(NOW.getTime() + 3_600_000)},
        ${sql.json({ schedule: { forecasts: [{ projectId, health: "at_risk", agedInputs: [{ actionId }] }] } } as never)})`;
    const report = await readDoctorReport(sql as never, { now: NOW });
    expect(report.items.map((entry) => entry.id)).toEqual([`aged_estimate:${actionId}`]);
    expect(report.items[0]).toMatchObject({
      tier: "degrading",
      area: "plan",
      handles: [`action:${actionId}`, `project:${projectId}`]
    });
  });

  it("reports an active project untouched for 30 days as tidy, unless kept or in focus", async () => {
    const idle = await createProject("Idle", daysAgo(45));
    const kept = await createProject("Kept", daysAgo(45));
    const focused = await createProject("Focused", daysAgo(45));
    await createProject("Fresh", daysAgo(2));
    await sql`UPDATE projects SET last_reviewed_at=${daysAgo(5)} WHERE id=${kept}`;
    const period = await sql<{ id: string }[]>`
      INSERT INTO planning_focus_periods (user_id,kind,period_start,period_end)
      VALUES (${userId},'weekly','2026-10-12','2026-10-18') RETURNING id`;
    await sql`INSERT INTO planning_focus_projects (focus_period_id,project_id) VALUES (${period[0]!.id},${focused})`;
    const report = await readDoctorReport(sql as never, { now: NOW });
    expect(report.items.map((entry) => entry.id)).toEqual([`idle_project:${idle}`]);
    expect(report.items[0]).toMatchObject({ tier: "tidy", area: "staleness" });
  });

  it("reports a commitment inside 7 days with no place as blocking, and ignores far, remote or placed ones", async () => {
    const missing = await createCommitment("Dentist", daysAhead(2), false);
    await createCommitment("Far away", daysAhead(20), false);
    await createCommitment("Placed", daysAhead(2), true);
    const remote = await createCommitment("Call", daysAhead(2), false);
    await sql`UPDATE commitments SET attendance='remote' WHERE id=${remote}`;
    const report = await readDoctorReport(sql as never, { now: NOW });
    expect(report.items.map((entry) => entry.id)).toEqual([`commitment_detail:${missing}`]);
    expect(report.items[0]).toMatchObject({
      tier: "blocking",
      area: "calendar",
      handles: [`commitment:${missing}`]
    });
  });

  it("ranks the blocking item ahead of the degrading and tidy ones together", async () => {
    const idle = await createProject("Idle", daysAgo(45));
    const estimateProject = await createProject("Active", NOW);
    const unestimated = await createAction(estimateProject, "Guess", true);
    const commitment = await createCommitment("Dentist", daysAhead(1), false);
    const report = await readDoctorReport(sql as never, { now: NOW });
    expect(report.items.map((entry) => entry.id)).toEqual([
      `commitment_detail:${commitment}`,
      `no_estimate:${unestimated}`,
      `idle_project:${idle}`
    ]);
    expect(report.counts).toEqual({ blocking: 1, degrading: 1, tidy: 1 });
  });

  it("reports a lapsed pulse and a calendar batch held over 3 days", async () => {
    await sql`INSERT INTO pulse_segments (user_id,started_at,state,reason) VALUES (${userId},${daysAgo(1)},'off','lapsed')`;
    const batch = await sql<{ id: string }[]>`
      INSERT INTO import_batches (user_id,source_type,input_kind,timezone,status,created_at)
      VALUES (${userId},'google_calendar','calendar','UTC','ready',${daysAgo(5)}) RETURNING id`;
    await sql`INSERT INTO import_records (batch_id,import_key,entity_type,operation)
      VALUES (${batch[0]!.id},'k1','fixed_commitment','create')`;
    const ids = (await readDoctorReport(sql as never, { now: NOW })).items.map((entry) => entry.id).sort();
    expect(ids).toEqual(["pulse_off", `event_held:${batch[0]!.id}`].sort());
  });

  it("reads nothing of another user's rows", async () => {
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    const area = await sql<
      { id: string }[]
    >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${other},'Theirs','active',0) RETURNING id`;
    const outcome = await sql<
      { id: string }[]
    >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'O','Done','active') RETURNING id`;
    const project = await sql<{ id: string }[]>`
      INSERT INTO projects (outcome_id,title,status,last_worked_at,created_at)
      VALUES (${outcome[0]!.id},'Their idle','active',${daysAgo(90)},${daysAgo(90)}) RETURNING id`;
    const action = await sql<{ id: string }[]>`
      INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,estimate_needs_review)
      VALUES (${project[0]!.id},'Their guess','one_off','planned',30,60,90,60,'medium',15,60,true) RETURNING id`;
    await sql`INSERT INTO integration_sync_runs (user_id,provider,trigger,started_at,finished_at,status)
      VALUES (${other},'example_shared','scheduled',${daysAgo(2)},${daysAgo(2)},'failed')`;
    await sql`INSERT INTO commitments (user_id,title,starts_at,ends_at,status)
      VALUES (${other},'Their dentist',${daysAhead(2)},${daysAhead(3)},'confirmed')`;
    const batch = await sql<{ id: string }[]>`
      INSERT INTO import_batches (user_id,source_type,input_kind,timezone,status,created_at)
      VALUES (${other},'google_calendar','calendar','UTC','ready',${daysAgo(5)}) RETURNING id`;
    await sql`INSERT INTO import_records (batch_id,import_key,entity_type,operation)
      VALUES (${batch[0]!.id},'k1','fixed_commitment','create')`;
    await sql`INSERT INTO action_recurrence_rules (action_id,timezone,start_date,interval_days,completion_mode)
      VALUES (${action[0]!.id},'UTC','2026-01-01',1,'manual')`;
    const report = await readDoctorReport(sql as never, { now: NOW });
    expect(report.items).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  it("reports a stale wake and a stale place as blocking", async () => {
    await sql`UPDATE user_preferences SET last_woke_at=${daysAgo(2)},
      current_situation = current_situation || ${sql.json({ locationId: "home", locationSetAt: daysAgo(2).toISOString() } as never)}
      WHERE user_id=${userId}`;
    const report = await readDoctorReport(sql as never, { now: NOW });
    expect(report.items.map((entry) => entry.id)).toEqual(expect.arrayContaining(["stale_location", "stale_wake"]));
    expect(
      report.items
        .filter((entry) => entry.tier === "blocking")
        .map((entry) => entry.id)
        .sort()
    ).toEqual(["stale_location", "stale_wake"]);
    expect(report.items.find((entry) => entry.id === "stale_wake")).toMatchObject({ area: "facts" });
  });

  describe("routines", () => {
    it("lapses a routine that was never done, counting from its start", async () => {
      const projectId = await createProject("Active", NOW);
      const never = await createRoutine(projectId, "Stretch", { start: "2026-10-08", createdAt: daysAgo(10) });
      const fresh = await createRoutine(projectId, "New", { start: "2026-10-16", createdAt: daysAgo(2) });
      const report = await readDoctorReport(sql as never, { now: NOW });
      const ids = report.items.map((entry) => entry.id);
      expect(ids).toContain(`routine_lapsed:${never}`);
      expect(ids).not.toContain(`routine_lapsed:${fresh}`);
      expect(report.items.find((entry) => entry.id === `routine_lapsed:${never}`)!.title).toContain("never done");
    });

    it("reads a period-unit rule's interval in days, not as no interval", async () => {
      const projectId = await createProject("Active", NOW);
      // Monthly = 30 days, so three intervals is 90 days: 100 days unused has lapsed, 60 has not.
      const monthlyOld = await createRoutine(projectId, "Monthly old", {
        start: "2026-07-01",
        periodUnit: "month",
        createdAt: daysAgo(100)
      });
      const monthlyRecent = await createRoutine(projectId, "Monthly recent", {
        start: "2026-08-19",
        periodUnit: "month",
        createdAt: daysAgo(60)
      });
      // 30 days times 1 per period: also 60 days unused is inside 90.
      const rolling = await createRoutine(projectId, "Rolling", {
        start: "2026-08-19",
        periodUnit: "days",
        periodLength: 30,
        createdAt: daysAgo(60)
      });
      const ids = (await readDoctorReport(sql as never, { now: NOW })).items.map((entry) => entry.id);
      expect(ids).toContain(`routine_lapsed:${monthlyOld}`);
      expect(ids).not.toContain(`routine_lapsed:${monthlyRecent}`);
      expect(ids).not.toContain(`routine_lapsed:${rolling}`);
    });

    it("ends a series at the end of its last day in the person's time zone", async () => {
      const projectId = await createProject("Active", NOW);
      // seed-zone is UTC+11 in October: 2026-10-10 ends at 13:00Z, not at 00:00Z.
      const ended = await createRoutine(projectId, "Ended", {
        start: "2026-10-01",
        end: "2026-10-10",
        createdAt: daysAgo(17)
      });
      // NOW is 23:00 on 2026-10-18 in the seed zone: a series ending that day is still running.
      const lastDay = await createRoutine(projectId, "Last day", {
        start: "2026-10-16",
        end: "2026-10-18",
        createdAt: daysAgo(2)
      });
      const report = await readDoctorReport(sql as never, { now: NOW });
      expect(report.items.find((entry) => entry.id === `routine_ended:${ended}`)).toMatchObject({
        tier: "degrading",
        since: "2026-10-10T13:00:00.000Z"
      });
      expect(report.items.map((entry) => entry.id)).not.toContain(`routine_ended:${lastDay}`);
    });
  });

  describe("catch-up ledger", () => {
    async function unsettledOccurrence(): Promise<void> {
      const projectId = await createProject("Active", NOW);
      const action = await sql<{ id: string }[]>`
        INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,created_at)
        VALUES (${projectId},'Stretch','recurring','active',5,10,15,10,'low',5,15,${daysAgo(30)}) RETURNING id`;
      const rule = await sql<{ id: string }[]>`
        INSERT INTO action_recurrence_rules (action_id,timezone,start_date,interval_days,completion_mode)
        VALUES (${action[0]!.id},'UTC','2026-09-01',30,'manual') RETURNING id`;
      const window = await sql<{ id: string }[]>`
        INSERT INTO action_recurrence_windows (rule_id,name,anchor,local_start_time,local_end_time)
        VALUES (${rule[0]!.id},'Day','local_time','08:00','20:00') RETURNING id`;
      await sql`
        INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source)
        VALUES (${"occ-" + crypto.randomUUID()},${action[0]!.id},${rule[0]!.id},${window[0]!.id},'2026-10-16',${new Date(daysAgo(2).getTime() - 3_600_000)},${daysAgo(2)},'local_time')`;
    }

    it("counts an unsettled occurrence", async () => {
      await unsettledOccurrence();
      const report = await readDoctorReport(sql as never, { now: NOW });
      expect(report.items.find((entry) => entry.id === "catch_up_unsettled")).toMatchObject({
        tier: "degrading",
        area: "ledgers",
        title: expect.stringContaining("1 things")
      });
    });

    it("writes nothing: a pending catch-up nudge stays pending when catch-up is not due", async () => {
      await sql`INSERT INTO push_outbox (user_id,dedupe_key,kind,payload,status,next_attempt_at,expires_at)
        VALUES (${userId},'catch-up-due:2026-10-10T00:00:00.000Z','test','{}','pending',${daysAhead(1)},${daysAhead(4)})`;
      const before = await sql`SELECT * FROM push_outbox ORDER BY id`;
      await readDoctorReport(sql as never, { now: NOW });
      const after = await sql`SELECT * FROM push_outbox ORDER BY id`;
      expect(before).toHaveLength(1);
      expect(after).toEqual(before);
      expect(after[0]!.status).toBe("pending");
    });
  });
});
