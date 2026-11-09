import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanningEntityCommand, RevertCommand, SaveActionCommand } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { CommandConflictError, ForbiddenCommandError } from "./command-errors";
import { stableUuid } from "./command-values";
import { ensureUser } from "./ensure-user";
import { saveEntity } from "./entity-commands";
import { saveAction, saveProject } from "./project-commands";
import { recordCadenceCompletion, saveCommitmentRecurrenceRule } from "./recurrence-commands";
import { persistDerivedState } from "@openrhen/database";
import { runRevertCommand } from "./write-revert";

const FIXTURE_0131 = fileURLToPath(new URL("./write-image-renames-0131.sql", import.meta.url));
const MIGRATION_0131 = resolve(process.cwd(), "../platform/database/drizzle/0131_rename_captures_commitments.sql");
const dataStatements = (text: string) =>
  text.split("--> statement-breakpoint").filter((part) => /^\s*(--[^\n]*\n\s*)*UPDATE /.test(part));

/**
 * Every agent write to plan data keeps row images and undoes through the server revert (the design notes,
 * "Undo after"): an update puts the whole before-row back (a field the write added goes), a recurrence rule, a cadence
 * completion and a sleep-log entry undo and redo, an agent undoing its own create deletes it outright, and a row edited
 * since refuses. Self-contained `_test` database, the pattern of `session-commands-snapshot.integration.test.ts`.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.AGENT_WRITE_SNAPSHOT_TEST_DATABASE_NAME,
  "openrhen_agent_write_snapshot"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("AGENT_WRITE_SNAPSHOT_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const asAgent = <T>(run: () => Promise<T>, agent = "claude") => runWithActor(agent, run);
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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
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

async function createAction(projectId: string, mode: "one_off" | "cadence" = "one_off"): Promise<string> {
  const action = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${projectId},'Draft citations',${mode},'active',30,60,90,60,'medium',15,90) RETURNING id`;
  if (mode === "cadence")
    await sql`INSERT INTO action_recurrence_rules (action_id,timezone,start_date,interval_days,completion_mode)
      VALUES (${action[0]!.id},'Australia/Sydney','2020-01-01',1,'manual')`;
  return action[0]!.id;
}

/** A row as `to_jsonb` gives it, without the columns a write and its undo always move. */
async function image(table: string, where: string, ...params: string[]): Promise<Record<string, unknown> | null> {
  const rows = await sql.unsafe<{ image: Record<string, unknown> }[]>(
    `SELECT to_jsonb(t) - 'version' - 'updated_at' AS image FROM ${table} t WHERE ${where}`,
    params
  );
  return rows[0]?.image ?? null;
}

const savedImages = async (commandId: string) =>
  (await sql<{ images: { table: string }[] | null }[]>`SELECT images FROM writes WHERE id=${commandId}`)[0]!.images;

function actionCommand(id: string, projectId: string, version: number, patch: Partial<SaveActionCommand["action"]>) {
  return {
    commandId: crypto.randomUUID(),
    expectedVersion: version,
    action: {
      id,
      projectId,
      title: "Draft citations",
      status: "active",
      optimisticMinutes: 30,
      expectedMinutes: 60,
      pessimisticMinutes: 90,
      remainingMinutes: 60,
      energy: "medium",
      minimumSessionMinutes: 15,
      maximumSessionMinutes: 90,
      splittable: true,
      setupMinutes: 0,
      importance: 3,
      consequence: 3,
      contexts: [],
      dependencyIds: [],
      ...patch
    }
  } as SaveActionCommand;
}

describe("an update puts the whole before-row back", () => {
  it("removes what the write added: notes, a requirement route and a preference, nulls included", async () => {
    const projectId = await createProject();
    const id = await createAction(projectId);
    const before = await image("actions", "id = $1", id);
    expect(before!.notes).toBeNull();

    const command = actionCommand(id, projectId, 1, {
      notes: "Cite the 2024 report",
      requirementPathways: [["home"]],
      preferences: ["quiet"]
    });
    await asAgent(() => saveAction(sql, command));
    expect((await image("actions", "id = $1", id))!.notes).toBe("Cite the 2024 report");
    expect((await savedImages(command.commandId!))!.map((row) => row.table)).toEqual(
      expect.arrayContaining(["actions", "action_requirement_pathways", "action_requirements", "action_preferences"])
    );

    await asAgent(() => runRevertCommand(sql, revert(command.commandId!, "undo")));
    expect(await image("actions", "id = $1", id)).toEqual(before);
    expect(await sql`SELECT 1 FROM action_requirement_pathways WHERE action_id=${id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM action_preferences WHERE action_id=${id}`).toHaveLength(0);

    await asAgent(() => runRevertCommand(sql, revert(command.commandId!, "redo")));
    expect((await image("actions", "id = $1", id))!.notes).toBe("Cite the 2024 report");
    expect(await sql`SELECT 1 FROM action_requirement_pathways WHERE action_id=${id}`).toHaveLength(1);
  });

  it("refuses when the row was edited after the write, and changes nothing", async () => {
    const projectId = await createProject();
    const id = await createAction(projectId);
    const command = actionCommand(id, projectId, 1, { notes: "Agent note" });
    await asAgent(() => saveAction(sql, command));
    await sql`UPDATE actions SET notes = 'Edited by the owner', version = version + 1 WHERE id = ${id}`;
    await expect(asAgent(() => runRevertCommand(sql, revert(command.commandId!, "undo")))).rejects.toThrow(
      CommandConflictError
    );
    expect((await image("actions", "id = $1", id))!.notes).toBe("Edited by the owner");
  });

  it("undoes after a consequence refit touched the row, and keeps the refit's values", async () => {
    const projectId = await createProject();
    const id = await createAction(projectId);
    const command = actionCommand(id, projectId, 1, { notes: "Agent note" });
    await asAgent(() => saveAction(sql, command));
    // A refit is the system's, like the planner's replan: it moves the three refined columns on both tables. It is
    // dated the user's local today: an earlier day is stale, and the undo's recalculation would refit it away.
    const today = (
      await sql<{ today: string }[]>`
      SELECT to_char((now() AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS today FROM users WHERE id = ${userId}`
    )[0]!.today;
    for (const table of ["actions", "projects"])
      await sql.unsafe(
        `UPDATE ${table} SET consequence_refined = 4.5, consequence_refined_for_stars = 3, consequence_refined_as_of = $2::date WHERE id = $1`,
        [table === "actions" ? id : projectId, today]
      );
    await asAgent(() => runRevertCommand(sql, revert(command.commandId!, "undo")));
    const row = (await image("actions", "id = $1", id))!;
    expect(row.notes).toBeNull();
    expect(row).toMatchObject({
      consequence_refined: 4.5,
      consequence_refined_for_stars: 3,
      consequence_refined_as_of: today
    });
  });

  it("keeps nothing for the owner's own save", async () => {
    const projectId = await createProject();
    const id = await createAction(projectId);
    const command = actionCommand(id, projectId, 1, { notes: "Mine" });
    await runWithActor(null, () => saveAction(sql, command));
    expect(await savedImages(command.commandId!)).toBeNull();
  });
});

describe("recurrence, cadence and sleep-log writes", () => {
  it("undoes and redoes a recurring commitment rule", async () => {
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      saveCommitmentRecurrenceRule(sql, {
        commandId,
        expectedVersion: null,
        rule: {
          id: "college-class",
          title: "College Class",
          timezone: "Australia/Sydney",
          startDate: "2026-09-01",
          repeat: { unit: "days", intervalDays: 7 },
          localStartTime: "08:00",
          localEndTime: "16:00",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      })
    );
    expect(await sql`SELECT 1 FROM commitment_recurrence_rules`).toHaveLength(1);
    await asAgent(() => runRevertCommand(sql, revert(commandId, "undo")));
    expect(await sql`SELECT 1 FROM commitment_recurrence_rules`).toHaveLength(0);
    await asAgent(() => runRevertCommand(sql, revert(commandId, "redo")));
    expect(await sql`SELECT 1 FROM commitment_recurrence_rules`).toHaveLength(1);
  });

  it("undoes and redoes a cadence completion", async () => {
    const projectId = await createProject();
    const id = await createAction(projectId, "cadence");
    await sql`UPDATE actions SET remaining_minutes = 5 WHERE id = ${id}`;
    const before = await image("actions", "id = $1", id);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      recordCadenceCompletion(sql, {
        commandId,
        expectedVersion: null,
        type: "record_cadence_completion",
        actionId: id,
        minutes: 20
      })
    );
    expect(await sql`SELECT 1 FROM action_cadence_completions WHERE action_id=${id}`).toHaveLength(1);
    expect((await image("actions", "id = $1", id))!.remaining_minutes).toBe(60);

    await asAgent(() => runRevertCommand(sql, revert(commandId, "undo")));
    expect(await sql`SELECT 1 FROM action_cadence_completions WHERE action_id=${id}`).toHaveLength(0);
    expect(await image("actions", "id = $1", id)).toEqual(before);

    await asAgent(() => runRevertCommand(sql, revert(commandId, "redo")));
    expect(await sql`SELECT 1 FROM action_cadence_completions WHERE action_id=${id}`).toHaveLength(1);
  });

  it("puts a dropped cadence rule back with the completions it took with it", async () => {
    const projectId = await createProject();
    const id = await createAction(projectId, "cadence");
    await sql`INSERT INTO action_cadence_completions (action_id,rule_id,completed_at,local_date,minutes)
      SELECT ${id}, r.id, now(), '2026-10-01', 25 FROM action_recurrence_rules r WHERE r.action_id = ${id}`;
    const version = (await sql<{ version: number }[]>`SELECT version FROM actions WHERE id=${id}`)[0]!.version;
    const command = actionCommand(id, projectId, version, { schedulingMode: "one_off" });
    await asAgent(() => saveAction(sql, command));
    expect(await sql`SELECT 1 FROM action_recurrence_rules WHERE action_id=${id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM action_cadence_completions WHERE action_id=${id}`).toHaveLength(0);

    await asAgent(() => runRevertCommand(sql, revert(command.commandId!, "undo")));
    expect(await sql`SELECT 1 FROM action_recurrence_rules WHERE action_id=${id}`).toHaveLength(1);
    expect(await sql`SELECT minutes FROM action_cadence_completions WHERE action_id=${id}`).toEqual([{ minutes: 25 }]);
  });

  it("undoes and redoes a hand-logged night, last wake included", async () => {
    const wake = new Date(Date.now() - 3_600_000);
    const sleepAt = new Date(wake.getTime() - 8 * 3_600_000);
    const prefsBefore = await image("user_preferences", "user_id = $1", userId);
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "sleep_log_entry",
      entity: { sleepAt: sleepAt.toISOString(), wakeAt: wake.toISOString() }
    } as PlanningEntityCommand;
    await asAgent(() => saveEntity(sql, command));
    expect(await sql`SELECT 1 FROM sleep_plans WHERE status='completed'`).toHaveLength(1);
    expect((await image("user_preferences", "user_id = $1", userId))!.last_woke_at).not.toBeNull();

    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")));
    expect(await sql`SELECT 1 FROM sleep_plans`).toHaveLength(0);
    expect(await image("user_preferences", "user_id = $1", userId)).toEqual(prefsBefore);

    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "redo")));
    expect(await sql`SELECT 1 FROM sleep_plans WHERE status='completed'`).toHaveLength(1);
  });
});

describe("an agent undoing its own create", () => {
  const spanCommand = (): PlanningEntityCommand =>
    ({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "span",
      entity: { id: "trip", title: "Trip", startDate: "2026-11-01", endDate: "2026-11-05" }
    }) as PlanningEntityCommand;

  it("deletes a span directly, files no proposal, and redo brings it back", async () => {
    const command = spanCommand();
    await asAgent(() => saveEntity(sql, command));
    expect(await sql`SELECT 1 FROM spans`).toHaveLength(1);

    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")));
    expect(await sql`SELECT 1 FROM spans`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM captures`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM agent_proposals`).toHaveLength(0);

    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "redo")));
    expect(await sql`SELECT 1 FROM spans`).toHaveLength(1);
  });

  it("keeps another agent out of it, and refuses once the span was edited", async () => {
    const command = spanCommand();
    await asAgent(() => saveEntity(sql, command), "claude");
    await expect(asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")), "hermes")).rejects.toThrow(
      ForbiddenCommandError
    );
    expect(await sql`SELECT 1 FROM spans`).toHaveLength(1);

    await sql`UPDATE spans SET title = 'Edited', version = version + 1`;
    await expect(asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")), "claude")).rejects.toThrow(
      CommandConflictError
    );
    expect(await sql`SELECT 1 FROM spans`).toHaveLength(1);
  });

  it("an owner may undo it, and the refusal an agent gets names the owner, never --force", async () => {
    const command = spanCommand();
    await asAgent(() => saveEntity(sql, command));
    await sql`UPDATE spans SET title = 'Edited', version = version + 1`;
    const error = await asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo"))).catch((e) => e);
    expect(error.message).toContain("Review > Agent changes");
    expect(error.message).not.toContain("--force");
    await runWithActor(null, () => runRevertCommand(sql, revert(command.commandId, "undo", true)));
    expect(await sql`SELECT 1 FROM spans`).toHaveLength(0);
  });
});

describe("the other entity saves", () => {
  const entityCommand = (entityType: string, entity: Record<string, unknown>): PlanningEntityCommand =>
    ({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType,
      entity
    }) as PlanningEntityCommand;

  it("undoes and redoes a settings change (when the person woke), nulls included", async () => {
    const before = await image("user_preferences", "user_id = $1", userId);
    const wake = new Date(Date.now() - 3_600_000).toISOString();
    const version = (await sql<{ version: number }[]>`SELECT version FROM user_preferences WHERE user_id=${userId}`)[0]!
      .version;
    const command = {
      ...entityCommand("settings", { lastWokeAt: wake }),
      expectedVersion: version
    } as PlanningEntityCommand;
    await asAgent(() => saveEntity(sql, command));
    expect((await image("user_preferences", "user_id = $1", userId))!.last_woke_at).not.toBeNull();
    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")));
    // The horizon is the planner's, moved by every write (SYSTEM_COLUMNS): undo neither compares nor restores it.
    const undone = (await image("user_preferences", "user_id = $1", userId))!;
    expect({ ...undone, current_horizon_end_at: null }).toEqual({ ...before, current_horizon_end_at: null });
    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "redo")));
    expect((await image("user_preferences", "user_id = $1", userId))!.last_woke_at).not.toBeNull();
  });

  it("undoes a focus period with its projects, and a day plan with its wins", async () => {
    const projectId = await createProject();
    const actionId = await createAction(projectId);
    const focus = entityCommand("planning_focus", {
      kind: "weekly",
      periodStart: "2026-11-02",
      periodEnd: "2026-11-08",
      projectIds: [projectId]
    });
    await asAgent(() => saveEntity(sql, focus));
    expect(await sql`SELECT 1 FROM planning_focus_projects`).toHaveLength(1);
    await asAgent(() => runRevertCommand(sql, revert(focus.commandId, "undo")));
    expect(await sql`SELECT 1 FROM planning_focus_periods`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM planning_focus_projects`).toHaveLength(0);
    await asAgent(() => runRevertCommand(sql, revert(focus.commandId, "redo")));
    expect(await sql`SELECT 1 FROM planning_focus_projects`).toHaveLength(1);

    const plan = entityCommand("daily_plan", { localDate: "2026-11-03", desiredActionIds: [actionId] });
    await asAgent(() => saveEntity(sql, plan));
    expect(await sql`SELECT 1 FROM daily_plan_desired_actions`).toHaveLength(1);
    await asAgent(() => runRevertCommand(sql, revert(plan.commandId, "undo")));
    expect(await sql`SELECT 1 FROM daily_plans`).toHaveLength(0);
  });

  it("undoes a new capture", async () => {
    const capture = entityCommand("capture", { id: "cap-1", status: "pending", text: "Ring the plumber" });
    await asAgent(() => saveEntity(sql, capture));
    expect(await sql`SELECT 1 FROM captures`).toHaveLength(1);
    await asAgent(() => runRevertCommand(sql, revert(capture.commandId, "undo")));
    expect(await sql`SELECT 1 FROM captures`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM sources`).toHaveLength(0);
  });
});

describe("an undo restores the whole row, including what the planner usually owns", () => {
  const entityCommand = (
    entityType: string,
    entity: Record<string, unknown>,
    expectedVersion: number | null = null
  ): PlanningEntityCommand =>
    ({
      commandId: crypto.randomUUID(),
      expectedVersion,
      type: "save_entity",
      entityType,
      entity
    }) as PlanningEntityCommand;

  it("puts a planned night back after a sleep-plan override moved its times", async () => {
    const id = await stableUuid(`sleep:${userId}`, "night-1");
    const start = new Date(Date.now() + 2 * 3_600_000);
    const wake = new Date(start.getTime() + 8 * 3_600_000);
    await sql`INSERT INTO sleep_plans (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,sleep_deficit_minutes,explanation,status,input_version)
      VALUES (${id},${userId},${start},${wake},480,480,0,'Calculated.','planned','abc123')`;
    const before = await image("sleep_plans", "id = $1", id);

    const newStart = new Date(start.getTime() + 3_600_000);
    const newWake = new Date(wake.getTime() + 3_600_000);
    const command = entityCommand(
      "sleep_plan",
      { id: "night-1", plannedStartAt: newStart.toISOString(), plannedWakeAt: newWake.toISOString() },
      1
    );
    await asAgent(() => saveEntity(sql, command));
    const overridden = await image("sleep_plans", "id = $1", id);
    expect(overridden!.input_version).toBe("override");
    expect(new Date(overridden!.planned_start_at as string).getTime()).toBe(newStart.getTime());

    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")));
    expect(await image("sleep_plans", "id = $1", id)).toEqual(before);

    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "redo")));
    expect(await image("sleep_plans", "id = $1", id)).toEqual(overridden);
  });

  it("puts the person's timezone back after a settings change", async () => {
    const before = await image("users", "id = $1", userId);
    const version = (await sql<{ version: number }[]>`SELECT version FROM user_preferences WHERE user_id=${userId}`)[0]!
      .version;
    const command = entityCommand("settings", { timezone: "Pacific/Auckland" }, version);
    await asAgent(() => saveEntity(sql, command));
    expect((await image("users", "id = $1", userId))!.timezone).toBe("Pacific/Auckland");
    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")));
    expect(await image("users", "id = $1", userId)).toEqual(before);
  });

  it("still undoes and redoes a settings write whose images predate the locale column", async () => {
    const before = await image("users", "id = $1", userId);
    const version = (await sql<{ version: number }[]>`SELECT version FROM user_preferences WHERE user_id=${userId}`)[0]!
      .version;
    const command = entityCommand("settings", { timezone: "Pacific/Auckland", locale: "en-NZ" }, version);
    await asAgent(() => saveEntity(sql, command));
    // An image taken before migration 0135 has no locale key: remove it from both sides of every stored image.
    await sql`
      UPDATE writes SET images = (
        SELECT jsonb_agg(jsonb_set(jsonb_set(r, '{before}', (r->'before') - 'locale'), '{after}', (r->'after') - 'locale'))
        FROM jsonb_array_elements(images) r
      ) WHERE id = ${command.commandId}`;
    // The live row now carries a locale the image does not; that must not read as a conflict.
    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")));
    expect((await image("users", "id = $1", userId))!.timezone).toBe(before!.timezone);
    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "redo")));
    expect((await image("users", "id = $1", userId))!.timezone).toBe("Pacific/Auckland");
  });

  it("puts a standalone commitment's presence and sharing back", async () => {
    const id = await stableUuid(`commitment:${userId}`, "dentist");
    await sql`INSERT INTO commitments (id,user_id,title,starts_at,ends_at) VALUES (${id},${userId},'Dentist',now() + interval '2 days',now() + interval '2 days 1 hour')`;
    const before = await image("commitments", "id = $1", id);
    expect(before).toMatchObject({ presence: "blocking", share_to_calendar: false });

    const command = entityCommand(
      "commitment",
      {
        id: "dentist",
        title: "Dentist",
        status: "confirmed",
        startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString(),
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        presence: "anchor",
        shareToCalendar: true
      },
      1
    );
    await asAgent(() => saveEntity(sql, command));
    const saved = await image("commitments", "id = $1", id);
    expect(saved).toMatchObject({ presence: "anchor", share_to_calendar: true, presence_source: "custom" });

    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")));
    expect(await image("commitments", "id = $1", id)).toEqual(before);

    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "redo")));
    expect(await image("commitments", "id = $1", id)).toEqual(saved);
  });

  // The OpenRhen baseline replaces the migration history, so the file may not exist; where it does, the fixture the next
  // test applies must be its data statements, statement for statement.
  it.runIf(existsSync(MIGRATION_0131))("keeps the 0131 fixture identical to the migration's data statements", () => {
    const clean = (text: string) =>
      dataStatements(text).map((statement) => statement.replace(/^(\s*--[^\n]*\n)+/, "").trim());
    expect(clean(readFileSync(FIXTURE_0131, "utf8"))).toEqual(clean(readFileSync(MIGRATION_0131, "utf8")));
  });

  it("undoes a commitment save written before migration 0131 renamed the tables", async () => {
    const id = await stableUuid(`commitment:${userId}`, "dentist");
    await sql`INSERT INTO commitments (id,user_id,title,starts_at,ends_at) VALUES (${id},${userId},'Dentist',now() + interval '2 days',now() + interval '2 days 1 hour')`;
    const before = await image("commitments", "id = $1", id);
    const command = entityCommand(
      "commitment",
      {
        id: "dentist",
        title: "Dentist",
        status: "confirmed",
        startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString(),
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        presence: "anchor"
      },
      1
    );
    await asAgent(() => saveEntity(sql, command));
    const saved = await image("commitments", "id = $1", id);

    // Put the write back the way the code before the rename stored it: its images name `fixed_commitments`.
    const stored = (await savedImages(command.commandId))!;
    expect(stored.map((row) => row.table)).toContain("commitments");
    const legacy = stored.map((row) => (row.table === "commitments" ? { ...row, table: "fixed_commitments" } : row));
    await sql`UPDATE writes SET images = ${sql.json(legacy as never)} WHERE id = ${command.commandId}`;
    await sql`UPDATE write_rows SET entity_type = 'fixed_commitments' WHERE write_id = ${command.commandId}`;

    // The data statements of 0131 (the renames above them are DDL the fresh test database already has).
    for (const statement of dataStatements(readFileSync(FIXTURE_0131, "utf8"))) await sql.unsafe(statement);

    expect((await savedImages(command.commandId))!.map((row) => row.table)).toEqual(stored.map((row) => row.table));
    expect(
      (
        await sql<{ entity_type: string }[]>`SELECT entity_type FROM write_rows WHERE write_id = ${command.commandId}`
      ).map((row) => row.entity_type)
    ).not.toContain("fixed_commitments");

    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")));
    expect(await image("commitments", "id = $1", id)).toEqual(before);
    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "redo")));
    expect(await image("commitments", "id = $1", id)).toEqual(saved);
  });

  it("puts back the occurrence and routine steps that ending a series closed, closing its safe prep action with it and leaving its links and dependencies as they were", async () => {
    const ruleCommand = {
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      rule: {
        id: "college-class",
        title: "College Class",
        timezone: "Australia/Sydney",
        startDate: "2026-09-01",
        repeat: { unit: "days", intervalDays: 7 },
        localStartTime: "08:00",
        localEndTime: "16:00",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    } as Parameters<typeof saveCommitmentRecurrenceRule>[1];
    await runWithActor(null, () => saveCommitmentRecurrenceRule(sql, ruleCommand));
    const ruleId = await stableUuid(`commitment-recurrence:${userId}`, "college-class");
    const [future, past] = await sql<{ id: string }[]>`
      INSERT INTO commitments (user_id,title,starts_at,ends_at,recurrence_rule_id,local_date)
      VALUES (${userId},'College Class',now() + interval '3 days',now() + interval '3 days 1 hour',${ruleId},current_date + 3),
             (${userId},'College Class',now() - interval '3 days',now() - interval '3 days' + interval '1 hour',${ruleId},current_date - 3)
      RETURNING id`;
    const futureId = future!.id;
    const pastId = past!.id;
    await sql`INSERT INTO calendar_event_links (user_id,provider,frame_id,external_event_id,commitment_id,profile_label,last_remote_hash)
      VALUES (${userId},'example_daily','frame','ext-1',${futureId},'Work','h1')`;
    const [step] = await sql<{ id: string }[]>`
      INSERT INTO routine_steps (user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule)
      VALUES (${userId},${futureId},${futureId},'Pack the bag',10,1,'contiguous') RETURNING id`;
    const [other] = await sql<{ id: string }[]>`
      INSERT INTO routine_steps (user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule)
      VALUES (${userId},${futureId},${futureId},'Leave',5,2,'contiguous') RETURNING id`;
    await sql`INSERT INTO routine_step_dependencies (step_id,depends_on_step_id) VALUES (${other!.id},${step!.id})`;
    const projectId = await createProject();
    const actionId = await createAction(projectId);
    await sql`UPDATE actions SET prep_for_commitment_id = ${futureId} WHERE id = ${actionId}`;

    const tables: [string, string, string[]][] = [
      ["commitments", "id = $1", [futureId]],
      ["calendar_event_links", "commitment_id = $1", [futureId]],
      ["routine_steps", "commitment_id = $1 AND title = 'Pack the bag'", [futureId]],
      ["routine_step_dependencies", "step_id = $1", [other!.id]],
      ["actions", "id = $1", [actionId]]
    ];
    const before = await Promise.all(tables.map(([table, where, params]) => image(table, where, ...params)));
    before.forEach((row) => expect(row).not.toBeNull());
    const pastBefore = await image("commitments", "id = $1", pastId);

    const rule = (
      await sql<{ version: number }[]>`SELECT version FROM commitment_recurrence_rules WHERE id=${ruleId}`
    )[0]!;
    const end = {
      ...ruleCommand,
      commandId: crypto.randomUUID(),
      expectedVersion: rule.version,
      rule: { ...ruleCommand.rule, status: "ended" }
    } as typeof ruleCommand;
    await asAgent(() => saveCommitmentRecurrenceRule(sql, end));
    // Ending closes the future date instead of deleting it: the row, its link, steps, dependencies and prep stay.
    expect(await image("commitments", "id = $1", futureId)).toMatchObject({
      status: "cancelled",
      closed_by: "agent:claude",
      closed_reason: "Recurrence ended"
    });
    expect(await sql`SELECT 1 FROM calendar_event_links`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM routine_steps WHERE status = 'cancelled'`).toHaveLength(2);
    expect(await sql`SELECT 1 FROM routine_step_dependencies`).toHaveLength(1);
    // The prep action that passes the safe rules closes with its date, and stays linked to it.
    expect(await image("actions", "id = $1", actionId)).toMatchObject({
      status: "cancelled",
      prep_for_commitment_id: futureId
    });

    await asAgent(() => runRevertCommand(sql, revert(end.commandId!, "undo")));
    const after = await Promise.all(tables.map(([table, where, params]) => image(table, where, ...params)));
    expect(after).toEqual(before);
    expect(await image("commitments", "id = $1", pastId)).toEqual(pastBefore);
    expect(await sql`SELECT 1 FROM routine_step_dependencies`).toHaveLength(1);

    await asAgent(() => runRevertCommand(sql, revert(end.commandId!, "redo")));
    expect(await image("commitments", "id = $1", futureId)).toMatchObject({ status: "cancelled" });
    expect(await sql`SELECT 1 FROM routine_steps WHERE status = 'cancelled'`).toHaveLength(2);
  });

  it("puts back a removed action window with its occurrences, completed ones included, and its linked steps", async () => {
    const projectId = await createProject();
    const window = (id: string, name: string, start: string, end: string) => ({
      id,
      name,
      anchor: "local_time" as const,
      localStartTime: start,
      localEndTime: end
    });
    const withWindows = (version: number, windows: ReturnType<typeof window>[]) =>
      actionCommand("take-meds", projectId, version, {
        title: "Take meds",
        schedulingMode: "recurring",
        recurrence: {
          id: "meds-rule",
          timezone: "Australia/Sydney",
          startDate: "2026-09-01",
          endDate: "2027-09-01",
          intervalDays: 1,
          completionMode: "end_date",
          windows
        }
      } as never);
    const setup = withWindows(0, [
      window("am", "Morning", "07:00", "09:00"),
      window("pm", "Evening", "19:00", "21:00")
    ]);
    setup.expectedVersion = null;
    await runWithActor(null, () => saveAction(sql, setup));
    const actionId = await stableUuid(`action:${userId}`, "take-meds");
    const ruleId = await stableUuid(`recurrence:${userId}:${actionId}`, "meds-rule");
    const amId = await stableUuid(`recurrence-window:${ruleId}`, "am");
    const pmId = await stableUuid(`recurrence-window:${ruleId}`, "pm");
    const occurrence = (id: string, windowId: string, status: string) => sql`
      INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source,status)
      VALUES (${id},${actionId},${ruleId},${windowId},current_date,now(),now() + interval '1 hour','local_time',${status})`;
    await occurrence("occ-am", amId, "pending");
    await occurrence("occ-pm-done", pmId, "completed");
    await occurrence("occ-pm-next", pmId, "pending");
    const [preset] = await sql<{ id: string }[]>`
      INSERT INTO routine_presets (user_id,name,activity_name) VALUES (${userId},'Evening','Evening') RETURNING id`;
    const [commitment] = await sql<{ id: string }[]>`
      INSERT INTO commitments (user_id,title,starts_at,ends_at) VALUES (${userId},'Evening out',now() + interval '1 day',now() + interval '1 day 1 hour') RETURNING id`;
    const [step] = await sql<{ id: string }[]>`
      INSERT INTO routine_steps (user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule,action_window_id)
      VALUES (${userId},${commitment!.id},${commitment!.id},'Meds',5,1,'contiguous',${pmId}) RETURNING id`;
    const [presetStep] = await sql<{ id: string }[]>`
      INSERT INTO routine_preset_steps (preset_id,title,duration_minutes,sequence,timing_rule,action_window_id)
      VALUES (${preset!.id},'Meds',5,1,'contiguous',${pmId}) RETURNING id`;

    const watched: [string, string, string[]][] = [
      ["action_recurrence_windows", "id = $1", [pmId]],
      ["action_occurrences", "id = 'occ-pm-done'", []],
      ["action_occurrences", "id = 'occ-pm-next'", []],
      ["routine_steps", "id = $1", [step!.id]],
      ["routine_preset_steps", "id = $1", [presetStep!.id]]
    ];
    const snapshot = () => Promise.all(watched.map(([table, where, params]) => image(table, where, ...params)));
    const before = await snapshot();
    const untouched = await image("action_occurrences", "id = 'occ-am'");
    expect(before.every((row) => row !== null)).toBe(true);

    const version = (await sql<{ version: number }[]>`SELECT version FROM actions WHERE id=${actionId}`)[0]!.version;
    const remove = withWindows(version, [window("am", "Morning", "07:00", "09:00")]);
    await asAgent(() => saveAction(sql, remove));
    expect(await sql`SELECT 1 FROM action_recurrence_windows WHERE id = ${pmId}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM action_occurrences WHERE window_id = ${pmId}`).toHaveLength(0);
    expect((await image("routine_steps", "id = $1", step!.id))!.action_window_id).toBeNull();

    await asAgent(() => runRevertCommand(sql, revert(remove.commandId!, "undo")));
    expect(await snapshot()).toEqual(before);
    expect(await image("action_occurrences", "id = 'occ-am'")).toEqual(untouched);
    expect((await image("action_occurrences", "id = 'occ-pm-done'"))!.status).toBe("completed");

    // Redoing removes the window again: the completed occurrence is history this snapshot holds, not newer work.
    await asAgent(() => runRevertCommand(sql, revert(remove.commandId!, "redo")));
    expect(await sql`SELECT 1 FROM action_recurrence_windows WHERE id = ${pmId}`).toHaveLength(0);
  });
});

describe("review follow-ups to undo", () => {
  const entityCommand = (
    entityType: string,
    entity: Record<string, unknown>,
    expectedVersion: number | null = null
  ): PlanningEntityCommand =>
    ({
      commandId: crypto.randomUUID(),
      expectedVersion,
      type: "save_entity",
      entityType,
      entity
    }) as PlanningEntityCommand;
  const versionOf = async (table: string, id: string) =>
    (await sql.unsafe<{ version: number }[]>(`SELECT version FROM ${table} WHERE id = $1`, [id]))[0]!.version;

  const seriesCommand = (): Parameters<typeof saveCommitmentRecurrenceRule>[1] =>
    ({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      rule: {
        id: "gym",
        title: "Gym",
        timezone: "Australia/Sydney",
        startDate: "2026-09-01",
        repeat: { unit: "days", intervalDays: 7 },
        localStartTime: "08:00",
        localEndTime: "09:00",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    }) as never;
  const occurrenceOf = async (ruleId: string, custom: boolean) =>
    sql`INSERT INTO commitments (user_id,title,starts_at,ends_at,recurrence_rule_id,local_date,schedule_source)
      VALUES (${userId},'Gym',now() + interval '2 days',now() + interval '2 days 1 hour',${ruleId},current_date + 2,${custom ? "custom" : "inherit"})`;

  it("refuses to undo a created series once an occurrence was edited by hand, and lets the owner force it", async () => {
    const command = seriesCommand();
    await asAgent(() => saveCommitmentRecurrenceRule(sql, command));
    const ruleId = await stableUuid(`commitment-recurrence:${userId}`, "gym");
    await occurrenceOf(ruleId, true);
    const error = await asAgent(() => runRevertCommand(sql, revert(command.commandId!, "undo"))).catch((e) => e);
    expect(error).toBeInstanceOf(CommandConflictError);
    expect(error.message).toContain("Review > Agent changes");
    expect(await sql`SELECT 1 FROM commitment_recurrence_rules`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM commitments`).toHaveLength(1);

    await runWithActor(null, () => runRevertCommand(sql, revert(command.commandId!, "undo", true)));
    expect(await sql`SELECT 1 FROM commitment_recurrence_rules`).toHaveLength(0);
  });

  it("undoes a created series after the planner skipped a step and cancelled an occurrence, but not after a step was completed", async () => {
    const command = seriesCommand();
    await asAgent(() => saveCommitmentRecurrenceRule(sql, command));
    const ruleId = await stableUuid(`commitment-recurrence:${userId}`, "gym");
    await occurrenceOf(ruleId, false);
    const [occurrence] = await sql<{ id: string }[]>`SELECT id FROM commitments WHERE recurrence_rule_id = ${ruleId}`;
    await sql`UPDATE commitments SET status = 'cancelled' WHERE id = ${occurrence!.id}`;
    const step = (status: string, completedAt: Date | null) => sql`
      INSERT INTO routine_steps (user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule,status,completed_at)
      VALUES (${userId},${occurrence!.id},${occurrence!.id},'Pack',5,1,'contiguous',${status},${completedAt})`;
    await step("skipped", null);
    const done = await sql<{ id: string }[]>`
      INSERT INTO routine_steps (user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule,status,completed_at)
      VALUES (${userId},${occurrence!.id},${occurrence!.id},'Leave',5,2,'contiguous','completed',now()) RETURNING id`;
    await expect(asAgent(() => runRevertCommand(sql, revert(command.commandId!, "undo")))).rejects.toThrow(
      CommandConflictError
    );
    await sql`DELETE FROM routine_steps WHERE id = ${done[0]!.id}`;
    await asAgent(() => runRevertCommand(sql, revert(command.commandId!, "undo")));
    expect(await sql`SELECT 1 FROM commitment_recurrence_rules`).toHaveLength(0);
  });

  it("undoes a created recurring action after a missed occurrence, but not after a completed one", async () => {
    const projectId = await createProject();
    const command = actionCommand("new-habit", projectId, 0, {
      title: "Stretch",
      schedulingMode: "recurring",
      recurrence: {
        id: "stretch-rule",
        timezone: "Australia/Sydney",
        startDate: "2026-09-01",
        endDate: "2027-09-01",
        intervalDays: 1,
        completionMode: "end_date",
        windows: [{ id: "am", name: "Morning", anchor: "local_time", localStartTime: "07:00", localEndTime: "09:00" }]
      }
    } as never);
    command.expectedVersion = null;
    await asAgent(() => saveAction(sql, command));
    const actionId = await stableUuid(`action:${userId}`, "new-habit");
    const ruleId = await stableUuid(`recurrence:${userId}:${actionId}`, "stretch-rule");
    const windowId = await stableUuid(`recurrence-window:${ruleId}`, "am");
    const occurrence = (id: string, status: string, completedAt: Date | null) => sql`
      INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source,status,completed_at)
      VALUES (${id},${actionId},${ruleId},${windowId},${id === "occ-1" ? "2026-10-01" : "2026-10-02"},now(),now() + interval '1 hour','local_time',${status},${completedAt})`;
    await occurrence("occ-1", "missed", null);
    await occurrence("occ-2", "completed", new Date());
    await expect(asAgent(() => runRevertCommand(sql, revert(command.commandId!, "undo")))).rejects.toThrow(
      CommandConflictError
    );
    await sql`DELETE FROM action_occurrences WHERE id = 'occ-2'`;
    await asAgent(() => runRevertCommand(sql, revert(command.commandId!, "undo")));
    expect(await sql`SELECT 1 FROM actions WHERE id = ${actionId}`).toHaveLength(0);
  });

  it("refuses an undo that would close a deliverable dependency cycle", async () => {
    const projectId = await createProject();
    const [d1, d2] = await sql<{ id: string }[]>`
      INSERT INTO deliverables (project_id,title) VALUES (${projectId},'One'),(${projectId},'Two') RETURNING id`;
    await sql`INSERT INTO deliverable_dependencies (deliverable_id,depends_on_deliverable_id) VALUES (${d2!.id},${d1!.id})`;
    // An agent write that had removed d1 -> d2, kept as a snapshot.
    const commandId = crypto.randomUUID();
    const edge = { deliverable_id: d1!.id, depends_on_deliverable_id: d2!.id };
    await sql`INSERT INTO writes (id,user_id,command_type,actor,kind,state,images)
      VALUES (${commandId},${userId},'save','claude','save','applied',${sql.json([
        { table: "deliverable_dependencies", id: JSON.stringify([d1!.id, d2!.id]), before: edge, after: null }
      ] as never)})`;
    const error = await asAgent(() => runRevertCommand(sql, revert(commandId, "undo"))).catch((e) => e);
    expect(error).toBeInstanceOf(CommandConflictError);
    expect(error.message).toContain("cycle");
    expect(await sql`SELECT 1 FROM deliverable_dependencies`).toHaveLength(1);
  });

  it("lets a created series go with occurrences nobody touched", async () => {
    const command = seriesCommand();
    await asAgent(() => saveCommitmentRecurrenceRule(sql, command));
    await occurrenceOf(await stableUuid(`commitment-recurrence:${userId}`, "gym"), false);
    await asAgent(() => runRevertCommand(sql, revert(command.commandId!, "undo")));
    expect(await sql`SELECT 1 FROM commitment_recurrence_rules`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM commitments`).toHaveLength(0);
  });

  it("undoes and redoes two agent saves to one record in turn", async () => {
    const projectId = await createProject();
    const id = await createAction(projectId);
    const original = await image("actions", "id = $1", id);
    const first = actionCommand(id, projectId, 1, { notes: "First" });
    await asAgent(() => saveAction(sql, first));
    const second = actionCommand(id, projectId, await versionOf("actions", id), { notes: "Second" });
    await asAgent(() => saveAction(sql, second));

    await asAgent(() => runRevertCommand(sql, revert(second.commandId!, "undo")));
    expect((await image("actions", "id = $1", id))!.notes).toBe("First");
    await asAgent(() => runRevertCommand(sql, revert(first.commandId!, "undo")));
    expect(await image("actions", "id = $1", id)).toEqual(original);

    await asAgent(() => runRevertCommand(sql, revert(first.commandId!, "redo")));
    expect((await image("actions", "id = $1", id))!.notes).toBe("First");
    await asAgent(() => runRevertCommand(sql, revert(second.commandId!, "redo")));
    expect((await image("actions", "id = $1", id))!.notes).toBe("Second");
  });

  it("refuses an undo that would close a dependency cycle, and changes nothing", async () => {
    const projectId = await createProject();
    const a = await createAction(projectId);
    const b = await createAction(projectId);
    await sql`INSERT INTO action_dependencies (action_id,depends_on_action_id) VALUES (${a},${b})`;
    const command = actionCommand(a, projectId, 1, { dependencyIds: [] });
    await asAgent(() => saveAction(sql, command));
    expect(await sql`SELECT 1 FROM action_dependencies`).toHaveLength(0);
    await sql`INSERT INTO action_dependencies (action_id,depends_on_action_id) VALUES (${b},${a})`;

    const error = await asAgent(() => runRevertCommand(sql, revert(command.commandId!, "undo"))).catch((e) => e);
    expect(error).toBeInstanceOf(CommandConflictError);
    expect(error.message).toContain("cycle");
    expect(await sql`SELECT 1 FROM action_dependencies`).toHaveLength(1);
    expect(await sql`SELECT state FROM writes WHERE id = ${command.commandId!}`).toEqual([{ state: "applied" }]);
  });

  it("redoes a sleep override after the planner redrew the night the undo gave back", async () => {
    const id = await stableUuid(`sleep:${userId}`, "night-2");
    const start = new Date(Date.now() + 2 * 3_600_000);
    const wake = new Date(start.getTime() + 8 * 3_600_000);
    await sql`INSERT INTO sleep_plans (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,sleep_deficit_minutes,explanation,status,input_version)
      VALUES (${id},${userId},${start},${wake},480,480,0,'Calculated.','planned','v1')`;
    const newStart = new Date(start.getTime() + 3_600_000);
    const command = entityCommand(
      "sleep_plan",
      {
        id: "night-2",
        plannedStartAt: newStart.toISOString(),
        plannedWakeAt: new Date(wake.getTime() + 3_600_000).toISOString()
      },
      1
    );
    await asAgent(() => saveEntity(sql, command));
    const overridden = await image("sleep_plans", "id = $1", id);

    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")));
    // The planner owns the night again and redraws it.
    await sql`UPDATE sleep_plans SET input_version='v2', planned_start_at=planned_start_at + interval '10 minutes', planned_wake_at=planned_wake_at + interval '10 minutes' WHERE id=${id}`;

    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "redo")));
    expect(await image("sleep_plans", "id = $1", id)).toEqual(overridden);
  });

  it("completing a step in a window the save moved it to closes that window's occurrence, and undo reopens it", async () => {
    const projectId = await createProject();
    const actionId = await createAction(projectId);
    // The step closes the occurrence on the person's local day, so the rule and the day follow their
    // stored zone. An earlier test in this file leaves it on Pacific/Auckland.
    const timezone = (await sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id=${userId}`)[0]!.timezone;
    const [rule] = await sql<{ id: string }[]>`
      INSERT INTO action_recurrence_rules (action_id,timezone,start_date,interval_days,completion_mode) VALUES (${actionId},${timezone},'2020-01-01',1,'manual') RETURNING id`;
    const [oldWindow, newWindow] = await sql<{ id: string }[]>`
      INSERT INTO action_recurrence_windows (rule_id,name,anchor,local_start_time,local_end_time)
      VALUES (${rule!.id},'Old','local_time','07:00','08:00'),(${rule!.id},'New','local_time','19:00','20:00') RETURNING id`;
    const [commitment] = await sql<{ id: string }[]>`
      INSERT INTO commitments (user_id,title,starts_at,ends_at) VALUES (${userId},'Out',now() + interval '1 hour',now() + interval '2 hours') RETURNING id`;
    const stepId = await stableUuid(`routine:${userId}`, "step-1");
    await sql`INSERT INTO routine_steps (id,user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule,action_window_id,scheduled_start_at)
      VALUES (${stepId},${userId},${commitment!.id},${commitment!.id},'Meds',5,1,'contiguous',${oldWindow!.id},now())`;
    const day = (await sql<{ d: string }[]>`SELECT to_char(now() AT TIME ZONE ${timezone},'YYYY-MM-DD') AS d`)[0]!.d;
    const occurrence = (id: string, windowId: string) => sql`
      INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source,status)
      VALUES (${id},${actionId},${rule!.id},${windowId},${day},now(),now() + interval '1 hour','local_time','pending')`;
    await occurrence("occ-old", oldWindow!.id);
    await occurrence("occ-new", newWindow!.id);
    const before = await image("action_occurrences", "id = 'occ-new'");

    const command = entityCommand(
      "routine_step",
      {
        id: "step-1",
        commitmentId: commitment!.id,
        title: "Meds",
        durationMinutes: 5,
        sequence: 1,
        timingRule: "contiguous",
        phase: "before",
        energy: "low",
        status: "completed",
        actionWindowId: newWindow!.id
      },
      await versionOf("routine_steps", stepId)
    );
    await asAgent(() => saveEntity(sql, command));
    expect((await image("action_occurrences", "id = 'occ-new'"))!.status).toBe("completed");
    expect((await image("action_occurrences", "id = 'occ-old'"))!.status).toBe("pending");

    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")));
    expect(await image("action_occurrences", "id = 'occ-new'")).toEqual(before);
  });

  it("puts back the steps an arrival skipped, the session it retitled and the trip it recorded", async () => {
    const place = (
      id: string,
      lat: number
    ) => sql`INSERT INTO condition_definitions (user_id,id,name,kind,latitude,longitude)
      VALUES (${userId},${id},${id},'location',${lat},151.2)`;
    await place("home-place", -33.87);
    await place("work-place", -33.88);
    const [commitment] = await sql<{ id: string }[]>`
      INSERT INTO commitments (user_id,title,starts_at,ends_at,location_id)
      VALUES (${userId},'Shift',now() - interval '5 minutes',now() + interval '2 hours','work-place') RETURNING id`;
    const [step] = await sql<{ id: string }[]>`
      INSERT INTO routine_steps (user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule,scheduled_start_at)
      VALUES (${userId},${commitment!.id},${commitment!.id},'Pack bag',5,1,'contiguous',now() - interval '30 minutes') RETURNING id`;
    const [session] = await sql<{ id: string }[]>`
      INSERT INTO sessions (user_id,status,started_at,planned_started_at,planned_end_at,planned_minutes,remaining_before_minutes,target_type,target_id,target_title)
      VALUES (${userId},'running',now() - interval '10 minutes',now() - interval '10 minutes',now() + interval '20 minutes',30,30,'fixed_commitment',${commitment!.id},'Preparing for Shift') RETURNING id`;
    const availability = async (locationId: string) => {
      const prefs = (
        await sql<{ version: number; current_energy: string; asserted_conditions: unknown }[]>`
          SELECT version,current_energy,asserted_conditions FROM user_preferences WHERE user_id=${userId}`
      )[0]!;
      return entityCommand(
        "current_availability",
        {
          currentEnergy: prefs.current_energy,
          assertedConditions: prefs.asserted_conditions,
          currentSituation: { locationId }
        },
        prefs.version
      );
    };
    await runWithActor(null, async () => saveEntity(sql, await availability("home-place")));
    await sql`UPDATE user_preferences SET current_situation = jsonb_set(current_situation, '{locationSetAt}', to_jsonb(to_char(now() at time zone 'utc' - interval '20 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))`;
    const before = await Promise.all([
      image("routine_steps", "id = $1", step!.id),
      image("sessions", "id = $1", session!.id)
    ]);

    const command = await availability("work-place");
    await asAgent(() => saveEntity(sql, command));
    expect((await image("routine_steps", "id = $1", step!.id))!.status).toBe("skipped");
    expect((await image("sessions", "id = $1", session!.id))!.target_title).toBe("Shift");
    expect(await sql`SELECT 1 FROM journey_samples WHERE source='own_trip'`).toHaveLength(1);

    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")));
    expect(
      await Promise.all([image("routine_steps", "id = $1", step!.id), image("sessions", "id = $1", session!.id)])
    ).toEqual(before);
    expect(await sql`SELECT 1 FROM journey_samples WHERE source='own_trip'`).toHaveLength(0);
  });
});

describe("the second review's undo guards", () => {
  const entityCommand = (
    entityType: string,
    entity: Record<string, unknown>,
    expectedVersion: number | null = null
  ): PlanningEntityCommand =>
    ({
      commandId: crypto.randomUUID(),
      expectedVersion,
      type: "save_entity",
      entityType,
      entity
    }) as PlanningEntityCommand;

  it("refuses to undo a created commitment once a routine step was ticked off by hand (status only)", async () => {
    const create = entityCommand("commitment", {
      id: "dentist",
      title: "Dentist",
      status: "confirmed",
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000 + 3_600_000).toISOString(),
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0
    });
    await asAgent(() => saveEntity(sql, create));
    const id = await stableUuid(`commitment:${userId}`, "dentist");
    const [step] = await sql<{ id: string }[]>`
      INSERT INTO routine_steps (user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule,status)
      VALUES (${userId},${id},${id},'Pack',5,1,'contiguous','completed') RETURNING id`;
    const error = await asAgent(() => runRevertCommand(sql, revert(create.commandId, "undo"))).catch((e) => e);
    expect(error).toBeInstanceOf(CommandConflictError);
    expect(error.message).toContain("Review > Agent changes");
    expect(await sql`SELECT 1 FROM commitments WHERE id = ${id}`).toHaveLength(1);
    await sql`DELETE FROM routine_steps WHERE id = ${step!.id}`;
    await asAgent(() => runRevertCommand(sql, revert(create.commandId, "undo")));
    expect(await sql`SELECT 1 FROM commitments WHERE id = ${id}`).toHaveLength(0);
  });

  it("refuses to undo a created series once a step was ticked off by status alone", async () => {
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      rule: {
        id: "run-club",
        title: "Run club",
        timezone: "Australia/Sydney",
        startDate: "2026-09-01",
        repeat: { unit: "days", intervalDays: 7 },
        localStartTime: "06:00",
        localEndTime: "07:00",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    } as Parameters<typeof saveCommitmentRecurrenceRule>[1];
    await asAgent(() => saveCommitmentRecurrenceRule(sql, command));
    const ruleId = await stableUuid(`commitment-recurrence:${userId}`, "run-club");
    const [occurrence] = await sql<{ id: string }[]>`
      INSERT INTO commitments (user_id,title,starts_at,ends_at,recurrence_rule_id,local_date)
      VALUES (${userId},'Run club',now() + interval '2 days',now() + interval '2 days 1 hour',${ruleId},current_date + 2) RETURNING id`;
    await sql`INSERT INTO routine_steps (user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule,status)
      VALUES (${userId},${occurrence!.id},${occurrence!.id},'Shoes',5,1,'contiguous','completed')`;
    await expect(asAgent(() => runRevertCommand(sql, revert(command.commandId!, "undo")))).rejects.toThrow(
      CommandConflictError
    );
    expect(await sql`SELECT 1 FROM commitment_recurrence_rules`).toHaveLength(1);
  });

  it("refuses to undo a window the save added once its occurrence was completed", async () => {
    const projectId = await createProject();
    const window = (id: string, start: string) => ({
      id,
      name: id,
      anchor: "local_time" as const,
      localStartTime: start,
      localEndTime: "23:00"
    });
    const withWindows = (version: number | null, windows: ReturnType<typeof window>[]) => {
      const command = actionCommand("habit", projectId, version ?? 0, {
        title: "Habit",
        schedulingMode: "recurring",
        recurrence: {
          id: "habit-rule",
          timezone: "Australia/Sydney",
          startDate: "2026-09-01",
          endDate: "2027-09-01",
          intervalDays: 1,
          completionMode: "end_date",
          windows
        }
      } as never);
      command.expectedVersion = version;
      return command;
    };
    await runWithActor(null, () => saveAction(sql, withWindows(null, [window("am", "07:00")])));
    const actionId = await stableUuid(`action:${userId}`, "habit");
    const ruleId = await stableUuid(`recurrence:${userId}:${actionId}`, "habit-rule");
    const version = (await sql<{ version: number }[]>`SELECT version FROM actions WHERE id=${actionId}`)[0]!.version;
    const add = withWindows(version, [window("am", "07:00"), window("pm", "19:00")]);
    await asAgent(() => saveAction(sql, add));
    const pmId = await stableUuid(`recurrence-window:${ruleId}`, "pm");
    await sql`INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source,status)
      VALUES ('pm-done',${actionId},${ruleId},${pmId},current_date,now(),now() + interval '1 hour','local_time','completed')`;
    await expect(asAgent(() => runRevertCommand(sql, revert(add.commandId!, "undo")))).rejects.toThrow(
      CommandConflictError
    );
    expect(await sql`SELECT 1 FROM action_recurrence_windows WHERE id = ${pmId}`).toHaveLength(1);
  });

  it("refuses to undo a created place that was since chosen as home", async () => {
    const create = entityCommand("condition_definition", {
      id: "cafe",
      name: "Cafe",
      kind: "location",
      latitude: -33.87,
      longitude: 151.2
    });
    await asAgent(() => saveEntity(sql, create));
    await sql`UPDATE user_preferences SET home_location_id = 'cafe' WHERE user_id = ${userId}`;
    await expect(asAgent(() => runRevertCommand(sql, revert(create.commandId, "undo")))).rejects.toThrow(
      CommandConflictError
    );
    expect(await sql`SELECT 1 FROM condition_definitions WHERE id = 'cafe'`).toHaveLength(1);
    await sql`UPDATE user_preferences SET home_location_id = NULL WHERE user_id = ${userId}`;
    await asAgent(() => runRevertCommand(sql, revert(create.commandId, "undo")));
    expect(await sql`SELECT 1 FROM condition_definitions WHERE id = 'cafe'`).toHaveLength(0);
  });

  it("refuses to restore a routine dependency that a newer one would turn into a cycle", async () => {
    const [commitment] = await sql<{ id: string }[]>`
      INSERT INTO commitments (user_id,title,starts_at,ends_at) VALUES (${userId},'Out',now() + interval '1 day',now() + interval '2 days') RETURNING id`;
    const stepId = (name: string) => stableUuid(`routine:${userId}`, name);
    const [a, b] = [await stepId("a"), await stepId("b")];
    await sql`INSERT INTO routine_steps (id,user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule)
      VALUES (${a},${userId},${commitment!.id},${commitment!.id},'A',5,1,'contiguous'),(${b},${userId},${commitment!.id},${commitment!.id},'B',5,2,'contiguous')`;
    await sql`INSERT INTO routine_step_dependencies (step_id,depends_on_step_id) VALUES (${a},${b})`;
    const save = entityCommand(
      "routine_step",
      {
        id: "a",
        commitmentId: commitment!.id,
        title: "A",
        durationMinutes: 5,
        sequence: 1,
        timingRule: "contiguous",
        phase: "before",
        energy: "low",
        dependencyIds: []
      },
      1
    );
    await asAgent(() => saveEntity(sql, save));
    expect(await sql`SELECT 1 FROM routine_step_dependencies`).toHaveLength(0);
    await sql`INSERT INTO routine_step_dependencies (step_id,depends_on_step_id) VALUES (${b},${a})`;
    const error = await asAgent(() => runRevertCommand(sql, revert(save.commandId, "undo"))).catch((e) => e);
    expect(error).toBeInstanceOf(CommandConflictError);
    expect(error.message).toContain("cycle");
    expect(await sql`SELECT 1 FROM routine_step_dependencies`).toHaveLength(1);
  });

  it("refuses to restore capability pathways that a newer one would turn into a cycle", async () => {
    const place = (
      id: string,
      pathways: string[][]
    ) => sql`INSERT INTO condition_definitions (user_id,id,name,kind,pathways)
      VALUES (${userId},${id},${id},'capability',${sql.json(pathways as never)})`;
    await place("cap-x", [["cap-y"]]);
    await place("cap-y", []);
    const save = entityCommand(
      "condition_definition",
      { id: "cap-x", name: "cap-x", kind: "capability", pathways: [] },
      1
    );
    await asAgent(() => saveEntity(sql, save));
    await sql`UPDATE condition_definitions SET pathways = ${sql.json([["cap-x"]] as never)} WHERE id = 'cap-y'`;
    const error = await asAgent(() => runRevertCommand(sql, revert(save.commandId, "undo"))).catch((e) => e);
    expect(error).toBeInstanceOf(CommandConflictError);
    expect(error.message).toContain("cycle");
    expect((await image("condition_definitions", "id = 'cap-x'"))!.pathways).toEqual([]);
  });

  it("refuses to undo a created routine preset that was since chosen as the bedtime routine", async () => {
    const create = entityCommand("routine_preset", {
      id: "wind-down",
      name: "Wind down",
      steps: [
        {
          id: "lights",
          title: "Lights",
          durationMinutes: 5,
          timingRule: "contiguous",
          energy: "low",
          dependencyIds: []
        }
      ]
    });
    await asAgent(() => saveEntity(sql, create));
    const [preset] = await sql<{ id: string }[]>`SELECT id FROM routine_presets WHERE name = 'Wind down'`;
    await sql`UPDATE user_preferences SET bedtime_routine_preset_id = ${preset!.id} WHERE user_id = ${userId}`;
    await expect(asAgent(() => runRevertCommand(sql, revert(create.commandId, "undo")))).rejects.toThrow(
      CommandConflictError
    );
    expect(await sql`SELECT 1 FROM routine_presets WHERE id = ${preset!.id}`).toHaveLength(1);
    await sql`UPDATE user_preferences SET bedtime_routine_preset_id = NULL WHERE user_id = ${userId}`;
    await asAgent(() => runRevertCommand(sql, revert(create.commandId, "undo")));
    expect(await sql`SELECT 1 FROM routine_presets WHERE id = ${preset!.id}`).toHaveLength(0);
  });

  it("keeps an instantiated step linked to its preset step when the preset is re-saved", async () => {
    const preset = (name: string, steps: string[], version: number | null) =>
      entityCommand(
        "routine_preset",
        {
          id: "evening",
          name,
          steps: steps.map((id, index) => ({
            id,
            title: id,
            durationMinutes: 5 + index,
            timingRule: "contiguous",
            energy: "low",
            dependencyIds: index ? [steps[index - 1]!] : []
          }))
        },
        version
      );
    await runWithActor(null, () => saveEntity(sql, preset("Evening", ["a", "b"], null)));
    const presetId = await stableUuid(`routine-preset:${userId}`, "evening");
    const stepA = await stableUuid(`routine-preset-step:${presetId}`, "a");
    const stepB = await stableUuid(`routine-preset-step:${presetId}`, "b");
    const [commitment] = await sql<{ id: string }[]>`
      INSERT INTO commitments (user_id,title,starts_at,ends_at) VALUES (${userId},'Out',now() + interval '1 day',now() + interval '2 days') RETURNING id`;
    const link = async (stepId: string, sequence: number) =>
      (
        await sql<{ id: string }[]>`
          INSERT INTO routine_steps (user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule,preset_step_id)
          VALUES (${userId},${commitment!.id},${commitment!.id},'S',5,${sequence},'contiguous',${stepId}) RETURNING id`
      )[0]!.id;
    const linkA = await link(stepA, 1);
    const linkB = await link(stepB, 2);
    const presetStepOf = async (id: string) =>
      (await sql<{ preset_step_id: string | null }[]>`SELECT preset_step_id FROM routine_steps WHERE id = ${id}`)[0]!
        .preset_step_id;

    await runWithActor(null, () => saveEntity(sql, preset("Evening renamed", ["a", "b"], 1)));
    expect(await presetStepOf(linkA)).toBe(stepA);
    expect(await presetStepOf(linkB)).toBe(stepB);

    // A step the save drops is still deleted (its link clears); one it keeps stays linked.
    await runWithActor(null, () => saveEntity(sql, preset("Evening renamed", ["a"], 2)));
    expect(await presetStepOf(linkA)).toBe(stepA);
    expect(await presetStepOf(linkB)).toBeNull();
    expect(
      (await sql<{ id: string }[]>`SELECT id FROM routine_preset_steps WHERE preset_id = ${presetId}`).map((r) => r.id)
    ).toEqual([stepA]);
  });

  it("restores a swapped step order, the links to the preset's steps, and redoes it", async () => {
    const preset = (steps: string[]) =>
      entityCommand(
        "routine_preset",
        {
          id: "morning",
          name: "Morning",
          steps: steps.map((id) => ({
            id,
            title: id,
            durationMinutes: 5,
            timingRule: "contiguous",
            energy: "low",
            dependencyIds: []
          }))
        },
        steps.length === 2 && steps[0] === "a" ? null : 1
      );
    await runWithActor(null, () => saveEntity(sql, preset(["a", "b"])));
    const presetId = await stableUuid(`routine-preset:${userId}`, "morning");
    const stepA = await stableUuid(`routine-preset-step:${presetId}`, "a");
    const [commitment] = await sql<{ id: string }[]>`
      INSERT INTO commitments (user_id,title,starts_at,ends_at) VALUES (${userId},'Out',now() + interval '1 day',now() + interval '2 days') RETURNING id`;
    const [linked] = await sql<{ id: string }[]>`
      INSERT INTO routine_steps (user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule,preset_step_id)
      VALUES (${userId},${commitment!.id},${commitment!.id},'A',5,1,'contiguous',${stepA}) RETURNING id`;
    const sequences = async () =>
      (
        await sql<
          { id: string; sequence: number }[]
        >`SELECT id, sequence FROM routine_preset_steps WHERE preset_id = ${presetId} ORDER BY sequence`
      ).map((row) => row.id);
    expect(await sequences()).toEqual([stepA, await stableUuid(`routine-preset-step:${presetId}`, "b")]);

    const swap = preset(["b", "a"]);
    await asAgent(() => saveEntity(sql, swap));
    expect((await sequences())[0]).not.toBe(stepA);
    // The reorder keeps step "a" under its stable id, so its instantiated step stays linked.
    expect((await image("routine_steps", "id = $1", linked!.id))!.preset_step_id).toBe(stepA);

    await asAgent(() => runRevertCommand(sql, revert(swap.commandId, "undo")));
    expect((await sequences())[0]).toBe(stepA);
    expect((await image("routine_steps", "id = $1", linked!.id))!.preset_step_id).toBe(stepA);

    await asAgent(() => runRevertCommand(sql, revert(swap.commandId, "redo")));
    expect((await sequences())[0]).not.toBe(stepA);
  });

  it("undoes the detaching of an occurrence in progress more than a day away", async () => {
    const base = {
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      rule: {
        id: "late-shift",
        title: "Late shift",
        timezone: "Australia/Sydney",
        startDate: "2026-09-01",
        repeat: { unit: "days", intervalDays: 7 },
        localStartTime: "09:00",
        localEndTime: "17:00",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    } as Parameters<typeof saveCommitmentRecurrenceRule>[1];
    await runWithActor(null, () => saveCommitmentRecurrenceRule(sql, base));
    const ruleId = await stableUuid(`commitment-recurrence:${userId}`, "late-shift");
    const [occurrence] = await sql<{ id: string }[]>`
      INSERT INTO commitments (user_id,title,starts_at,ends_at,recurrence_rule_id,local_date)
      VALUES (${userId},'Late shift',now() + interval '3 days',now() + interval '3 days 8 hours',${ruleId},current_date + 3) RETURNING id`;
    // Preparation already started: the occurrence counts as in progress however far off it is.
    await sql`INSERT INTO routine_steps (user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule,status)
      VALUES (${userId},${occurrence!.id},${occurrence!.id},'Pack',5,1,'contiguous','doing')`;
    const before = await image("commitments", "id = $1", occurrence!.id);
    const version = (
      await sql<{ version: number }[]>`SELECT version FROM commitment_recurrence_rules WHERE id=${ruleId}`
    )[0]!.version;
    const edit = {
      ...base,
      commandId: crypto.randomUUID(),
      expectedVersion: version,
      applyToOccurrenceInProgress: false
    } as typeof base;
    await asAgent(() => saveCommitmentRecurrenceRule(sql, edit));
    expect((await image("commitments", "id = $1", occurrence!.id))!.schedule_source).toBe("custom");
    await asAgent(() => runRevertCommand(sql, revert(edit.commandId!, "undo")));
    expect(await image("commitments", "id = $1", occurrence!.id)).toEqual(before);
  });

  it("undoes a created recurring action after the planner ranked one of its occurrences", async () => {
    const projectId = await createProject();
    const command = actionCommand("ranked", projectId, 0, {
      title: "Ranked",
      schedulingMode: "recurring",
      recurrence: {
        id: "ranked-rule",
        timezone: "Australia/Sydney",
        startDate: "2026-09-01",
        endDate: "2027-09-01",
        intervalDays: 1,
        completionMode: "end_date",
        windows: [{ id: "am", name: "Morning", anchor: "local_time", localStartTime: "07:00", localEndTime: "09:00" }]
      }
    } as never);
    command.expectedVersion = null;
    await asAgent(() => saveAction(sql, command));
    const actionId = await stableUuid(`action:${userId}`, "ranked");
    const ruleId = await stableUuid(`recurrence:${userId}:${actionId}`, "ranked-rule");
    const windowId = await stableUuid(`recurrence-window:${ruleId}`, "am");
    await sql`INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source,status)
      VALUES ('occ-ranked',${actionId},${ruleId},${windowId},'2026-10-01',now(),now() + interval '1 hour','local_time','pending')`;
    const [recommendation] = await sql<{ id: string }[]>`
      INSERT INTO recommendations (user_id,input_version,kind,headline,explanation,primary_action_id,primary_occurrence_id)
      VALUES (${userId},'v1','action','Do it','Because',${actionId},'occ-ranked') RETURNING id`;
    await sql`INSERT INTO recommendation_candidates (recommendation_id,rank,total_score,score_components,eligible,occurrence_id,target_id)
      VALUES (${recommendation!.id},1,1,${sql.json({} as never)},true,'occ-ranked',${actionId})`;
    await asAgent(() => runRevertCommand(sql, revert(command.commandId!, "undo")));
    expect(await sql`SELECT 1 FROM actions WHERE id = ${actionId}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM recommendation_candidates`).toHaveLength(0);
  });

  it("redoes a sleep override after the planner deleted and reinserted the night the undo gave back", async () => {
    const id = await stableUuid(`sleep:${userId}`, "night-3");
    const start = new Date(Date.now() + 2 * 3_600_000);
    const wake = new Date(start.getTime() + 8 * 3_600_000);
    await sql`INSERT INTO sleep_plans (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,sleep_deficit_minutes,explanation,status,input_version)
      VALUES (${id},${userId},${start},${wake},480,480,0,'Calculated.','planned','v1')`;
    const command = entityCommand(
      "sleep_plan",
      {
        id: "night-3",
        plannedStartAt: new Date(start.getTime() + 3_600_000).toISOString(),
        plannedWakeAt: new Date(wake.getTime() + 3_600_000).toISOString()
      },
      1
    );
    await asAgent(() => saveEntity(sql, command));
    const overridden = await image("sleep_plans", "id = $1", id);
    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "undo")));

    // The real publication path: it deletes ordinary planned nights and inserts the engine's, new created_at included.
    const calculatedAt = new Date();
    await persistDerivedState(sql, userId, {
      inputVersion: "v2",
      calculatedAt: calculatedAt.toISOString(),
      derivedState: {
        sleepPlans: [
          {
            id,
            plannedStartAt: new Date(start.getTime() + 600_000).toISOString(),
            plannedWakeAt: new Date(wake.getTime() + 600_000).toISOString(),
            desiredMinutes: 480,
            allowedMinutes: 420,
            sleepDeficitMinutes: 60,
            status: "planned"
          }
        ],
        occurrences: [],
        routineSteps: [],
        commitmentRepeats: []
      }
    } as never);
    expect((await image("sleep_plans", "id = $1", id))!.allowed_minutes).toBe(420);

    await asAgent(() => runRevertCommand(sql, revert(command.commandId, "redo")));
    expect(await image("sleep_plans", "id = $1", id)).toMatchObject({
      input_version: "override",
      allowed_minutes: overridden!.allowed_minutes
    });
  });
  it("redoes dropping a cadence rule whose completions the undo restored", async () => {
    const projectId = await createProject();
    const id = await createAction(projectId, "cadence");
    await sql`INSERT INTO action_cadence_completions (action_id,rule_id,completed_at,local_date,minutes)
      SELECT ${id}, r.id, now(), '2026-10-01', 25 FROM action_recurrence_rules r WHERE r.action_id = ${id}`;
    const version = (await sql<{ version: number }[]>`SELECT version FROM actions WHERE id=${id}`)[0]!.version;
    const command = actionCommand(id, projectId, version, { schedulingMode: "one_off" });
    await asAgent(() => saveAction(sql, command));
    await asAgent(() => runRevertCommand(sql, revert(command.commandId!, "undo")));
    await asAgent(() => runRevertCommand(sql, revert(command.commandId!, "redo")));
    expect(await sql`SELECT 1 FROM action_cadence_completions WHERE action_id=${id}`).toHaveLength(0);
    // A completion logged after the undo is newer work, and still stops the redo.
    await asAgent(() => runRevertCommand(sql, revert(command.commandId!, "undo")));
    await sql`INSERT INTO action_cadence_completions (action_id,rule_id,completed_at,local_date,minutes)
      SELECT ${id}, r.id, now(), '2026-10-05', 10 FROM action_recurrence_rules r WHERE r.action_id = ${id}`;
    await expect(asAgent(() => runRevertCommand(sql, revert(command.commandId!, "redo")))).rejects.toThrow(
      CommandConflictError
    );
  });

  it("refuses to undo a created action that something has since come to depend on", async () => {
    const projectId = await createProject();
    const other = await createAction(projectId);
    const create = actionCommand("new-prereq", projectId, 0, { title: "Created" });
    create.expectedVersion = null;
    await asAgent(() => saveAction(sql, create));
    const created = await stableUuid(`action:${userId}`, "new-prereq");
    await sql`INSERT INTO entity_prerequisites (entity_kind,entity_id,requires_kind,requires_id) VALUES ('action',${other},'action',${created})`;
    const error = await asAgent(() => runRevertCommand(sql, revert(create.commandId!, "undo"))).catch((e) => e);
    expect(error).toBeInstanceOf(CommandConflictError);
    expect(error.message).toContain("Review > Agent changes");
    expect(await sql`SELECT 1 FROM actions WHERE id = ${created}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM entity_prerequisites`).toHaveLength(1);
  });

  it("refuses to undo a created project that something has since come to depend on", async () => {
    const projectId = await createProject();
    const other = await createAction(projectId);
    const [outcome] = await sql<{ id: string }[]>`SELECT outcome_id AS id FROM projects WHERE id = ${projectId}`;
    const create = {
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      project: {
        id: "new-project",
        outcomeId: outcome!.id,
        title: "Created",
        status: "active",
        uncertainty: "some",
        consequence: 3
      }
    } as never as Parameters<typeof saveProject>[1];
    await asAgent(() => saveProject(sql, create));
    const created = await stableUuid(`project:${userId}`, "new-project");
    await sql`INSERT INTO entity_prerequisites (entity_kind,entity_id,requires_kind,requires_id) VALUES ('action',${other},'project',${created})`;
    await expect(asAgent(() => runRevertCommand(sql, revert(create.commandId!, "undo")))).rejects.toThrow(
      CommandConflictError
    );
    expect(await sql`SELECT 1 FROM projects WHERE id = ${created}`).toHaveLength(1);
  });

  it("refuses to undo a created routine step that a newer step now waits on", async () => {
    const [commitment] = await sql<{ id: string }[]>`
      INSERT INTO commitments (user_id,title,starts_at,ends_at,routine_source) VALUES (${userId},'Out',now() + interval '1 day',now() + interval '2 days','custom') RETURNING id`;
    const create = entityCommand("routine_step", {
      id: "step-a",
      commitmentId: commitment!.id,
      title: "A",
      durationMinutes: 5,
      sequence: 1,
      timingRule: "contiguous",
      phase: "before",
      energy: "low",
      dependencyIds: []
    });
    await asAgent(() => saveEntity(sql, create));
    const a = await stableUuid(`routine:${userId}`, "step-a");
    const [b] = await sql<{ id: string }[]>`
      INSERT INTO routine_steps (user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule)
      VALUES (${userId},${commitment!.id},${commitment!.id},'B',5,2,'contiguous') RETURNING id`;
    await sql`INSERT INTO routine_step_dependencies (step_id,depends_on_step_id) VALUES (${b!.id},${a})`;
    await expect(asAgent(() => runRevertCommand(sql, revert(create.commandId, "undo")))).rejects.toThrow(
      CommandConflictError
    );
    expect(await sql`SELECT 1 FROM routine_step_dependencies`).toHaveLength(1);
  });
  describe("rows that point at a created row through a foreign key", () => {
    const createProjectAsAgent = async () => {
      const projectId = await createProject();
      const [outcome] = await sql<{ id: string }[]>`SELECT outcome_id AS id FROM projects WHERE id = ${projectId}`;
      const create = {
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        project: {
          id: "fk-project",
          outcomeId: outcome!.id,
          title: "Created",
          status: "active",
          uncertainty: "some",
          consequence: 3
        }
      } as never as Parameters<typeof saveProject>[1];
      await asAgent(() => saveProject(sql, create));
      return { create, created: await stableUuid(`project:${userId}`, "fk-project") };
    };

    it("refuses to undo a created project that a focus period now includes", async () => {
      const { create, created } = await createProjectAsAgent();
      const [period] = await sql<{ id: string }[]>`
        INSERT INTO planning_focus_periods (user_id,kind,period_start,period_end) VALUES (${userId},'weekly','2026-11-02','2026-11-08') RETURNING id`;
      await sql`INSERT INTO planning_focus_projects (focus_period_id,project_id) VALUES (${period!.id},${created})`;
      const error = await asAgent(() => runRevertCommand(sql, revert(create.commandId!, "undo"))).catch((e) => e);
      expect(error).toBeInstanceOf(CommandConflictError);
      expect(error.message).toContain("planning focus projects");
      expect(await sql`SELECT 1 FROM projects WHERE id = ${created}`).toHaveLength(1);
      expect(await sql`SELECT 1 FROM planning_focus_projects`).toHaveLength(1);
    });

    it("refuses to undo a created project that a commitment now belongs to", async () => {
      const { create, created } = await createProjectAsAgent();
      const [commitment] = await sql<{ id: string }[]>`
        INSERT INTO commitments (user_id,title,starts_at,ends_at,project_id) VALUES (${userId},'Out',now() + interval '1 day',now() + interval '2 days',${created}) RETURNING id`;
      const error = await asAgent(() => runRevertCommand(sql, revert(create.commandId!, "undo"))).catch((e) => e);
      expect(error).toBeInstanceOf(CommandConflictError);
      expect(error.message).toContain("commitments");
      expect((await image("commitments", "id = $1", commitment!.id))!.project_id).toBe(created);
    });

    const addWindowAsAgent = async () => {
      const projectId = await createProject();
      const window = (id: string, start: string) => ({
        id,
        name: id,
        anchor: "local_time" as const,
        localStartTime: start,
        localEndTime: "23:00"
      });
      const save = (version: number | null, windows: ReturnType<typeof window>[]) => {
        const command = actionCommand("fk-habit", projectId, version ?? 0, {
          title: "Habit",
          schedulingMode: "recurring",
          recurrence: {
            id: "fk-rule",
            timezone: "Australia/Sydney",
            startDate: "2026-09-01",
            endDate: "2027-09-01",
            intervalDays: 1,
            completionMode: "end_date",
            windows
          }
        } as never);
        command.expectedVersion = version;
        return command;
      };
      await runWithActor(null, () => saveAction(sql, save(null, [window("am", "07:00")])));
      const actionId = await stableUuid(`action:${userId}`, "fk-habit");
      const ruleId = await stableUuid(`recurrence:${userId}:${actionId}`, "fk-rule");
      const version = (await sql<{ version: number }[]>`SELECT version FROM actions WHERE id=${actionId}`)[0]!.version;
      const add = save(version, [window("am", "07:00"), window("pm", "19:00")]);
      await asAgent(() => saveAction(sql, add));
      return { add, pmId: await stableUuid(`recurrence-window:${ruleId}`, "pm") };
    };

    it("refuses to undo a created window that a routine step is linked to", async () => {
      const { add, pmId } = await addWindowAsAgent();
      const [commitment] = await sql<{ id: string }[]>`
        INSERT INTO commitments (user_id,title,starts_at,ends_at) VALUES (${userId},'Out',now() + interval '1 day',now() + interval '2 days') RETURNING id`;
      const [step] = await sql<{ id: string }[]>`
        INSERT INTO routine_steps (user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule,action_window_id)
        VALUES (${userId},${commitment!.id},${commitment!.id},'Meds',5,1,'contiguous',${pmId}) RETURNING id`;
      const error = await asAgent(() => runRevertCommand(sql, revert(add.commandId!, "undo"))).catch((e) => e);
      expect(error).toBeInstanceOf(CommandConflictError);
      expect(error.message).toContain("routine steps");
      expect((await image("routine_steps", "id = $1", step!.id))!.action_window_id).toBe(pmId);
    });

    it("refuses to undo a created window that a preset step is linked to", async () => {
      const { add, pmId } = await addWindowAsAgent();
      const [preset] = await sql<{ id: string }[]>`
        INSERT INTO routine_presets (user_id,name,activity_name) VALUES (${userId},'Evening','Evening') RETURNING id`;
      const [step] = await sql<{ id: string }[]>`
        INSERT INTO routine_preset_steps (preset_id,title,duration_minutes,sequence,timing_rule,action_window_id)
        VALUES (${preset!.id},'Meds',5,1,'contiguous',${pmId}) RETURNING id`;
      const error = await asAgent(() => runRevertCommand(sql, revert(add.commandId!, "undo"))).catch((e) => e);
      expect(error).toBeInstanceOf(CommandConflictError);
      expect(error.message).toContain("routine preset steps");
      expect((await image("routine_preset_steps", "id = $1", step!.id))!.action_window_id).toBe(pmId);
    });
  });
});
