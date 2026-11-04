import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { memoryJournal, runCli, type Journal } from "@openrhen/cli/in-process";
import { planningEntityCommandSchema, saveActionCommandSchema, saveProjectCommandSchema } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { CommandConflictError, InvalidCommandError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { saveEntity } from "./entity-commands";
import { saveAction, saveProject } from "./project-commands";
import { readPortalState } from "./state-read";

/**
 * Undoing a create against the real handlers. `save` and `capture` journal a create with a reverse that restates
 * the new record with a status that takes it out of the plan (archived, cancelled, ignored), or removes a span;
 * the CLI runs here unchanged, its `fetch` answered by the portal's own command functions on a real database, so
 * what is proved is that the restated create is accepted as a version-checked update, takes the record out, and that
 * redo puts it back at the next version. Self-contained `_test` database, same pattern as `spans.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.CREATE_UNDO_TEST_DATABASE_NAME, "openrhen_create_undo");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("CREATE_UNDO_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let journal: Journal;

const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const ORIGIN = "http://openrhen.localhost";

/** The portal's command functions behind a `fetch`, with the status codes the routes give their errors. */
const portalFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  try {
    if (url.pathname === "/api/state") return reply(200, { state: await readPortalState(sql) });
    const body: unknown = JSON.parse(String(init?.body));
    if (url.pathname === "/api/commands/entity")
      return reply(200, { state: await saveEntity(sql, planningEntityCommandSchema.parse(body)) });
    if (url.pathname === "/api/commands/project")
      return reply(200, { state: await saveProject(sql, saveProjectCommandSchema.parse(body)) });
    if (url.pathname === "/api/commands/action")
      return reply(200, { state: await saveAction(sql, saveActionCommandSchema.parse(body)) });
    return reply(404, { error: `No route ${url.pathname}` });
  } catch (error) {
    if (error instanceof CommandConflictError) return reply(409, { error: error.message });
    if (error instanceof InvalidCommandError) return reply(400, { error: error.message });
    throw error;
  }
};

async function cli(...argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env: { OPENRHEN_URL: ORIGIN } as Record<string, string> as NodeJS.ProcessEnv,
    fetchImpl: portalFetch,
    readConfigFile: () => null,
    journal
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

/** The id the portal gave the record the newest journal entry is about. */
const newestTarget = () => journal.read().at(-1)!.target.id!;

const row = async (table: string, id: string) =>
  (
    await sql.unsafe<{ status: string; version: number }[]>(`SELECT status, version FROM ${table} WHERE id = $1`, [id])
  )[0];

/** The ids the change feed (`write_rows`) names for records of one type, oldest write first. */
const feedIds = async (entityType: string) =>
  (
    await sql<
      { entity_id: string }[]
    >`SELECT entity_id FROM write_rows WHERE entity_type = ${entityType} ORDER BY created_at, id`
  ).map((feedRow) => feedRow.entity_id);

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
  await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  journal = memoryJournal([], 200);
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, routine_preset_steps, routine_presets, spans, commitments, actions, projects, outcomes, areas, captures, sources, condition_definitions RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

describe("undoing a create through the CLI against the real handlers", () => {
  it("takes a new area, outcome, project and action out of the plan newest first, and redo puts each back", async () => {
    expect(
      (await cli("save", "area", "--set", "name=Wrong area", "--set", "status=active", "--set", "sortOrder=3")).exitCode
    ).toBe(0);
    const areaId = newestTarget();
    expect(
      (
        await cli(
          "save",
          "outcome",
          "--set",
          "title=Wrong outcome",
          "--set",
          `areaId=${areaId}`,
          "--set",
          "definitionOfDone=Never",
          "--set",
          "value=3",
          "--set",
          "status=active"
        )
      ).exitCode
    ).toBe(0);
    const outcomeId = newestTarget();
    // A non-uuid id is hashed by the handler: the journal must name the row by the id the state shows.
    expect(
      (
        await cli(
          "save",
          "project",
          "--create",
          "--set",
          "id=project-wrong",
          "--set",
          "title=Wrong project",
          "--set",
          `outcomeId=${outcomeId}`
        )
      ).exitCode
    ).toBe(0);
    const projectId = newestTarget();
    expect(projectId).not.toBe("project-wrong");
    // The change feed names the id the project is stored under, not the slug that was sent.
    expect(await feedIds("project")).toEqual([projectId]);
    expect(
      (
        await cli(
          "save",
          "action",
          "--create",
          "--set",
          "id=action-wrong",
          "--set",
          "title=Wrong action",
          "--set",
          `projectId=${projectId}`
        )
      ).exitCode
    ).toBe(0);
    const actionId = newestTarget();
    expect(await feedIds("action")).toEqual([actionId]);
    expect(journal.read().map((entry) => entry.version)).toEqual([1, 1, 1, 1]);

    const steps: [string, string, string, string][] = [
      ["actions", actionId, "cancelled", "planned"],
      ["projects", projectId, "cancelled", "active"],
      ["outcomes", outcomeId, "cancelled", "active"],
      ["areas", areaId, "archived", "active"]
    ];
    for (const [table, id, hidden] of steps) {
      const undone = await cli("undo");
      expect(undone.exitCode, undone.stderr).toBe(0);
      expect(await row(table, id)).toEqual({ status: hidden, version: 2 });
    }
    for (const [table, id, hidden, shown] of [...steps].reverse()) {
      expect(await row(table, id)).toEqual({ status: hidden, version: 2 });
      const redone = await cli("undo", "--redo");
      expect(redone.exitCode, redone.stderr).toBe(0);
      expect(await row(table, id)).toEqual({ status: shown, version: 3 });
    }
    // The cycle repeats, so each move left a version the next could be checked against.
    expect((await cli("undo")).exitCode).toBe(0);
    expect(await row("actions", actionId)).toEqual({ status: "cancelled", version: 4 });
  });

  it("creates a project and an action that name no id, keyed by their command ids, once however often it is sent", async () => {
    await cli(
      "save",
      "area",
      "--create",
      "--set",
      "id=area-home",
      "--set",
      "name=Home",
      "--set",
      "status=active",
      "--set",
      "sortOrder=3"
    );
    const areaId = newestTarget();
    // Every kind that hashes the id it is sent is named in the change feed by the one it is stored under.
    expect(areaId).not.toBe("area-home");
    expect(await feedIds("area")).toEqual([areaId]);
    await cli(
      "save",
      "outcome",
      "--set",
      "title=A tidy house",
      "--set",
      `areaId=${areaId}`,
      "--set",
      "definitionOfDone=Done",
      "--set",
      "value=3",
      "--set",
      "status=active"
    );
    const outcomeId = newestTarget();
    const projectKey = crypto.randomUUID();
    const project = [
      "save",
      "project",
      "--set",
      "title=Tidy the shed",
      "--set",
      `outcomeId=${outcomeId}`,
      "--command-id",
      projectKey
    ];
    const made = await cli(...project);
    expect(made.exitCode, made.stderr).toBe(0);
    expect(newestTarget()).toBe(projectKey);
    expect(await row("projects", projectKey)).toEqual({ status: "active", version: 1 });

    const actionKey = crypto.randomUUID();
    const action = [
      "save",
      "action",
      "--set",
      "title=Call mum",
      "--set",
      `projectId=${projectKey}`,
      "--command-id",
      actionKey
    ];
    const madeAction = await cli(...action);
    expect(madeAction.exitCode, madeAction.stderr).toBe(0);
    expect(newestTarget()).toBe(actionKey);
    expect(await row("actions", actionKey)).toEqual({ status: "planned", version: 1 });

    // The same invocation again is answered by the receipt the first one left: no second record, no second row.
    expect((await cli(...project)).exitCode).toBe(0);
    expect((await cli(...action)).exitCode).toBe(0);
    const counts = await sql<{ projects: number; actions: number }[]>`
      SELECT (SELECT count(*)::int FROM projects) AS projects, (SELECT count(*)::int FROM actions) AS actions`;
    expect(counts[0]).toEqual({ projects: 1, actions: 1 });
    expect(await feedIds("project")).toEqual([projectKey]);
    expect(await feedIds("action")).toEqual([actionKey]);

    // And what was made undoes and redoes by the same ids.
    expect((await cli("undo")).exitCode).toBe(0);
    expect(await row("actions", actionKey)).toEqual({ status: "cancelled", version: 2 });
    expect((await cli("undo", "--redo")).exitCode).toBe(0);
    expect(await row("actions", actionKey)).toEqual({ status: "planned", version: 3 });
  });

  it("refuses to undo a create that was edited since, and leaves it as edited", async () => {
    await cli("save", "area", "--set", "name=Wrong area", "--set", "status=active", "--set", "sortOrder=3");
    const areaId = newestTarget();
    await sql`UPDATE areas SET name = 'Edited elsewhere', version = version + 1 WHERE id = ${areaId}`;
    const undone = await cli("undo");
    expect(undone.exitCode).not.toBe(0);
    expect(await row("areas", areaId)).toEqual({ status: "active", version: 2 });
  });

  it("ignores a new capture, and redo returns it to pending with its stored fields", async () => {
    expect((await cli("capture", "Ring the plumber")).exitCode).toBe(0);
    const id = newestTarget();
    const proposal = () =>
      sql<
        { status: string; version: number; proposal_type: string; proposed_fields: unknown }[]
      >`SELECT status, version, proposal_type, proposed_fields FROM captures WHERE id = ${id}`;
    expect((await proposal())[0]).toMatchObject({ status: "pending", version: 1 });

    const undone = await cli("undo");
    expect(undone.exitCode, undone.stderr).toBe(0);
    expect((await proposal())[0]).toMatchObject({ status: "ignored", version: 2 });

    const redone = await cli("undo", "--redo");
    expect(redone.exitCode, redone.stderr).toBe(0);
    expect((await proposal())[0]).toMatchObject({
      status: "pending",
      version: 3,
      proposal_type: "unclassified",
      proposed_fields: { text: "Ring the plumber" }
    });
  });

  it("cancels a new commitment and puts it back", async () => {
    const created = await cli(
      "save",
      "commitment",
      "--set",
      "title=Wrong appointment",
      "--set",
      "status=confirmed",
      "--set",
      "startsAt=2030-01-02T10:00:00+00:00",
      "--set",
      "endsAt=2030-01-02T11:00:00+00:00",
      "--set",
      "setupBeforeMinutes=0",
      "--set",
      "transitionAfterMinutes=0"
    );
    expect(created.exitCode, created.stderr).toBe(0);
    const id = newestTarget();
    expect((await cli("undo")).exitCode).toBe(0);
    expect(await row("commitments", id)).toEqual({ status: "cancelled", version: 2 });
    expect((await cli("undo", "--redo")).exitCode).toBe(0);
    expect(await row("commitments", id)).toEqual({ status: "confirmed", version: 3 });
  });

  it("archives a new context and puts it back", async () => {
    const created = await cli(
      "save",
      "condition-definition",
      "--create",
      "--set",
      "id=tools-wrong",
      "--set",
      "name=Wrong tools",
      "--set",
      "kind=capability"
    );
    expect(created.exitCode, created.stderr).toBe(0);
    expect((await cli("undo")).exitCode).toBe(0);
    const stored = () =>
      sql<
        { status: string; version: number }[]
      >`SELECT status, version FROM condition_definitions WHERE id = 'tools-wrong'`;
    expect((await stored())[0]).toEqual({ status: "archived", version: 2 });
    const redone = await cli("undo", "--redo");
    expect(redone.exitCode, redone.stderr).toBe(0);
    expect((await stored())[0]).toEqual({ status: "active", version: 3 });
  });

  it("archives a new routine and puts it back", async () => {
    const created = await cli(
      "save",
      "routine-preset",
      "--set",
      "name=Wrong routine",
      "--set",
      "activityName=Wrong",
      "--set",
      "status=active",
      "--set",
      `steps=[{"id":"${crypto.randomUUID()}","title":"Step","durationMinutes":10,"timingRule":"contiguous","energy":"low","contexts":[],"dependencyIds":[]}]`
    );
    expect(created.exitCode, created.stderr).toBe(0);
    const id = newestTarget();
    const undone = await cli("undo");
    expect(undone.exitCode, undone.stderr).toBe(0);
    expect(await row("routine_presets", id)).toEqual({ status: "archived", version: 2 });
    const redone = await cli("undo", "--redo");
    expect(redone.exitCode, redone.stderr).toBe(0);
    expect(await row("routine_presets", id)).toEqual({ status: "active", version: 3 });
  });

  it("removes a new span, and redo creates it again", async () => {
    const created = await cli(
      "save",
      "span",
      "--set",
      "title=Away",
      "--set",
      `startDate=${dayOffset(-8)}`,
      "--set",
      `endDate=${dayOffset(-6)}`
    );
    expect(created.exitCode, created.stderr).toBe(0);
    const spans = () => sql<{ title: string }[]>`SELECT title FROM spans`;
    expect(await spans()).toHaveLength(1);
    const undone = await cli("undo");
    expect(undone.exitCode, undone.stderr).toBe(0);
    expect(await spans()).toHaveLength(0);
    const redone = await cli("undo", "--redo");
    expect(redone.exitCode, redone.stderr).toBe(0);
    expect(await spans()).toMatchObject([{ title: "Away" }]);
  });
});
