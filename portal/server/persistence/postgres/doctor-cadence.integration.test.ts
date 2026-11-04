import "@/test/example-calendar-sources";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { readCadenceSlice } from "./doctor-cadence";

/** The cadence checks' reader: cadences, missed runs and sync status, user-scoped. */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_doctor_cadence");

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
const localDate = (days: number) => daysAgo(days).toISOString().slice(0, 10);

async function createProject(owner: string): Promise<string> {
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${owner},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<
    { id: string }[]
  >`INSERT INTO projects (outcome_id,title,status,created_at) VALUES (${outcome[0]!.id},'P','active',${daysAgo(200)}) RETURNING id`;
  return project[0]!.id;
}

async function createRule(owner: string, title: string, mode: "cadence" | "recurring") {
  const projectId = await createProject(owner);
  const action = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,created_at)
    VALUES (${projectId},${title},${mode},'active',5,10,15,10,'low',5,15,${daysAgo(200)}) RETURNING id`;
  const rule = await sql<{ id: string }[]>`
    INSERT INTO action_recurrence_rules (action_id,timezone,start_date,end_date,interval_days,completion_mode)
    VALUES (${action[0]!.id},'Australia/Sydney',${localDate(100)},NULL,7,'manual') RETURNING id`;
  return { actionId: action[0]!.id, ruleId: rule[0]!.id };
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
    "TRUNCATE TABLE integration_sync_runs, action_occurrences, action_cadence_completions, action_recurrence_windows, action_recurrence_rules, actions, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
  await sql`DELETE FROM users WHERE id <> ${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

describe("readCadenceSlice", () => {
  it("reads nothing from an empty database", async () => {
    expect(await readCadenceSlice(sql as never, userId, NOW)).toEqual({ cadences: [], recurring: [], syncs: [] });
  });

  it("reads a cadence with its completion log, scoped to the user", async () => {
    const mine = await createRule(userId, "Gym", "cadence");
    await sql`INSERT INTO action_cadence_completions (action_id,rule_id,completed_at,local_date)
      VALUES (${mine.actionId},${mine.ruleId},${daysAgo(20)},${localDate(20)}),(${mine.actionId},${mine.ruleId},${daysAgo(30)},${localDate(30)})`;
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    await createRule(other, "Theirs", "cadence");
    const slice = await readCadenceSlice(sql as never, userId, NOW);
    expect(slice.cadences).toHaveLength(1);
    expect(slice.cadences[0]).toMatchObject({ id: mine.actionId, title: "Gym" });
    expect(slice.cadences[0]!.rule).toMatchObject({
      intervalDays: 7,
      lastCompletedLocalDate: localDate(20),
      completionLocalDates: [localDate(30), localDate(20)]
    });
    expect(slice.recurring).toEqual([]);
  });

  it("uses the rule's own timezone and skips ended rules", async () => {
    const mine = await createRule(userId, "Tokyo", "cadence");
    await sql`UPDATE action_recurrence_rules SET timezone='Pacific/Kiritimati' WHERE id=${mine.ruleId}`;
    const ended = await createRule(userId, "Ended", "cadence");
    await sql`UPDATE action_recurrence_rules SET end_date=${localDate(2)} WHERE id=${ended.ruleId}`;
    const endedRec = await createRule(userId, "EndedRec", "recurring");
    await sql`UPDATE action_recurrence_rules SET end_date=${localDate(2)} WHERE id=${endedRec.ruleId}`;
    const wid = (
      await sql<
        { id: string }[]
      >`INSERT INTO action_recurrence_windows (rule_id,name,anchor,local_start_time,local_end_time)
        VALUES (${endedRec.ruleId},'w','local_time','09:00','10:00') RETURNING id`
    )[0]!.id;
    await sql`INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source,status)
      VALUES ('e1',${endedRec.actionId},${endedRec.ruleId},${wid},${localDate(5)},${daysAgo(5)},${daysAgo(4)},'local_time','missed')`;
    const slice = await readCadenceSlice(sql as never, userId, NOW);
    expect(slice.cadences.map((c) => c.id)).toEqual([mine.actionId]);
    expect(slice.cadences[0]!.rule.timezone).toBe("Pacific/Kiritimati");
    expect(slice.recurring).toEqual([]);
  });

  it("orders same-day occurrences by window start", async () => {
    const mine = await createRule(userId, "Twice", "recurring");
    const wid = (
      await sql<
        { id: string }[]
      >`INSERT INTO action_recurrence_windows (rule_id,name,anchor,local_start_time,local_end_time)
        VALUES (${mine.ruleId},'w','local_time','09:00','10:00') RETURNING id`
    )[0]!.id;
    const day = localDate(1);
    for (const [id, hour, status] of [
      ["m", 8, "completed"],
      ["n", 18, "missed"]
    ] as const) {
      const at = new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
      await sql`INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source,status)
        VALUES (${id},${mine.actionId},${mine.ruleId},${wid},${day},${at},${new Date(at.getTime() + 3_600_000)},'local_time',${status})`;
    }
    const slice = await readCadenceSlice(sql as never, userId, NOW);
    expect(slice.recurring[0]!.recent.map((o) => o.status)).toEqual(["missed", "completed"]);
  });

  it("reads settled occurrences of a recurring action newest first, leaving pending ones out", async () => {
    const mine = await createRule(userId, "Stretch", "recurring");
    const wid = (
      await sql<
        { id: string }[]
      >`INSERT INTO action_recurrence_windows (rule_id,name,anchor,local_start_time,local_end_time)
        VALUES (${mine.ruleId},'w','local_time','09:00','10:00') RETURNING id`
    )[0]!.id;
    const statuses = ["completed", "missed", "missed", "pending", "missed"];
    for (const [i, status] of statuses.entries()) {
      const at = daysAgo(statuses.length - i);
      await sql`INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source,status)
        VALUES (${`occ-${i}`},${mine.actionId},${mine.ruleId},${wid},${at.toISOString().slice(0, 10)},${at},${new Date(at.getTime() + 3_600_000)},'local_time',${status})`;
    }
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    await createRule(other, "Theirs", "recurring");
    const slice = await readCadenceSlice(sql as never, userId, NOW);
    expect(slice.recurring).toHaveLength(1);
    expect(slice.recurring[0]!.recent.map((o) => o.status)).toEqual(["missed", "missed", "missed", "completed"]);
  });

  it("reads each provider's latest run and last success, status only, for this user", async () => {
    await sql`INSERT INTO integration_sync_runs (user_id,provider,trigger,started_at,finished_at,status,summary)
      VALUES (${userId},'google_calendar','scheduled',${daysAgo(2)},${daysAgo(2)},'synced','{}'),
             (${userId},'google_calendar','scheduled',${daysAgo(1)},${daysAgo(1)},'needs_review','{"error":"secret detail"}'),
             (${userId},'example_shared_publish','scheduled',${daysAgo(1)},${daysAgo(1)},'synced','{}')`;
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    await sql`INSERT INTO integration_sync_runs (user_id,provider,trigger,started_at,finished_at,status,summary)
      VALUES (${other},'example_daily','scheduled',${daysAgo(1)},${daysAgo(1)},'synced','{}')`;
    const slice = await readCadenceSlice(sql as never, userId, NOW);
    expect(slice.syncs.map((s) => s.provider).sort()).toEqual(["google_calendar"]);
    const google = slice.syncs.find((s) => s.provider === "google_calendar")!;
    expect(google).toMatchObject({ lastRunStatus: "needs_review", lastSuccessAt: daysAgo(1).toISOString() });
    expect(JSON.stringify(slice)).not.toContain("secret detail");
  });
});
