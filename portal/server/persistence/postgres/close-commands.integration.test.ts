import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { CLOSED_TABLES, type CloseEntityCommand } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { closeEntity, previewClose } from "./close-commands";
import { CommandConflictError, CommandIdReusedError, InvalidCommandError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { runRevertCommand } from "./write-revert";

/**
 * Close and restore of one row, for each of the eight types, against a real database (archive-removals design
 * sections 2, 3; plan WP2a). The cases are a hand-typed list of (type, status, verb); `CLOSED_TABLES` is used only to
 * prove every table is among them. Self-contained `_test` database, the pattern of the other persistence suites.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.CLOSE_COMMANDS_TEST_DATABASE_NAME,
  "openrhen_close_commands"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("CLOSE_COMMANDS_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const asAgent = <T>(run: () => Promise<T>, agent = "claude") => runWithActor(agent, run);
const asConfirmedAgent = <T>(run: () => Promise<T>, agent = "claude") => runWithActor(agent, run, "owner");

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
  sql = postgres(testUrl.toString(), { max: 8, connect_timeout: 10, fetch_types: false, prepare: true });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, jobs, sessions, routine_steps, commitment_recurrence_rules, commitments, deliverables, actions, projects, outcomes, areas, condition_definitions, routine_presets, entity_prerequisites RESTART IDENTITY CASCADE"
  );
  userId = await ensureUser(sql);
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`;
  await sql`UPDATE user_preferences SET home_location_id = NULL WHERE user_id = ${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

// ---- seeding: direct inserts, so a row can be in any status ----

type Type = CloseEntityCommand["type"];

async function seedArea(status = "active"): Promise<string> {
  return (
    await sql<
      { id: string }[]
    >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},${status},0) RETURNING id`
  )[0]!.id;
}
async function seedOutcome(areaId?: string, status = "active"): Promise<string> {
  const area = areaId ?? (await seedArea());
  return (
    await sql<
      { id: string }[]
    >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area},'Outcome','Done',${status}) RETURNING id`
  )[0]!.id;
}
async function seedProject(outcomeId?: string, status = "active"): Promise<string> {
  const outcome = outcomeId ?? (await seedOutcome());
  return (
    await sql<
      { id: string }[]
    >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome},'Project',${status}) RETURNING id`
  )[0]!.id;
}
async function seedAction(projectId?: string, status = "planned"): Promise<string> {
  const project = projectId ?? (await seedProject());
  return (
    await sql<{ id: string }[]>`
      INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
      VALUES (${project},'Draft citations','one_off',${status},30,60,90,60,'medium',15,90) RETURNING id`
  )[0]!.id;
}
async function seedDeliverable(projectId?: string, status = "ready"): Promise<string> {
  const project = projectId ?? (await seedProject());
  return (
    await sql<
      { id: string }[]
    >`INSERT INTO deliverables (project_id,title,status) VALUES (${project},'Report',${status}) RETURNING id`
  )[0]!.id;
}
async function seedCommitment(status = "confirmed", projectId?: string): Promise<string> {
  return (
    await sql<{ id: string }[]>`
      INSERT INTO commitments (user_id,title,starts_at,ends_at,status,project_id)
      VALUES (${userId},'Dentist',now() + interval '3 days',now() + interval '3 days 1 hour',${status},${projectId ?? null}) RETURNING id`
  )[0]!.id;
}
async function seedPreset(status = "active"): Promise<string> {
  return (
    await sql<
      { id: string }[]
    >`INSERT INTO routine_presets (user_id,name,activity_name,status) VALUES (${userId},'Morning','Morning',${status}) RETURNING id`
  )[0]!.id;
}
async function seedCondition(status = "active", id = "office"): Promise<string> {
  await sql`INSERT INTO condition_definitions (user_id,id,name,kind,status) VALUES (${userId},${id},${"Place " + id},'location',${status})`;
  return id;
}

async function seed(type: Type, status: string): Promise<string> {
  switch (type) {
    case "area":
      return seedArea(status);
    case "outcome":
      return seedOutcome(undefined, status);
    case "project":
      return seedProject(undefined, status);
    case "action":
      return seedAction(undefined, status);
    case "deliverable":
      return seedDeliverable(undefined, status);
    case "commitment":
      return seedCommitment(status);
    case "routine_preset":
      return seedPreset(status);
    case "condition_definition":
      return seedCondition(status);
  }
}

const TABLE: Record<Type, string> = {
  area: "areas",
  outcome: "outcomes",
  project: "projects",
  action: "actions",
  deliverable: "deliverables",
  commitment: "commitments",
  routine_preset: "routine_presets",
  condition_definition: "condition_definitions"
};

interface Stored {
  status: string;
  version: number;
  closed_at: Date | null;
  closed_from_status: string | null;
  closed_by: string | null;
  closed_batch: string | null;
  closed_reason: string | null;
}
async function stored(type: Type, id: string): Promise<Stored> {
  const rows = await sql.unsafe<Stored[]>(
    `SELECT status::text AS status, version, closed_at, closed_from_status, closed_by, closed_batch, closed_reason FROM ${TABLE[type]} WHERE id = $1`,
    [id]
  );
  return rows[0]!;
}

const close = (type: Type, id: string, verb: "archive" | "cancel", extra: Partial<CloseEntityCommand> = {}) =>
  ({ type, id, verb, do: "close", ...extra }) as CloseEntityCommand;
const restore = (
  type: Type,
  id: string,
  verb: "archive" | "cancel",
  expectedVersion: number,
  extra: Partial<CloseEntityCommand> = {}
) => ({ type, id, verb, do: "restore", expectedVersion, ...extra }) as CloseEntityCommand;

const writeRows = async (commandId: string) =>
  sql<
    { entity_type: string; operation: string; evidence: Record<string, unknown> }[]
  >`SELECT entity_type, operation, evidence FROM write_rows WHERE write_id = ${commandId}`;

// ---- the matrix: every (type, status, verb) cell, typed by hand ----

const ALLOWED: [Type, string, "archive" | "cancel"][] = [
  ["area", "active", "archive"],
  ["area", "paused", "archive"],
  ["area", "done", "archive"],
  ["outcome", "active", "archive"],
  ["outcome", "active", "cancel"],
  ["outcome", "paused", "cancel"],
  ["outcome", "done", "archive"],
  ["project", "active", "archive"],
  ["project", "paused", "cancel"],
  ["project", "done", "archive"],
  ["action", "inbox", "cancel"],
  ["action", "planned", "cancel"],
  ["action", "active", "cancel"],
  ["action", "doing", "cancel"],
  ["action", "waiting", "cancel"],
  ["action", "blocked", "cancel"],
  ["action", "done", "archive"],
  ["deliverable", "needs_breakdown", "cancel"],
  ["deliverable", "ready", "cancel"],
  ["deliverable", "in_progress", "cancel"],
  ["deliverable", "under_review", "cancel"],
  ["deliverable", "awaiting_result", "cancel"],
  ["deliverable", "ready_to_complete", "cancel"],
  ["deliverable", "completed", "archive"],
  ["commitment", "confirmed", "cancel"],
  ["commitment", "tentative", "cancel"],
  ["routine_preset", "active", "archive"],
  ["condition_definition", "active", "archive"]
];

/** What a restore of each of the above lands on: the status it left, running ones made safe (plan D14). */
const RESTORED: Record<string, string> = {
  "action:doing": "planned",
  "action:active": "planned",
  "deliverable:in_progress": "ready"
};

const REFUSED: [Type, string, "archive" | "cancel", string][] = [
  ["area", "active", "cancel", "rhen_archive"],
  ["outcome", "done", "cancel", "rhen_archive"],
  ["project", "done", "cancel", "rhen_archive"],
  ["action", "doing", "archive", "rhen_cancel"],
  ["action", "done", "cancel", "rhen_archive"],
  ["deliverable", "ready", "archive", "rhen_cancel"],
  ["deliverable", "completed", "cancel", "rhen_archive"],
  ["commitment", "confirmed", "archive", "rhen_cancel"],
  ["routine_preset", "active", "cancel", "rhen_archive"],
  ["condition_definition", "active", "cancel", "rhen_archive"]
];

describe("closing and restoring one row of each type", () => {
  it("covers every closed table", () => {
    const tables = new Set(Object.values(TABLE));
    for (const table of Object.keys(CLOSED_TABLES)) expect(tables.has(table)).toBe(true);
  });

  it.each(ALLOWED)("%s %s: %s then restore, stamped by the person", async (type, status, verb) => {
    const id = await seed(type, status);
    const before = await stored(type, id);
    const closed = (await closeEntity(sql, close(type, id, verb))).closed;
    const expectedClosed = verb === "archive" ? "archived" : "cancelled";
    expect(closed).toMatchObject({
      type,
      id,
      do: "close",
      status: expectedClosed,
      version: before.version + 1,
      cascaded: [],
      skipped: []
    });
    expect(closed.batch).toMatch(/^[0-9a-f-]{36}$/);
    const row = await stored(type, id);
    expect(row).toMatchObject({
      status: expectedClosed,
      closed_from_status: status,
      closed_by: "person",
      closed_batch: closed.batch,
      version: before.version + 1
    });
    expect(row.closed_at).toBeInstanceOf(Date);
    expect(closed.restore).toEqual({
      tool: verb === "archive" ? "rhen_archive" : "rhen_cancel",
      arguments: { type, id, do: "restore", "expected-version": row.version }
    });

    const back = (await closeEntity(sql, restore(type, id, verb, row.version))).closed;
    const landed = RESTORED[`${type}:${status}`] ?? status;
    expect(back).toMatchObject({
      do: "restore",
      status: landed,
      restoredTo: landed,
      assumed: false,
      batch: null,
      restore: null,
      version: row.version + 1
    });
    expect(await stored(type, id)).toMatchObject({
      status: landed,
      closed_at: null,
      closed_from_status: null,
      closed_by: null,
      closed_batch: null,
      closed_reason: null,
      version: row.version + 1
    });
  });

  it.each(REFUSED)("%s %s refuses %s and names %s", async (type, status, verb, tool) => {
    const id = await seed(type, status);
    const error = await closeEntity(sql, close(type, id, verb)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidCommandError);
    expect((error as InvalidCommandError).nextCall?.tool).toBe(tool);
    expect(await stored(type, id)).toMatchObject({ status, closed_at: null });
  });

  it("refuses a row that does not exist and names the list that shows the real ids", async () => {
    const error = await closeEntity(sql, close("project", crypto.randomUUID(), "cancel")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidCommandError);
    expect((error as InvalidCommandError).nextCall).toMatchObject({
      tool: "rhen_list",
      arguments: { entity: "projects" }
    });
  });

  it("does not reach another user's row", async () => {
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    const area = (
      await sql<
        { id: string }[]
      >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${other},'Theirs','active',0) RETURNING id`
    )[0]!.id;
    await expect(closeEntity(sql, close("area", area, "archive"))).rejects.toBeInstanceOf(InvalidCommandError);
    expect(await stored("area", area)).toMatchObject({ status: "active" });
  });

  it("refuses a close of a closed row, naming the restore call, and a different command id changes nothing", async () => {
    const id = await seed("commitment", "confirmed");
    await closeEntity(sql, close("commitment", id, "cancel"));
    const row = await stored("commitment", id);
    for (const verb of ["cancel", "archive"] as const) {
      const error = await closeEntity(sql, close("commitment", id, verb, { commandId: crypto.randomUUID() })).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(InvalidCommandError);
      expect((error as InvalidCommandError).nextCall).toMatchObject({
        tool: "rhen_cancel",
        arguments: { type: "commitment", id, do: "restore", "expected-version": row.version }
      });
    }
    expect(await stored("commitment", id)).toEqual(row);
  });

  it("refuses a restore of a row that is not closed", async () => {
    const id = await seed("action", "planned");
    const error = await closeEntity(sql, restore("action", id, "cancel", 1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidCommandError);
  });

  it("answers a stale expected version with the version it has now", async () => {
    const id = await seed("project", "active");
    const row = await stored("project", id);
    const error = await closeEntity(sql, close("project", id, "archive", { expectedVersion: row.version + 5 })).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(CommandConflictError);
    expect((error as CommandConflictError).currentVersion).toBe(row.version);
    await closeEntity(sql, close("project", id, "archive", { expectedVersion: row.version }));
    const stale = await closeEntity(sql, restore("project", id, "archive", row.version)).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(CommandConflictError);
    expect((stale as CommandConflictError).currentVersion).toBe(row.version + 1);
  });

  it("restores through the tool that matches the row's state, and otherwise names the other tool's call", async () => {
    const id = await seed("area", "active");
    await closeEntity(sql, close("area", id, "archive"));
    const row = await stored("area", id);
    const error = await closeEntity(sql, restore("area", id, "cancel", row.version)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidCommandError);
    expect((error as InvalidCommandError).nextCall).toMatchObject({
      tool: "rhen_archive",
      arguments: { type: "area", id, do: "restore", "expected-version": row.version }
    });
    expect(await stored("area", id)).toMatchObject({ status: "archived" });
  });

  it("restores a legacy cancelled area with the cancel tool, to the table default (its origin is unknown)", async () => {
    const id = await seedArea("cancelled");
    const row = await stored("area", id);
    expect(row.closed_from_status).toBeNull();
    const result = (await closeEntity(sql, restore("area", id, "cancel", row.version))).closed;
    expect(result).toMatchObject({ status: "active", restoredTo: "active", assumed: true });
  });

  it("restores a legacy action with no recorded origin to planned and says so", async () => {
    const id = await seedAction(undefined, "cancelled");
    const row = await stored("action", id);
    const result = (await closeEntity(sql, restore("action", id, "cancel", row.version))).closed;
    expect(result).toMatchObject({ status: "planned", assumed: true });
  });
});

describe("who closed it", () => {
  it("stamps the agent, and requires a reason from an agent but not from the person", async () => {
    const id = await seed("commitment", "confirmed");
    const missing = await asAgent(() => closeEntity(sql, close("commitment", id, "cancel"))).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(InvalidCommandError);
    expect((missing as InvalidCommandError).message).toContain("reason");
    expect((missing as InvalidCommandError).nextCall?.arguments).toMatchObject({ type: "commitment", id, do: "close" });
    expect(await stored("commitment", id)).toMatchObject({ status: "confirmed" });
    const blank = await asAgent(() => closeEntity(sql, close("commitment", id, "cancel", { reason: "   " }))).catch(
      (e: unknown) => e
    );
    expect(blank).toBeInstanceOf(InvalidCommandError);

    await asAgent(() => closeEntity(sql, close("commitment", id, "cancel", { reason: "Dentist rang to cancel" })));
    expect(await stored("commitment", id)).toMatchObject({
      status: "cancelled",
      closed_by: "agent:claude",
      closed_reason: "Dentist rang to cancel"
    });

    const person = await seed("commitment", "tentative");
    await closeEntity(sql, close("commitment", person, "cancel"));
    expect(await stored("commitment", person)).toMatchObject({ closed_by: "person", closed_reason: null });
  });

  it("stamps an owner-confirmed replay as the agent's confirmed close and needs no reason", async () => {
    const id = await seed("action", "planned");
    await asConfirmedAgent(() => closeEntity(sql, close("action", id, "cancel")));
    expect(await stored("action", id)).toMatchObject({ closed_by: "agent:claude:confirmed" });
  });

  it("never stamps system: the trigger's fallback is for writes this command did not make", async () => {
    const id = await seed("project", "active");
    await closeEntity(sql, close("project", id, "archive"));
    const row = await stored("project", id);
    expect(row.closed_by).not.toBe("system");
    const direct = await seedProject();
    await sql`UPDATE projects SET status='archived' WHERE id=${direct}`;
    expect((await stored("project", direct)).closed_by).toBe("system");
  });

  it("does not leak the actor into the next transaction on the same connection", async () => {
    const one = await seed("area", "active");
    await asAgent(() => closeEntity(sql, close("area", one, "archive", { reason: "retired" })));
    const direct = await seedArea();
    await sql`UPDATE areas SET status='archived' WHERE id=${direct}`;
    expect((await stored("area", direct)).closed_by).toBe("system");
  });
});

describe("restore rules", () => {
  it("refuses to restore under a closed ancestor and names the topmost closed one's restore call", async () => {
    const area = await seedArea();
    const outcome = await seedOutcome(area);
    const project = await seedProject(outcome);
    const action = await seedAction(project, "planned");
    await closeEntity(sql, close("action", action, "cancel"));
    await closeEntity(sql, close("project", project, "archive"));
    await closeEntity(sql, close("outcome", outcome, "archive"));
    await closeEntity(sql, close("area", area, "archive"));
    const actionRow = await stored("action", action);
    const error = await closeEntity(sql, restore("action", action, "cancel", actionRow.version)).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(InvalidCommandError);
    const areaRow = await stored("area", area);
    expect((error as InvalidCommandError).nextCall).toMatchObject({
      tool: "rhen_archive",
      arguments: { type: "area", id: area, do: "restore", "expected-version": areaRow.version }
    });
    expect(await stored("action", action)).toMatchObject({ status: "cancelled" });
    // restored top down, each step names the next one
    await closeEntity(sql, restore("area", area, "archive", areaRow.version));
    const second = await closeEntity(sql, restore("action", action, "cancel", actionRow.version)).catch(
      (e: unknown) => e
    );
    expect((second as InvalidCommandError).nextCall).toMatchObject({
      arguments: { type: "outcome", id: outcome, do: "restore" }
    });
    await closeEntity(sql, restore("outcome", outcome, "archive", (await stored("outcome", outcome)).version));
    const next = await closeEntity(sql, restore("action", action, "cancel", actionRow.version)).catch(
      (e: unknown) => e
    );
    expect((next as InvalidCommandError).nextCall).toMatchObject({
      arguments: { type: "project", id: project, do: "restore" }
    });
    await closeEntity(sql, restore("project", project, "archive", (await stored("project", project)).version));
    await closeEntity(sql, restore("action", action, "cancel", actionRow.version));
    expect(await stored("action", action)).toMatchObject({ status: "planned" });
  });

  it("restores a commitment under a closed project only after the project", async () => {
    const project = await seedProject();
    const commitment = await seedCommitment("confirmed", project);
    await closeEntity(sql, close("commitment", commitment, "cancel"));
    await closeEntity(sql, close("project", project, "archive"));
    const row = await stored("commitment", commitment);
    const error = await closeEntity(sql, restore("commitment", commitment, "cancel", row.version)).catch(
      (e: unknown) => e
    );
    expect((error as InvalidCommandError).nextCall).toMatchObject({ arguments: { type: "project", id: project } });
  });

  it("restores a project that was archived with a fresh pace baseline, as reactivating it by save does", async () => {
    const id = await seedProject();
    await sql`UPDATE projects SET forecast_started_at=now(), baseline_estimate_minutes=120 WHERE id=${id}`;
    await closeEntity(sql, close("project", id, "archive"));
    const row = await stored("project", id);
    await closeEntity(sql, restore("project", id, "archive", row.version));
    const after = (
      await sql<
        { forecast_started_at: Date | null; baseline_estimate_minutes: number | null }[]
      >`SELECT forecast_started_at, baseline_estimate_minutes FROM projects WHERE id=${id}`
    )[0]!;
    expect(after).toEqual({ forecast_started_at: null, baseline_estimate_minutes: null });
  });

  it("restores a cancelled project's pace baseline untouched (only an archived one starts over)", async () => {
    const id = await seedProject();
    await sql`UPDATE projects SET baseline_estimate_minutes=120 WHERE id=${id}`;
    await closeEntity(sql, close("project", id, "cancel"));
    await closeEntity(sql, restore("project", id, "cancel", (await stored("project", id)).version));
    const after = (
      await sql<
        { baseline_estimate_minutes: number | null }[]
      >`SELECT baseline_estimate_minutes FROM projects WHERE id=${id}`
    )[0]!;
    expect(after.baseline_estimate_minutes).toBe(120);
  });
});

describe("rules that block a close", () => {
  it("refuses while a session is open on an action, a deliverable or a commitment, naming the finish call", async () => {
    const action = await seedAction();
    const deliverable = await seedDeliverable();
    const commitment = await seedCommitment();
    const session = async (targetType: string, targetId: string, actionId: string | null = null) =>
      sql`INSERT INTO sessions (user_id,action_id,target_type,target_id,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
          VALUES (${userId},${actionId},${targetType},${targetId},'running',now(),now() + interval '30 minutes',now(),30,60)`;
    await session("action", action, action);
    const onAction = await closeEntity(sql, close("action", action, "cancel")).catch((e: unknown) => e);
    expect((onAction as InvalidCommandError).nextCall?.tool).toBe("rhen_session");
    await sql`UPDATE sessions SET status='completed', ended_at=now()`;

    await session("deliverable", deliverable);
    const onDeliverable = await closeEntity(sql, close("deliverable", deliverable, "cancel")).catch((e: unknown) => e);
    expect((onDeliverable as InvalidCommandError).nextCall?.tool).toBe("rhen_activity");
    await sql`UPDATE sessions SET status='completed', ended_at=now()`;

    await session("fixed_commitment", commitment);
    const onCommitment = await closeEntity(sql, close("commitment", commitment, "cancel")).catch((e: unknown) => e);
    expect(onCommitment).toBeInstanceOf(InvalidCommandError);
    for (const [type, id] of [
      ["action", action],
      ["deliverable", deliverable]
    ] as const)
      expect(await stored(type, id)).toMatchObject({ closed_at: null });
    expect(await stored("commitment", commitment)).toMatchObject({ status: "confirmed" });

    // once the session has ended the close goes through
    await sql`UPDATE sessions SET status='completed', ended_at=now()`;
    await closeEntity(sql, close("commitment", commitment, "cancel"));
    expect(await stored("commitment", commitment)).toMatchObject({ status: "cancelled" });
  });

  it("refuses to archive the owner's home location and allows another place", async () => {
    const home = await seedCondition("active", "home");
    const office = await seedCondition("active", "office");
    await sql`UPDATE user_preferences SET home_location_id=${home} WHERE user_id=${userId}`;
    const error = await closeEntity(sql, close("condition_definition", home, "archive")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidCommandError);
    expect((error as InvalidCommandError).message).toContain("home location");
    await closeEntity(sql, close("condition_definition", office, "archive"));
    const rows = await sql<
      { status: string; closed_by: string }[]
    >`SELECT status, closed_by FROM condition_definitions WHERE id='office'`;
    expect(rows[0]).toEqual({ status: "archived", closed_by: "person" });
  });

  it("refuses to close a parent that still has open children, counting only open ones, and names the retry call", async () => {
    const project = await seedProject();
    const open = await seedAction(project, "planned");
    await seedAction(project, "done");
    await sql`UPDATE actions SET deadline_at = now() + interval '9 days' WHERE id=${open}`;
    await seedDeliverable(project, "completed");
    const row = await stored("project", project);
    const error = await closeEntity(sql, close("project", project, "archive")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidCommandError);
    expect((error as InvalidCommandError).message).toContain("1 open");
    expect((error as InvalidCommandError).nextCall).toMatchObject({
      tool: "rhen_archive",
      arguments: {
        type: "project",
        id: project,
        do: "close",
        "expected-version": row.version,
        "include-children": true
      }
    });
    expect(await stored("project", project)).toMatchObject({ status: "active" });
    // done children do not block
    await sql`UPDATE actions SET status='done'`;
    await closeEntity(sql, close("project", project, "archive"));
    expect(await stored("project", project)).toMatchObject({ status: "archived" });
  });

  it("does not count a deliverable's steps as the project's children", async () => {
    const project = await seedProject();
    const deliverable = await seedDeliverable(project, "completed");
    const step = await seedAction(project, "planned");
    await sql`UPDATE actions SET deliverable_id=${deliverable}, required=true WHERE id=${step}`;
    await closeEntity(sql, close("project", project, "archive"));
    expect(await stored("project", project)).toMatchObject({ status: "archived" });
  });
});

describe("the receipt, the ledger and the result", () => {
  it("applies once under the same command id: one batch, one version bump, one ledger row", async () => {
    const id = await seed("project", "active");
    const commandId = crypto.randomUUID();
    const first = (await closeEntity(sql, close("project", id, "archive", { commandId }))).closed;
    const again = (await closeEntity(sql, close("project", id, "archive", { commandId }))).closed;
    const row = await stored("project", id);
    expect(row.version).toBe(first.version);
    expect(row.closed_batch).toBe(first.batch);
    expect(await writeRows(commandId)).toHaveLength(1);
    // the retry still carries the restore call (plan D21)
    expect(again).toMatchObject({
      batch: first.batch,
      status: "archived",
      version: first.version,
      restore: first.restore
    });
  });

  it("refuses the same command id for a different close", async () => {
    const a = await seed("project", "active");
    const b = await seed("project", "active");
    const commandId = crypto.randomUUID();
    await closeEntity(sql, close("project", a, "archive", { commandId }));
    await expect(closeEntity(sql, close("project", b, "archive", { commandId }))).rejects.toBeInstanceOf(
      CommandIdReusedError
    );
  });

  it("records exactly one ledger row per command, with the batch and the cascade in its evidence", async () => {
    const id = await seed("action", "doing");
    const commandId = crypto.randomUUID();
    const result = (
      await asAgent(() => closeEntity(sql, close("action", id, "cancel", { commandId, reason: "dropped" })))
    ).closed;
    const rows = await writeRows(commandId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: "action", operation: "close" });
    expect(rows[0]!.evidence).toMatchObject({
      batch: result.batch,
      verb: "cancel",
      cascade: [],
      before: { id, status: "doing", closed_at: null, closed_by: null, closed_from_status: null }
    });
    const restoreId = crypto.randomUUID();
    await asAgent(() => closeEntity(sql, restore("action", id, "cancel", result.version, { commandId: restoreId })));
    const restored = await writeRows(restoreId);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ operation: "restore" });
    expect(restored[0]!.evidence).toMatchObject({
      before: {
        status: "cancelled",
        closed_by: "agent:claude",
        closed_from_status: "doing",
        closed_batch: result.batch
      }
    });
  });

  it("enqueues the plan recalculation once", async () => {
    const id = await seed("action", "planned");
    await sql`DELETE FROM jobs`;
    await closeEntity(sql, close("action", id, "cancel"));
    const jobs = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM jobs`;
    expect(jobs[0]!.count).toBe("1");
  });

  it("lists the open rows that still wait on a cancelled one, and nothing on an archive", async () => {
    const project = await seedProject();
    const first = await seedAction(project, "planned");
    const waiting = await seedAction(project, "planned");
    const finished = await seedAction(project, "done");
    await sql`INSERT INTO action_dependencies (action_id, depends_on_action_id) VALUES (${waiting}, ${first}), (${finished}, ${first})`;
    const cancelled = (await closeEntity(sql, close("action", first, "cancel"))).closed;
    expect(cancelled.dependents).toHaveLength(1);
    expect(cancelled.dependents[0]).toMatchObject({ type: "action", id: waiting, title: "Draft citations" });
    expect(cancelled.dependents[0]!.call.tool).toBe("rhen_show");
    const done = await seedAction(project, "done");
    const dependent = await seedAction(project, "planned");
    await sql`INSERT INTO action_dependencies (action_id, depends_on_action_id) VALUES (${dependent}, ${done})`;
    expect((await closeEntity(sql, close("action", done, "archive"))).closed.dependents).toEqual([]);
  });
});

describe("undo and redo through the write snapshot", () => {
  it("undoes an agent's close and redoes it, with the closed columns round-tripping", async () => {
    const id = await seed("project", "active");
    const commandId = crypto.randomUUID();
    await asAgent(() => closeEntity(sql, close("project", id, "cancel", { commandId, reason: "abandoned" })));
    const closedRow = await stored("project", id);
    expect(closedRow).toMatchObject({ status: "cancelled", closed_by: "agent:claude", closed_reason: "abandoned" });

    await asAgent(() =>
      runRevertCommand(sql, { commandId: crypto.randomUUID(), target: commandId, direction: "undo" })
    );
    expect(await stored("project", id)).toMatchObject({
      status: "active",
      closed_at: null,
      closed_by: null,
      closed_batch: null
    });

    await asAgent(() =>
      runRevertCommand(sql, { commandId: crypto.randomUUID(), target: commandId, direction: "redo" })
    );
    const redone = await stored("project", id);
    expect(redone).toMatchObject({
      status: "cancelled",
      closed_by: "agent:claude",
      closed_reason: "abandoned",
      closed_batch: closedRow.closed_batch
    });
    expect(redone.closed_from_status).toBe("active");
  });

  it("undoes an agent's restore back to the closed state", async () => {
    const id = await seed("deliverable", "under_review");
    await closeEntity(sql, close("deliverable", id, "cancel"));
    const row = await stored("deliverable", id);
    const commandId = crypto.randomUUID();
    await asAgent(() => closeEntity(sql, restore("deliverable", id, "cancel", row.version, { commandId })));
    expect(await stored("deliverable", id)).toMatchObject({ status: "under_review", closed_at: null });
    await asAgent(() =>
      runRevertCommand(sql, { commandId: crypto.randomUUID(), target: commandId, direction: "undo" })
    );
    expect(await stored("deliverable", id)).toMatchObject({
      status: "cancelled",
      closed_from_status: "under_review",
      closed_by: "person",
      closed_batch: row.closed_batch
    });
  });

  it("keeps no snapshot for a person's close: row locks only", async () => {
    const id = await seed("area", "active");
    const commandId = crypto.randomUUID();
    await closeEntity(sql, close("area", id, "archive", { commandId }));
    const images = await sql<{ images: unknown }[]>`SELECT images FROM writes WHERE id=${commandId}`;
    expect(images[0]!.images).toBeNull();
    const agentCommand = crypto.randomUUID();
    const other = await seed("area", "active");
    await asAgent(() =>
      closeEntity(sql, close("area", other, "archive", { commandId: agentCommand, reason: "retired" }))
    );
    const kept = await sql<
      { images: { table: string }[] | null }[]
    >`SELECT images FROM writes WHERE id=${agentCommand}`;
    expect(kept[0]!.images?.map((image) => image.table)).toEqual(["areas"]);
  });
});

describe("two connections racing", () => {
  it("never leaves an open child under a closed parent: restore of a child against close of its parent", async () => {
    for (let round = 0; round < 6; round += 1) {
      const project = await seedProject();
      const action = await seedAction(project, "planned");
      await closeEntity(sql, close("action", action, "cancel"));
      const actionRow = await stored("action", action);
      const results = await Promise.allSettled([
        closeEntity(sql, restore("action", action, "cancel", actionRow.version)),
        closeEntity(sql, close("project", project, "archive"))
      ]);
      expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      const [projectRow, child] = [await stored("project", project), await stored("action", action)];
      const childOpen = child.status !== "cancelled" && child.status !== "archived";
      expect(projectRow.status === "archived" && childOpen, `round ${round}`).toBe(false);
    }
  });

  it("applies one of two concurrent closes of the same row and refuses the other", async () => {
    const id = await seed("commitment", "confirmed");
    const results = await Promise.allSettled([
      closeEntity(sql, close("commitment", id, "cancel", { commandId: crypto.randomUUID() })),
      closeEntity(sql, close("commitment", id, "cancel", { commandId: crypto.randomUUID() }))
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await stored("commitment", id)).version).toBe(2);
  });
});

// ---- WP2b: include-children ----

async function seedStep(commitmentId: string, status = "pending", sequence = 1): Promise<string> {
  return (
    await sql<{ id: string }[]>`
      INSERT INTO routine_steps (user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,max_lead_minutes,status)
      VALUES (${userId},${commitmentId},'commitment',${commitmentId},'Pack bag',10,${sequence},'flexible',60,${status}) RETURNING id`
  )[0]!.id;
}

describe("include-children", () => {
  async function tree() {
    const area = await seedArea();
    const outcome = await seedOutcome(area);
    const project = await seedProject(outcome);
    const a1 = await seedAction(project, "planned");
    const a2 = await seedAction(project, "doing");
    const done = await seedAction(project, "done");
    const deliverable = await seedDeliverable(project, "ready");
    const step = await seedAction(project, "planned");
    await sql`UPDATE actions SET deliverable_id=${deliverable}, required=true WHERE id=${step}`;
    return { area, outcome, project, a1, a2, done, deliverable, step };
  }

  it("closes a project with its open children in one batch, with the parent's reason, leaving done work and steps alone", async () => {
    const t = await tree();
    const result = (
      await closeEntity(sql, close("project", t.project, "archive", { includeChildren: true, reason: "wrapped up" }))
    ).closed;
    const batch = result.batch;
    expect(result.cascaded.map((row) => `${row.type}:${row.from}`).sort()).toEqual([
      "action:doing",
      "action:planned",
      "deliverable:ready"
    ]);
    for (const row of result.cascaded) expect(row.version).toBeGreaterThan(1);
    expect(await stored("project", t.project)).toMatchObject({ status: "archived", closed_batch: batch });
    for (const id of [t.a1, t.a2])
      expect(await stored("action", id)).toMatchObject({
        status: "cancelled",
        closed_batch: batch,
        closed_reason: "wrapped up",
        closed_by: "person"
      });
    expect(await stored("deliverable", t.deliverable)).toMatchObject({ status: "cancelled", closed_batch: batch });
    expect(await stored("action", t.done)).toMatchObject({ status: "done", closed_at: null });
    expect(await stored("action", t.step)).toMatchObject({ status: "planned", closed_at: null });
    expect(result.stepsLeft).toBe(1);
  });

  it("closes an area down through outcomes, projects and their work", async () => {
    const t = await tree();
    const result = (await closeEntity(sql, close("area", t.area, "archive", { includeChildren: true }))).closed;
    const types = result.cascaded.map((row) => row.type);
    expect(types).toContain("outcome");
    expect(types).toContain("project");
    expect(await stored("outcome", t.outcome)).toMatchObject({ status: "archived", closed_batch: result.batch });
    expect(await stored("project", t.project)).toMatchObject({ status: "archived" });
    expect(await stored("action", t.a1)).toMatchObject({ status: "cancelled" });
    // the project keeps its parent's verb where its own rules allow it, an open action is always cancelled
    expect((await stored("outcome", t.outcome)).closed_from_status).toBe("active");
  });

  it("records one ledger row whose evidence lists every child with its status before and version after", async () => {
    const t = await tree();
    const commandId = crypto.randomUUID();
    const result = (await closeEntity(sql, close("project", t.project, "cancel", { includeChildren: true, commandId })))
      .closed;
    const rows = await writeRows(commandId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.evidence.cascade).toEqual(result.cascaded);
    expect(result.cascaded).toHaveLength(3);
  });

  it("lets an agent close children that need no owner, and refuses (naming the same call) when one does", async () => {
    const t = await tree();
    await sql`UPDATE actions SET deadline_at = now() + interval '5 days' WHERE id=${t.a1}`;
    const refused = await asAgent(() =>
      closeEntity(sql, close("project", t.project, "archive", { includeChildren: true, reason: "done with it" }))
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CommandConflictError);
    expect((refused as CommandConflictError).nextCall).toMatchObject({
      tool: "rhen_archive",
      arguments: { type: "project", id: t.project, do: "close", "include-children": true }
    });
    expect(await stored("project", t.project)).toMatchObject({ status: "active" });
    // the person, and the owner confirming the agent's proposal, close it with the deadlined child
    await asConfirmedAgent(() => closeEntity(sql, close("project", t.project, "archive", { includeChildren: true })));
    expect(await stored("action", t.a1)).toMatchObject({ status: "cancelled", closed_by: "agent:claude:confirmed" });
  });

  it("treats a pathway, or prep for a shared commitment, as needing the owner", async () => {
    const t = await tree();
    await sql`INSERT INTO action_requirement_pathways (action_id) VALUES (${t.a1})`;
    const pathway = await previewClose(sql, close("project", t.project, "archive", { includeChildren: true }));
    expect(pathway.needsOwner).toBe(true);
    await sql`DELETE FROM action_requirement_pathways`;
    expect(
      (await previewClose(sql, close("project", t.project, "archive", { includeChildren: true }))).needsOwner
    ).toBe(false);
    const shared = await seedCommitment();
    await sql`UPDATE commitments SET share_to_calendar=true WHERE id=${shared}`;
    await sql`UPDATE actions SET prep_for_commitment_id=${shared} WHERE id=${t.a2}`;
    expect(
      (await previewClose(sql, close("project", t.project, "archive", { includeChildren: true }))).needsOwner
    ).toBe(true);
  });

  it("previews the whole call for the route: types touched, row count with the parent, owner and shared facts", async () => {
    const t = await tree();
    await sql`UPDATE actions SET deadline_at = now() + interval '5 days' WHERE id=${t.a1}`;
    const preview = await previewClose(sql, close("area", t.area, "archive", { includeChildren: true }));
    expect(preview).toMatchObject({ found: true, needsOwner: true, shared: false, rowCount: 1 + 1 + 1 + 2 + 1 });
    expect([...preview.closeTypes].sort()).toEqual(["action", "area", "deliverable", "outcome", "project"]);
    expect(preview.children.map((c) => c.type).sort()).toEqual([
      "action",
      "action",
      "deliverable",
      "outcome",
      "project"
    ]);
    const missing = await previewClose(sql, close("area", crypto.randomUUID(), "archive"));
    expect(missing.found).toBe(false);
  });

  it("refuses a close whose live children differ from the proposal's stored list", async () => {
    const t = await tree();
    const stale = [{ type: "action", id: t.a1, version: 99 }];
    const error = await closeEntity(sql, close("project", t.project, "archive", { includeChildren: true }), {
      expectedChildren: stale
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandConflictError);
    expect(await stored("project", t.project)).toMatchObject({ status: "active" });
  });

  it("blocks when a child has a session open", async () => {
    const t = await tree();
    await sql`INSERT INTO sessions (user_id,action_id,target_type,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
      VALUES (${userId},${t.a2},'action','running',now(),now() + interval '30 minutes',now(),30,60)`;
    const error = await closeEntity(sql, close("project", t.project, "archive", { includeChildren: true })).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(InvalidCommandError);
    expect(await stored("action", t.a1)).toMatchObject({ status: "planned" });
  });

  it("restores only the batch's rows that are still closed and unchanged, listing the rest with their restore calls", async () => {
    const t = await tree();
    const closed = (await closeEntity(sql, close("project", t.project, "archive", { includeChildren: true }))).closed;
    // the person edits one child after the close, and restores another by hand
    await sql`UPDATE actions SET title='Edited later', version=version+1 WHERE id=${t.a1}`;
    await sql`UPDATE deliverables SET status='ready', version=version+1 WHERE id=${t.deliverable}`;
    const projectVersion = (await stored("project", t.project)).version;
    const result = (
      await closeEntity(sql, restore("project", t.project, "archive", projectVersion, { includeChildren: true }))
    ).closed;
    expect(result.cascaded.map((row) => row.id)).toEqual([t.a2]);
    expect(await stored("action", t.a2)).toMatchObject({ status: "planned", closed_at: null });
    expect(await stored("action", t.a1)).toMatchObject({ status: "cancelled" });
    expect(result.skipped.map((row) => row.id).sort()).toEqual([t.a1, t.deliverable].sort());
    const edited = result.skipped.find((row) => row.id === t.a1)!;
    expect(edited.call).toMatchObject({
      tool: "rhen_cancel",
      arguments: { type: "action", id: t.a1, do: "restore", "expected-version": (await stored("action", t.a1)).version }
    });
    expect(closed.batch).not.toBeNull();
  });

  it("restores children only when asked: without the flag they stay closed", async () => {
    const t = await tree();
    await closeEntity(sql, close("project", t.project, "archive", { includeChildren: true }));
    await closeEntity(sql, restore("project", t.project, "archive", (await stored("project", t.project)).version));
    expect(await stored("project", t.project)).toMatchObject({ status: "active" });
    expect(await stored("action", t.a1)).toMatchObject({ status: "cancelled" });
  });

  it("does not reopen a child under a project that stays closed", async () => {
    const t = await tree();
    await closeEntity(sql, close("area", t.area, "archive", { includeChildren: true }));
    await sql`UPDATE projects SET title='Renamed', version=version+1 WHERE id=${t.project}`;
    const areaRow = await stored("area", t.area);
    const result = (
      await closeEntity(sql, restore("area", t.area, "archive", areaRow.version, { includeChildren: true }))
    ).closed;
    expect(await stored("outcome", t.outcome)).toMatchObject({ status: "active" });
    expect(await stored("project", t.project)).toMatchObject({ status: "archived" });
    expect(await stored("action", t.a1)).toMatchObject({ status: "cancelled" });
    expect(result.skipped.map((row) => row.id)).toContain(t.project);
    expect(result.skipped.map((row) => row.id)).toContain(t.a1);
  });

  it("undoes an agent's project close with children, reopening all of them, and redoes it", async () => {
    const t = await tree();
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      closeEntity(sql, close("project", t.project, "archive", { includeChildren: true, reason: "tidy", commandId }))
    );
    await asAgent(() =>
      runRevertCommand(sql, { commandId: crypto.randomUUID(), target: commandId, direction: "undo" })
    );
    expect(await stored("project", t.project)).toMatchObject({ status: "active", closed_at: null });
    expect(await stored("action", t.a1)).toMatchObject({ status: "planned", closed_at: null });
    expect(await stored("action", t.a2)).toMatchObject({ status: "doing", closed_at: null });
    expect(await stored("deliverable", t.deliverable)).toMatchObject({ status: "ready", closed_at: null });
    await asAgent(() =>
      runRevertCommand(sql, { commandId: crypto.randomUUID(), target: commandId, direction: "redo" })
    );
    expect(await stored("action", t.a2)).toMatchObject({ status: "cancelled", closed_by: "agent:claude" });
  });
});

// ---- WP2c: commitment cancel cascade ----

describe("cancelling a commitment", () => {
  async function commitmentWithPrep() {
    const project = await seedProject();
    const otherProject = await seedProject();
    const commitment = await seedCommitment("confirmed", project);
    const pending = await seedStep(commitment, "pending", 1);
    const blocked = await seedStep(commitment, "blocked", 2);
    const skippedStep = await seedStep(commitment, "skipped", 3);
    const prep = await seedAction(project, "planned");
    const dated = await seedAction(project, "planned");
    const elsewhere = await seedAction(otherProject, "planned");
    const linked = await seedAction(project, "planned");
    const follower = await seedAction(project, "planned");
    for (const id of [prep, dated, elsewhere, linked])
      await sql`UPDATE actions SET prep_for_commitment_id=${commitment} WHERE id=${id}`;
    await sql`UPDATE actions SET deadline_at = now() + interval '2 days' WHERE id=${dated}`;
    await sql`INSERT INTO action_dependencies (action_id, depends_on_action_id) VALUES (${follower}, ${linked})`;
    return { project, commitment, pending, blocked, skippedStep, prep, dated, elsewhere, linked, follower };
  }
  const stepRow = async (id: string) =>
    (await sql<{ status: string; version: number }[]>`SELECT status, version FROM routine_steps WHERE id=${id}`)[0]!;

  it("cancels pending and blocked steps and the prep actions in one batch, skipping and listing the rest", async () => {
    const c = await commitmentWithPrep();
    const result = (await closeEntity(sql, close("commitment", c.commitment, "cancel"))).closed;
    expect((await stepRow(c.pending)).status).toBe("cancelled");
    expect((await stepRow(c.blocked)).status).toBe("cancelled");
    expect((await stepRow(c.skippedStep)).status).toBe("skipped");
    expect(await stored("action", c.prep)).toMatchObject({
      status: "cancelled",
      closed_batch: result.batch,
      closed_by: "person"
    });
    for (const id of [c.dated, c.elsewhere, c.linked])
      expect(await stored("action", id)).toMatchObject({ status: "planned", closed_at: null });
    expect(result.cascaded.map((row) => `${row.type}:${row.from}`).sort()).toEqual([
      "action:planned",
      "routine_step:blocked",
      "routine_step:pending"
    ]);
    const why = Object.fromEntries(result.skipped.map((row) => [row.id, row.reason]));
    expect(why[c.dated]).toContain("deadline");
    expect(why[c.elsewhere]).toContain("project");
    expect(why[c.linked]).toContain("link");
    expect(result.skipped).toHaveLength(3);
  });

  it("refuses a commitment whose preparation has started", async () => {
    for (const status of ["doing", "completed"]) {
      const commitment = await seedCommitment();
      await seedStep(commitment, status);
      const error = await closeEntity(sql, close("commitment", commitment, "cancel")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidCommandError);
      expect(await stored("commitment", commitment)).toMatchObject({ status: "confirmed" });
    }
  });

  it("blocks on an open session on a prep action", async () => {
    const c = await commitmentWithPrep();
    await sql`INSERT INTO sessions (user_id,action_id,target_type,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
      VALUES (${userId},${c.prep},'action','running',now(),now() + interval '30 minutes',now(),30,60)`;
    const error = await closeEntity(sql, close("commitment", c.commitment, "cancel")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidCommandError);
    expect((await stepRow(c.pending)).status).toBe("pending");
  });

  it("never applies a shared commitment for an agent directly; the person and the confirmed replay can", async () => {
    const c = await commitmentWithPrep();
    await sql`UPDATE commitments SET share_to_calendar=true WHERE id=${c.commitment}`;
    const preview = await previewClose(sql, close("commitment", c.commitment, "cancel"));
    expect(preview).toMatchObject({ shared: true, rowCount: 1 + 2 + 1 });
    expect([...preview.closeTypes].sort()).toEqual(["action", "commitment", "routine_step"]);
    const error = await asAgent(() =>
      closeEntity(sql, close("commitment", c.commitment, "cancel", { reason: "cancelled" }))
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandConflictError);
    expect((error as CommandConflictError).nextCall?.arguments).toMatchObject({ type: "commitment", id: c.commitment });
    await asConfirmedAgent(() => closeEntity(sql, close("commitment", c.commitment, "cancel")));
    expect(await stored("commitment", c.commitment)).toMatchObject({ status: "cancelled" });
  });

  it("restores exactly the batch rows still at their recorded version", async () => {
    const c = await commitmentWithPrep();
    await closeEntity(sql, close("commitment", c.commitment, "cancel"));
    // the person un-cancels one step by hand and edits the other afterwards
    await sql`UPDATE routine_steps SET title='Pack the big bag', version=version+1 WHERE id=${c.blocked}`;
    const row = await stored("commitment", c.commitment);
    const result = (await closeEntity(sql, restore("commitment", c.commitment, "cancel", row.version))).closed;
    expect((await stepRow(c.pending)).status).toBe("pending");
    expect((await stepRow(c.blocked)).status).toBe("cancelled");
    expect((await stepRow(c.skippedStep)).status).toBe("skipped");
    expect(await stored("action", c.prep)).toMatchObject({ status: "planned", closed_at: null });
    expect(result.cascaded.map((r) => r.id).sort()).toEqual([c.pending, c.prep].sort());
    expect(result.skipped.map((r) => r.id)).toEqual([c.blocked]);
    expect(result.skipped[0]!.call).toBeNull();
  });

  it("does not reopen a prep action that was edited after the cancel", async () => {
    const c = await commitmentWithPrep();
    await closeEntity(sql, close("commitment", c.commitment, "cancel"));
    await sql`UPDATE actions SET title='Changed', version=version+1 WHERE id=${c.prep}`;
    const row = await stored("commitment", c.commitment);
    const result = (await closeEntity(sql, restore("commitment", c.commitment, "cancel", row.version))).closed;
    expect(await stored("action", c.prep)).toMatchObject({ status: "cancelled" });
    expect(result.skipped.map((r) => r.id)).toContain(c.prep);
  });

  it("undoes an agent's cancel, putting the steps and the prep action back", async () => {
    const c = await commitmentWithPrep();
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      closeEntity(sql, close("commitment", c.commitment, "cancel", { commandId, reason: "rang to cancel" }))
    );
    expect((await stepRow(c.pending)).status).toBe("cancelled");
    await asAgent(() =>
      runRevertCommand(sql, { commandId: crypto.randomUUID(), target: commandId, direction: "undo" })
    );
    expect((await stepRow(c.pending)).status).toBe("pending");
    expect((await stepRow(c.blocked)).status).toBe("blocked");
    expect(await stored("action", c.prep)).toMatchObject({ status: "planned", closed_at: null });
    expect(await stored("commitment", c.commitment)).toMatchObject({ status: "confirmed" });
  });

  it("records the single ledger row with the cascade, and a replay returns it", async () => {
    const c = await commitmentWithPrep();
    const commandId = crypto.randomUUID();
    const first = (await closeEntity(sql, close("commitment", c.commitment, "cancel", { commandId }))).closed;
    expect(await writeRows(commandId)).toHaveLength(1);
    const again = (await closeEntity(sql, close("commitment", c.commitment, "cancel", { commandId }))).closed;
    expect(again.cascaded).toEqual(first.cascaded);
    expect(again.skipped).toEqual(first.skipped);
  });
});
