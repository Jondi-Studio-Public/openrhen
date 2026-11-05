import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import type { PlanningEntityCommand, RevertCommand } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { CommandConflictError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { saveEntity } from "./entity-commands";
import { confirmProjectWanted } from "./project-commands";
import { runRevertCommand } from "./write-revert";

/**
 * An agent's deliverable save (an aggregate of steps, criteria, blockers, edges and a rolled-forward session) and a
 * project review keep row images and undo through the server revert.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.DELIVERABLE_SNAPSHOT_TEST_DATABASE_NAME,
  "openrhen_deliverable_snapshot"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("DELIVERABLE_SNAPSHOT_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const asAgent = <T>(run: () => Promise<T>, agent = "claude") => runWithActor(agent, run);
// An agent's own save never deletes a step (it is refused); the owner's confirmation of one does, still as the agent's write.
const asConfirmedAgent = <T>(run: () => Promise<T>, agent = "claude") => runWithActor(agent, run, "owner");
const revert = (target: string, direction: "undo" | "redo", force?: boolean): RevertCommand => ({
  commandId: crypto.randomUUID(),
  target,
  direction,
  ...(force === undefined ? {} : { force })
});

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
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "../platform/database/drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, prepare: true });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, planning_focus_periods, condition_definitions, routine_presets, journey_samples, recommendation_candidates, recommendations, spans, sleep_plans, sessions, commitment_recurrence_rules, commitments, actions, projects, outcomes, areas, captures, sources RESTART IDENTITY CASCADE"
  );
  userId = await ensureUser(sql);
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`;
  await sql`UPDATE user_preferences SET home_location_id = NULL WHERE user_id = ${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

async function createProject(): Promise<string> {
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<
    { id: string }[]
  >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Project','active') RETURNING id`;
  return project[0]!.id;
}

const TABLES = [
  "deliverables",
  "actions",
  "action_dependencies",
  "action_requirement_pathways",
  "action_requirements",
  "deliverable_criteria",
  "deliverable_blockers",
  "deliverable_criterion_actions",
  "deliverable_blocker_actions",
  "deliverable_dependencies",
  "session_segments",
  "sessions"
];

/** Every row of the aggregate's tables, without the columns a write and its undo always move. */
async function aggregate(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    const rows = await sql.unsafe<{ image: Record<string, unknown> }[]>(
      `SELECT to_jsonb(t) - 'version' - 'updated_at' AS image FROM ${table} t`
    );
    out[table] = rows.map((row) => row.image).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return out;
}

const savedImages = async (commandId: string) =>
  (await sql<{ images: { table: string }[] | null }[]>`SELECT images FROM writes WHERE id=${commandId}`)[0]!.images;

const step = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  status: "planned",
  optimisticMinutes: 10,
  expectedMinutes: 20,
  pessimisticMinutes: 30,
  remainingMinutes: 20,
  energy: "low",
  minimumSessionMinutes: 10,
  maximumSessionMinutes: 30,
  ...extra
});

function deliverable(projectId: string, id: string, patch: Record<string, unknown>): PlanningEntityCommand["entity"] {
  return {
    id,
    projectId,
    title: "Report",
    status: "ready",
    uncertainty: "some",
    importance: 3,
    consequence: 3,
    steps: [],
    criteria: [],
    blockers: [],
    ...patch
  };
}

const save = (
  entity: PlanningEntityCommand["entity"],
  expectedVersion: number | null,
  commandId = crypto.randomUUID()
) => ({ commandId, expectedVersion, type: "save_entity", entityType: "deliverable", entity }) as PlanningEntityCommand;

const versionOf = async (id: string) =>
  (await sql<{ version: number }[]>`SELECT version FROM deliverables WHERE id=${id}`)[0]!.version;

describe("an agent's deliverable save", () => {
  it("undoes and redoes a change to steps, criteria and blockers, restoring the whole aggregate", async () => {
    const projectId = await createProject();
    const id = crypto.randomUUID();
    const first = save(
      deliverable(projectId, id, {
        steps: [
          step("a", "Draft", { requirementPathways: [["laptop"]] }),
          step("b", "Review", { dependencyIds: ["a"] }),
          step("c", "Submit")
        ],
        criteria: [
          { key: "cover", title: "Covers the brief", stepIds: ["a"] },
          { key: "format", title: "Formatted", stepIds: ["b"] }
        ],
        blockers: [{ id: "x", description: "Need the rubric", stepIds: ["b"] }]
      }),
      null
    );
    await runWithActor(null, () => saveEntity(sql, first));
    const userSession = await sql<{ id: string }[]>`
      INSERT INTO sessions (user_id,action_id,target_type,target_id,status,planned_started_at,planned_end_at,started_at,ended_at,planned_minutes,remaining_before_minutes)
      SELECT ${userId},a.id,'deliverable',${id},'completed',now()-interval '1 hour',now(),now()-interval '1 hour',now(),60,60 FROM actions a WHERE a.deliverable_id=${id} AND a.title='Draft'
      RETURNING id`;
    await sql`INSERT INTO session_segments (session_id,started_at,ended_at,step_id)
      SELECT ${userSession[0]!.id},now()-interval '1 hour',now(),a.id FROM actions a WHERE a.deliverable_id=${id} AND a.title='Review'`;
    const before = await aggregate();
    expect(before.deliverable_criteria).toHaveLength(2);

    // Rename a step, drop "Review" (and with it its edge, criterion link and blocker link), change a criterion,
    // drop the blocker and add a deliverable dependency.
    const other = await sql<
      { id: string }[]
    >`INSERT INTO deliverables (project_id,title) VALUES (${projectId},'Other') RETURNING id`;
    const command = save(
      deliverable(projectId, id, {
        steps: [step("a", "Draft v2", { requirementPathways: [["office"]] }), step("c", "Submit")],
        criteria: [
          { key: "cover", title: "Covers the whole brief", state: "satisfied", stepIds: ["a", "c"] },
          { key: "extra", title: "New clause", stepIds: [] }
        ],
        blockers: [],
        dependencyIds: [other[0]!.id]
      }),
      await versionOf(id)
    );
    await asConfirmedAgent(() => saveEntity(sql, command));
    const after = await aggregate();
    expect(after).not.toEqual(before);
    const kept = (await savedImages(command.commandId))!.map((row) => row.table);
    expect(kept).toEqual(
      expect.arrayContaining([
        "deliverables",
        "actions",
        "action_dependencies",
        "deliverable_criteria",
        "deliverable_blockers",
        "deliverable_criterion_actions",
        "deliverable_blocker_actions",
        "deliverable_dependencies",
        "session_segments"
      ])
    );

    // Only the owner reverses a write the owner confirmed.
    await runWithActor(null, () => runRevertCommand(sql, revert(command.commandId, "undo")));
    const undone = await aggregate();
    // The extra deliverable made for the dependency is outside the write.
    expect(undone.deliverables!.filter((row) => (row as { title: string }).title !== "Other")).toEqual(
      before.deliverables
    );
    for (const table of TABLES.filter((table) => table !== "deliverables"))
      expect(undone[table], table).toEqual(before[table]);

    await runWithActor(null, () => runRevertCommand(sql, revert(command.commandId, "redo")));
    const redone = await aggregate();
    for (const table of TABLES.filter((table) => table !== "deliverables"))
      expect(redone[table], table).toEqual(after[table]);
  });

  it("removes a deliverable the agent created when undone, and brings it back on redo", async () => {
    const projectId = await createProject();
    const id = crypto.randomUUID();
    const command = save(
      deliverable(projectId, id, {
        steps: [step("a", "Draft"), step("b", "Review", { dependencyIds: ["a"] })],
        criteria: [{ key: "cover", title: "Covers the brief", stepIds: ["a"] }],
        blockers: [{ id: "x", description: "Need the rubric", stepIds: ["b"] }]
      }),
      null
    );
    await asAgent(() => saveEntity(sql, command));
    const created = await aggregate();
    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")));
    for (const table of TABLES) expect((await aggregate())[table], table).toEqual([]);
    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "redo")));
    const redone = await aggregate();
    for (const table of TABLES) expect(redone[table], table).toEqual(created[table]);
  });

  it("refuses an undo once a step was changed after the save, and changes nothing", async () => {
    const projectId = await createProject();
    const id = crypto.randomUUID();
    const command = save(deliverable(projectId, id, { steps: [step("a", "Draft")] }), null);
    await asAgent(() => saveEntity(sql, command));
    await sql`UPDATE actions SET title='Edited by the owner', version=version+1 WHERE deliverable_id=${id}`;
    await expect(asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")))).rejects.toThrow(
      CommandConflictError
    );
    expect(await sql`SELECT 1 FROM deliverables WHERE id=${id}`).toHaveLength(1);
    expect((await sql<{ title: string }[]>`SELECT title FROM actions WHERE deliverable_id=${id}`)[0]!.title).toBe(
      "Edited by the owner"
    );
  });

  it("undoes a step finished while a session tracked it, putting the session back on that step", async () => {
    const projectId = await createProject();
    const id = crypto.randomUUID();
    await runWithActor(null, () =>
      saveEntity(sql, save(deliverable(projectId, id, { steps: [step("a", "Draft"), step("b", "Review")] }), null))
    );
    const [a] = await sql<{ id: string }[]>`SELECT id FROM actions WHERE deliverable_id=${id} AND title='Draft'`;
    const [running] = await sql<{ id: string }[]>`
      INSERT INTO sessions (user_id,action_id,target_type,target_id,target_step_id,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
      VALUES (${userId},${a!.id},'deliverable',${id},${a!.id},'running',now()-interval '10 minutes',now()+interval '1 hour',now()-interval '10 minutes',70,60) RETURNING id`;
    await sql`INSERT INTO session_segments (session_id,started_at,step_id) VALUES (${running!.id},now()-interval '10 minutes',${a!.id})`;
    const before = await aggregate();
    const command = save(
      deliverable(projectId, id, {
        steps: [step("a", "Draft", { status: "done", remainingMinutes: 0 }), step("b", "Review")]
      }),
      await versionOf(id)
    );
    await asAgent(() => saveEntity(sql, command));
    expect((await aggregate()).session_segments).not.toEqual(before.session_segments);
    expect((await savedImages(command.commandId))!.map((row) => row.table)).toEqual(
      expect.arrayContaining(["sessions", "session_segments"])
    );
    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")));
    const undone = await aggregate();
    for (const table of TABLES) expect(undone[table], table).toEqual(before[table]);
  });

  it("keeps nothing for the owner's own save", async () => {
    const projectId = await createProject();
    const command = save(deliverable(projectId, crypto.randomUUID(), { steps: [step("a", "Draft")] }), null);
    await runWithActor(null, () => saveEntity(sql, command));
    expect(await savedImages(command.commandId)).toBeNull();
  });
});

describe("an agent's project review", () => {
  it("puts the earlier review time back when undone, and redo stamps it again", async () => {
    const projectId = await createProject();
    const before = (
      await sql<
        { last_reviewed_at: Date | null; version: number }[]
      >`SELECT last_reviewed_at, version FROM projects WHERE id=${projectId}`
    )[0]!;
    expect(before.last_reviewed_at).toBeNull();
    const commandId = crypto.randomUUID();
    await asAgent(() => confirmProjectWanted(sql, { commandId, projectId, expectedVersion: before.version }));
    const stamp = async () =>
      (await sql<{ last_reviewed_at: Date | null }[]>`SELECT last_reviewed_at FROM projects WHERE id=${projectId}`)[0]!
        .last_reviewed_at;
    expect(await stamp()).not.toBeNull();
    expect((await savedImages(commandId))!.map((row) => row.table)).toEqual(["projects"]);
    await asAgent(() => runRevertCommand(sql, revert(commandId, "undo")));
    expect(await stamp()).toBeNull();
    await asAgent(() => runRevertCommand(sql, revert(commandId, "redo")));
    expect(await stamp()).not.toBeNull();
  });

  it("refuses an undo after the project was edited, and keeps nothing for the owner", async () => {
    const projectId = await createProject();
    const commandId = crypto.randomUUID();
    await asAgent(() => confirmProjectWanted(sql, { commandId, projectId, expectedVersion: 1 }));
    await sql`UPDATE projects SET title='Renamed', version=version+1 WHERE id=${projectId}`;
    await expect(asAgent(() => runRevertCommand(sql, revert(commandId, "undo")))).rejects.toThrow(CommandConflictError);
    const own = crypto.randomUUID();
    await runWithActor(null, () => confirmProjectWanted(sql, { commandId: own, projectId, expectedVersion: 3 }));
    expect(await savedImages(own)).toBeNull();
  });
});
