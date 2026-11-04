import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { readProjectRecordedMinutes } from "./area-time-read";
import { ensureUser } from "../ensure-user";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_area_time_read");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const now = new Date("2026-09-30T00:00:00Z");
const since = new Date("2026-09-02T00:00:00Z");
const at = (iso: string) => new Date(iso);

async function createProject(title: string): Promise<string> {
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<
    { id: string }[]
  >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},${title},'active') RETURNING id`;
  return project[0]!.id;
}

async function createAction(projectId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${projectId},'Work','one_off','active',10,20,30,20,'medium',10,30)
    RETURNING id
  `;
  return rows[0]!.id;
}

/** A session with the given segments; `null` for an end leaves that segment, and the session, running. */
async function insertSession(
  target: { actionId?: string; deliverableId?: string; targetType?: string },
  segments: { start: Date; end: Date | null; stepId?: string }[]
): Promise<void> {
  const first = segments[0]!.start;
  const open = segments.some((segment) => segment.end === null);
  const endedAt = open ? null : segments[segments.length - 1]!.end;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO sessions (user_id, action_id, target_type, target_id, status, planned_started_at, planned_end_at, started_at, ended_at, planned_minutes, remaining_before_minutes)
    VALUES (${userId}, ${target.actionId ?? null}, ${target.targetType ?? "action"}, ${target.deliverableId ?? null}, ${open ? "running" : "completed"},
      ${first}, ${new Date(first.getTime() + 60 * 60_000)}, ${first}, ${endedAt}, 60, 60)
    RETURNING id
  `;
  for (const segment of segments)
    await sql`INSERT INTO session_segments (session_id, started_at, ended_at, step_id) VALUES (${rows[0]!.id}, ${segment.start}, ${segment.end}, ${segment.stepId ?? null})`;
}

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
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
    "TRUNCATE TABLE session_segments, sessions, deliverables, actions, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

describe("readProjectRecordedMinutes", () => {
  it("sums segments per project, clipped to the window, with an open segment counted up to now", async () => {
    const projectId = await createProject("Essay");
    const actionId = await createAction(projectId);
    await insertSession({ actionId }, [
      { start: at("2026-09-10T01:00:00Z"), end: at("2026-09-10T01:30:00Z") },
      { start: at("2026-09-10T02:00:00Z"), end: at("2026-09-10T02:15:00Z") }
    ]);
    // Straddles the window start: only the 20 minutes after `since` count.
    await insertSession({ actionId }, [{ start: at("2026-09-01T23:40:00Z"), end: at("2026-09-02T00:20:00Z") }]);
    // Entirely before the window.
    await insertSession({ actionId }, [{ start: at("2026-08-20T01:00:00Z"), end: at("2026-08-20T03:00:00Z") }]);
    // Still running: counts up to `now`.
    await insertSession({ actionId }, [{ start: at("2026-09-29T23:50:00Z"), end: null }]);
    expect(await readProjectRecordedMinutes(sql, userId, since, now)).toEqual([{ projectId, minutes: 75 }]);
  });

  it("gives a deliverable segment to its step's project, else the deliverable's, and skips sleep", async () => {
    const projectId = await createProject("Report");
    const stepId = await createAction(projectId);
    const deliverable = await sql<
      { id: string }[]
    >`INSERT INTO deliverables (project_id,title) VALUES (${projectId},'Report') RETURNING id`;
    await insertSession({ targetType: "deliverable", deliverableId: deliverable[0]!.id }, [
      { start: at("2026-09-12T01:00:00Z"), end: at("2026-09-12T01:40:00Z"), stepId },
      { start: at("2026-09-12T02:00:00Z"), end: at("2026-09-12T02:20:00Z") }
    ]);
    await insertSession({ targetType: "sleep" }, [
      { start: at("2026-09-12T12:00:00Z"), end: at("2026-09-12T20:00:00Z") }
    ]);
    expect(await readProjectRecordedMinutes(sql, userId, since, now)).toEqual([{ projectId, minutes: 60 }]);
  });
});
