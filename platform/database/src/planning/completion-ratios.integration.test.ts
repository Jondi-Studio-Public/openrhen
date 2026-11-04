import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import type { PortalStateContract } from "@openrhen/contracts";
import { deriveProjectPace } from "./completion-ratios.js";
import { integrationDatabaseName } from "../operations/integration-database.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
// A database of its own for the same reason every other suite in this folder has one: this suite
// truncates, and two suites truncating the same database is an unreproducible flake.
const testDatabaseName = integrationDatabaseName(
  process.env.COMPLETION_RATIOS_TEST_DATABASE_NAME,
  "openrhen_completion_ratios"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("COMPLETION_RATIOS_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

beforeAll(async () => {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<
      { exists: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
    if (!existing[0]?.exists) await admin.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
  } finally {
    await admin.end();
  }
  const migrationSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  // This suite is allowed to clear only a database whose validated name ends in _test.
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  const users = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Pace Fixture') RETURNING id`;
  userId = users[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

async function createProject(deadlineAt: Date, status: "active" | "paused" | "archived" = "active"): Promise<string> {
  const areas = await sql<{ id: string }[]>`
    INSERT INTO areas (user_id,name,sort_order) VALUES (${userId},'Study',1) RETURNING id
  `;
  const outcomes = await sql<{ id: string }[]>`
    INSERT INTO outcomes (area_id,title,definition_of_done) VALUES (${areas[0]!.id},'Graduate','Degree awarded') RETURNING id
  `;
  const projects = await sql<{ id: string }[]>`
    INSERT INTO projects (outcome_id,title,status,internal_deadline_at) VALUES (${outcomes[0]!.id},'Thesis',${status},${deadlineAt}) RETURNING id
  `;
  return projects[0]!.id;
}

async function addAction(
  projectId: string,
  status: "planned" | "done" | "active",
  expectedMinutes: number,
  remainingMinutes: number
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${projectId},'Write chapter','one_off',${status},${Math.max(1, Math.floor(expectedMinutes / 2))},${expectedMinutes},${expectedMinutes * 2},${remainingMinutes},'medium',15,60) RETURNING id
  `;
  return rows[0]!.id;
}

async function projectRow(id: string) {
  return (
    await sql<
      {
        forecast_started_at: Date | null;
        baseline_estimate_minutes: number | null;
        actual_completion_ratio: string | null;
        required_completion_ratio: string | null;
      }[]
    >`SELECT forecast_started_at, baseline_estimate_minutes, actual_completion_ratio, required_completion_ratio FROM projects WHERE id=${id}`
  )[0]!;
}

/** A minimal contract-shaped project/action pair `deriveProjectPace` reads — the same wire shape
 * `readPortalState` produces, built by hand here so this suite can drive scenarios without going
 * through a full state read. */
function stateOf(
  projectId: string,
  deadlineAt: Date,
  status: "active" | "paused" | "archived",
  actions: Array<{ id: string; status: "planned" | "done"; expectedMinutes: number; remainingMinutes: number }>
): { projects: PortalStateContract["projects"]; actions: PortalStateContract["actions"] } {
  return {
    projects: [
      {
        id: projectId,
        title: "Thesis",
        area: "Study",
        outcomeId: "outcome",
        status,
        uncertainty: "known",
        value: 3,
        consequence: 3,
        internalDeadlineAt: deadlineAt.toISOString()
      }
    ],
    actions: actions.map((action) => ({
      id: action.id,
      projectId,
      title: "Write chapter",
      status: action.status,
      optimisticMinutes: Math.max(1, Math.floor(action.expectedMinutes / 2)),
      expectedMinutes: action.expectedMinutes,
      pessimisticMinutes: action.expectedMinutes * 2,
      remainingMinutes: action.remainingMinutes,
      splittable: true,
      setupMinutes: 0,
      energy: "medium",
      minimumSessionMinutes: 15,
      maximumSessionMinutes: 60,
      importance: 3,
      consequence: 3,
      contexts: [],
      dependencyIds: [],
      requirementPathways: [],
      preferences: [],
      schedulingMode: "one_off"
    }))
  };
}

describe("deriveProjectPace — baseline persistence", () => {
  it("captures forecast_started_at and baseline_estimate_minutes the first time a project qualifies", async () => {
    const now = new Date("2026-09-04T00:00:00.000Z");
    const deadline = new Date("2026-10-04T00:00:00.000Z");
    const projectId = await createProject(deadline);
    const actionId = await addAction(projectId, "planned", 100, 100);
    const state = stateOf(projectId, deadline, "active", [
      { id: actionId, status: "planned", expectedMinutes: 100, remainingMinutes: 100 }
    ]);

    const updates = await deriveProjectPace(sql, state.projects, state.actions, now);
    expect(updates.get(projectId)?.actualCompletionRatio).toBeCloseTo(0, 5);

    const row = await projectRow(projectId);
    expect(row.forecast_started_at?.toISOString()).toBe(now.toISOString());
    expect(row.baseline_estimate_minutes).toBe(100);
    expect(Number(row.required_completion_ratio)).toBeCloseTo(0, 5);
  });

  it("never overwrites an existing baseline, even as the project's scope and status change", async () => {
    const first = new Date("2026-09-04T00:00:00.000Z");
    const deadline = new Date("2026-10-04T00:00:00.000Z");
    const projectId = await createProject(deadline);
    const actionId = await addAction(projectId, "planned", 100, 100);
    const initialState = stateOf(projectId, deadline, "active", [
      { id: actionId, status: "planned", expectedMinutes: 100, remainingMinutes: 100 }
    ]);
    await deriveProjectPace(sql, initialState.projects, initialState.actions, first);
    const baseline = await projectRow(projectId);

    // Ten days later, half the work is done and a second action added new scope — the baseline must
    // hold steady regardless.
    const later = new Date("2026-09-14T00:00:00.000Z");
    const secondActionId = await addAction(projectId, "planned", 40, 40);
    const laterState = stateOf(projectId, deadline, "active", [
      { id: actionId, status: "done", expectedMinutes: 100, remainingMinutes: 0 },
      { id: secondActionId, status: "planned", expectedMinutes: 40, remainingMinutes: 40 }
    ]);
    const updates = await deriveProjectPace(sql, laterState.projects, laterState.actions, later);

    const row = await projectRow(projectId);
    expect(row.forecast_started_at?.toISOString()).toBe(baseline.forecast_started_at!.toISOString());
    expect(row.baseline_estimate_minutes).toBe(baseline.baseline_estimate_minutes);
    // Denominator is max(baseline 100, current total 140) = 140; 100 minutes are done.
    expect(updates.get(projectId)?.actualCompletionRatio).toBeCloseTo(100 / 140, 5);
    expect(Number(row.required_completion_ratio)).toBeGreaterThan(0);
  });

  it("captures a fresh baseline once forecast_started_at is reset, as on re-activation", async () => {
    const first = new Date("2026-09-04T00:00:00.000Z");
    const deadline = new Date("2026-10-04T00:00:00.000Z");
    const projectId = await createProject(deadline);
    const actionId = await addAction(projectId, "planned", 100, 100);
    const state = stateOf(projectId, deadline, "active", [
      { id: actionId, status: "planned", expectedMinutes: 100, remainingMinutes: 100 }
    ]);
    await deriveProjectPace(sql, state.projects, state.actions, first);

    // saveProject resets both columns to null on a paused/archived -> active transition; simulated
    // directly here since that reset lives in the portal command layer, not this package.
    await sql`UPDATE projects SET forecast_started_at=NULL, baseline_estimate_minutes=NULL WHERE id=${projectId}`;

    const reactivatedAt = new Date("2026-09-20T00:00:00.000Z");
    const secondActionId = await addAction(projectId, "planned", 30, 30);
    const reactivatedState = stateOf(projectId, deadline, "active", [
      { id: actionId, status: "planned", expectedMinutes: 100, remainingMinutes: 100 },
      { id: secondActionId, status: "planned", expectedMinutes: 30, remainingMinutes: 30 }
    ]);
    await deriveProjectPace(sql, reactivatedState.projects, reactivatedState.actions, reactivatedAt);

    const row = await projectRow(projectId);
    expect(row.forecast_started_at?.toISOString()).toBe(reactivatedAt.toISOString());
    expect(row.baseline_estimate_minutes).toBe(130);
  });

  it("leaves a paused project's ratios untouched", async () => {
    const now = new Date("2026-09-04T00:00:00.000Z");
    const deadline = new Date("2026-10-04T00:00:00.000Z");
    const projectId = await createProject(deadline, "paused");
    const actionId = await addAction(projectId, "planned", 100, 100);
    const state = stateOf(projectId, deadline, "paused", [
      { id: actionId, status: "planned", expectedMinutes: 100, remainingMinutes: 100 }
    ]);

    const updates = await deriveProjectPace(sql, state.projects, state.actions, now);
    expect(updates.size).toBe(0);

    const row = await projectRow(projectId);
    expect(row.forecast_started_at).toBeNull();
    expect(row.baseline_estimate_minutes).toBeNull();
  });
});
