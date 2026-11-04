import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import type { SaveActionCommand } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readChangeFeed } from "@/server/persistence/postgres/change-feed";
import { saveAction } from "@/server/persistence/postgres/project-commands";
import { runRevertCommand } from "@/server/persistence/postgres/write-revert";
import { databaseJournalStore, runCliWithAgentJournal } from "./agent-journal-runner";
import type { AgentPrincipal } from "./agent-tokens";
import type { RouteLoader } from "./mcp-cli-runner";

/**
 * Review > Agent changes from the write ledger, against a real database: a real agent write is listed with its
 * `writeId` and explained by the detail route, the list pages across a boundary (ledger and legacy journal entries
 * merged), a changeset is one row, an old journal entry is still listed and undoable, the owner undoes and redoes a
 * ledger row from the panel route, and an agent's own undo list on `/mcp` is the ledger's.
 */
config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

const holder = vi.hoisted(() => ({ loadRoute: undefined as RouteLoader | undefined }));
vi.mock("@/server/agent-journal-runner", async (original) => {
  const actual = await original<typeof import("@/server/agent-journal-runner")>();
  return {
    ...actual,
    runCliWithAgentJournal: (options: Parameters<typeof actual.runCliWithAgentJournal>[0]) =>
      actual.runCliWithAgentJournal({ ...options, loadRoute: holder.loadRoute ?? options.loadRoute })
  };
});
vi.mock("@/server/agent-activity", () => ({ noteAgentCall: () => {} }));

const listRoute = await import("../app/api/agent-changes/route");
const detailRoute = await import("../app/api/agent-changes/[id]/route");
const undoRoute = await import("../app/api/agent-changes/[id]/undo/route");

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.AGENT_CHANGES_TEST_DATABASE_NAME,
  "openrhen_agent_changes"
);
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("AGENT_CHANGES_TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
let previousDatabaseUrl: string | undefined;

const asAgent = <T>(run: () => Promise<T>, agent = "claude") => runWithActor(agent, run);

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
    await migrate(drizzle(migrationSql), {
      migrationsFolder: fileURLToPath(new URL("../../platform/database/drizzle", import.meta.url))
    });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = testUrl.toString();
}, 60_000);

beforeEach(async () => {
  holder.loadRoute = undefined;
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, planning_focus_periods, condition_definitions, routine_presets, spans, sleep_plans, sessions, commitment_recurrence_rules, commitments, actions, projects, outcomes, areas, captures RESTART IDENTITY CASCADE"
  );
  userId = await ensureUser(sql);
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`;
  await sql`UPDATE user_preferences SET home_location_id = NULL WHERE user_id = ${userId}`;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  await sql?.end();
});

interface ListedChange {
  agent: string;
  id: string;
  at: string;
  label: string;
  status: string;
  writeId: string | null;
  target: { stateKey: string; id?: string };
}
interface Listed {
  changes: ListedChange[];
  nextCursor: string | null;
}

async function list(query = ""): Promise<Listed> {
  const response = await listRoute.GET(new Request(`http://localhost/api/agent-changes${query}`), undefined);
  expect(response.status).toBe(200);
  return (await response.json()) as Listed;
}

const post = (id: string, body: unknown = {}) =>
  undoRoute.POST(
    new Request(`http://localhost/api/agent-changes/${id}/undo`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost" },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({ id }) }
  );

async function createAction(): Promise<{ projectId: string; id: string }> {
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
    VALUES (${project[0]!.id},'Draft citations','one_off','active',30,60,90,60,'medium',15,90) RETURNING id`;
  return { projectId: project[0]!.id, id: action[0]!.id };
}

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

/** An agent save of the action's notes; returns the write's id. */
async function agentSavesNotes(
  target: { projectId: string; id: string },
  notes: string,
  version = 1,
  agent = "claude"
): Promise<string> {
  const command = actionCommand(target.id, target.projectId, version, { notes });
  await asAgent(() => saveAction(sql, command), agent);
  return command.commandId!;
}

const notesOf = async (id: string) =>
  (await sql<{ notes: string | null }[]>`SELECT notes FROM actions WHERE id=${id}`)[0]!.notes;

/** A ledger write of its own, `minutes` after the epoch day, for paging and grouping. */
async function insertWrite(options: {
  actor?: string | null;
  at: string;
  id?: string;
  commandType?: string;
  state?: "applied" | "undone" | null;
  response?: unknown;
}): Promise<string> {
  const id = options.id ?? crypto.randomUUID();
  await sql`INSERT INTO writes (id, user_id, command_type, actor, state, response, created_at, updated_at)
    VALUES (${id}, ${userId}, ${options.commandType ?? "save_thing"}, ${options.actor === undefined ? "claude" : options.actor},
      ${options.state ?? null}, ${sql.json((options.response ?? {}) as never)}, ${options.at}, ${options.at})`;
  return id;
}

describe("GET /api/agent-changes", () => {
  it("lists an agent's real write with its writeId, and the detail route explains it", async () => {
    const action = await createAction();
    const writeId = await agentSavesNotes(action, "Cite the 2024 report");
    // The owner's own save, a system write and an agent's revert are not agent changes.
    await runWithActor(null, () => saveAction(sql, actionCommand(action.id, action.projectId, 2, { notes: "Mine" })));
    await insertWrite({ actor: "system", at: "2026-10-28T01:00:00Z" });
    await insertWrite({ actor: "claude", at: "2026-10-28T01:00:00Z", commandType: "revert_undo" });

    const { changes, nextCursor } = await list();
    expect(nextCursor).toBeNull();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      agent: "claude",
      id: writeId,
      writeId,
      status: "applied",
      target: { stateKey: "revert", id: writeId }
    });
    expect(changes[0]!.label).toMatch(/action "Draft citations"/);
    expect(Date.parse(changes[0]!.at)).not.toBeNaN();

    const detail = await detailRoute.GET(new Request(`http://localhost/api/agent-changes/${writeId}`), {
      params: Promise.resolve({ id: writeId })
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { writeId: string; actor: string; rows: { fields: { field: string }[] }[] };
    expect(body).toMatchObject({ writeId, actor: "claude" });
    expect(body.rows.flatMap((row) => row.fields.map((field) => field.field))).toContain("notes");
  });

  it("lists writes by any agent, whichever transport carried them", async () => {
    const action = await createAction();
    await agentSavesNotes(action, "From the CLI token", 1, "cli-agent");
    await agentSavesNotes(action, "From stdio mcp", 2, "stdio-agent");
    const { changes } = await list();
    expect(changes.map((change) => change.agent).sort()).toEqual(["cli-agent", "stdio-agent"]);
  });

  it("derives the status from the write's state, and superseded where nothing was kept to put it back", async () => {
    await insertWrite({ at: "2026-10-28T01:00:03Z", state: "applied" });
    await insertWrite({ at: "2026-10-28T01:00:02Z", state: "undone" });
    await insertWrite({ at: "2026-10-28T01:00:01Z", state: null });
    expect((await list()).changes.map((change) => change.status)).toEqual(["applied", "undone", "superseded"]);
  });

  it("pages across a boundary, including writes at the same instant, and ends with a null cursor", async () => {
    const ids: string[] = [];
    // Five writes: two share a microsecond-precise instant, so only the id breaks the tie.
    for (const at of [
      "2026-10-28T01:00:05.000100Z",
      "2026-10-28T01:00:04Z",
      "2026-10-28T01:00:03Z",
      "2026-10-28T01:00:03Z",
      "2026-10-28T01:00:01Z"
    ])
      ids.push(await insertWrite({ at }));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Listed = await list(`?limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`);
      expect(page.changes.length).toBeLessThanOrEqual(2);
      seen.push(...page.changes.map((change) => change.id));
      cursor = page.nextCursor;
      pages += 1;
      if (cursor) expect(page.changes).toHaveLength(2);
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual((await list("?limit=100")).changes.map((change) => change.id));
    expect(new Set(seen)).toEqual(new Set(ids));
    // Exactly a full page ends with no cursor.
    expect((await list("?limit=5")).nextCursor).toBeNull();
    expect((await list("?limit=4")).nextCursor).not.toBeNull();
  });

  it("names a write by the image of the row its label describes, not the first image", async () => {
    const writeId = await insertWrite({ at: "2026-10-28T01:00:00Z", state: "applied" });
    const action = crypto.randomUUID();
    await sql`UPDATE writes SET images=${sql.json([
      { table: "areas", id: crypto.randomUUID(), before: null, after: { name: "Another row" } },
      { table: "actions", id: action, before: null, after: { title: "The labelled row" } }
    ] as never)} WHERE id=${writeId}`;
    await sql`INSERT INTO write_rows (write_id, user_id, entity_type, entity_id, operation)
      VALUES (${writeId}, ${userId}, 'action', ${action}, 'save')`;
    expect((await list()).changes[0]!.label).toMatch(/The labelled row/);
  });

  it("refuses a before that is not a cursor", async () => {
    const response = await listRoute.GET(new Request("http://localhost/api/agent-changes?before=garbage"), undefined);
    expect(response.status).toBe(400);
  });

  it("shows a changeset as one row and hides its members", async () => {
    const a = await insertWrite({ at: "2026-10-28T01:00:01Z", state: "applied" });
    const b = await insertWrite({ at: "2026-10-28T01:00:02Z", state: "applied" });
    const loose = await insertWrite({ at: "2026-10-28T01:00:03Z", state: "applied" });
    const set = await insertWrite({
      at: "2026-10-28T01:00:04Z",
      commandType: "changeset",
      state: "applied",
      response: { members: [a, b] }
    });
    const { changes } = await list();
    expect(changes.map((change) => change.id)).toEqual([set, loose]);
    expect(changes[0]).toMatchObject({ writeId: set, label: "changeset of 2 writes", status: "applied" });
  });
});

describe("POST /api/agent-changes/[id]/undo on a ledger row", () => {
  it("lets the owner undo any agent's write, then redo it", async () => {
    const action = await createAction();
    const writeId = await agentSavesNotes(action, "Agent note");
    expect(await notesOf(action.id)).toBe("Agent note");

    const undone = await post(writeId);
    expect(undone.status).toBe(200);
    expect(await undone.json()).toMatchObject({ ok: true, direction: "undo", id: writeId });
    expect(await notesOf(action.id)).toBeNull();
    expect((await list()).changes[0]).toMatchObject({ id: writeId, status: "undone" });
    // The owner's revert is not listed as an agent change.
    expect((await list()).changes).toHaveLength(1);

    const redone = await post(writeId, { redo: true });
    expect(redone.status).toBe(200);
    expect(await notesOf(action.id)).toBe("Agent note");
    expect((await list()).changes[0]!.status).toBe("applied");
  });

  it("answers 409 and changes nothing when the record was edited since, and force overwrites it", async () => {
    const action = await createAction();
    const writeId = await agentSavesNotes(action, "Agent note");
    await sql`UPDATE actions SET notes = 'Edited by the owner', version = version + 1 WHERE id = ${action.id}`;
    const refused = await post(writeId);
    expect(refused.status).toBe(409);
    expect(await notesOf(action.id)).toBe("Edited by the owner");
    expect((await post(writeId, { force: true })).status).toBe(200);
    expect(await notesOf(action.id)).toBeNull();
  });

  it("refuses an undone change undone again, and a request that carries an agent identity", async () => {
    const action = await createAction();
    const writeId = await agentSavesNotes(action, "Agent note");
    expect((await post(writeId)).status).toBe(200);
    expect((await post(writeId)).status).toBe(409);
    const agentCall = await undoRoute.POST(
      new Request(`http://localhost/api/agent-changes/${writeId}/undo`, {
        method: "POST",
        headers: { "x-openrhen-agent": "claude", host: "localhost" },
        body: "{}"
      }),
      { params: Promise.resolve({ id: writeId }) }
    );
    expect(agentCall.status).toBe(403);
  });
});

describe("the agent's own undo list on /mcp is the ledger's", () => {
  const principal: AgentPrincipal = {
    name: "claude",
    source: "db",
    tokenId: "t1",
    scopes: ["read:plan", "write:entity", "write:undo"],
    directWrites: { area: "on" }
  };
  const inbound = () => new Request("https://portal.test/mcp", { method: "POST", headers: { host: "portal.test" } });

  /** The revert route as the agent reaches it: the real revert command, run as that agent. */
  const revertRoutes: RouteLoader = async (template) =>
    template === "/api/commands/revert"
      ? {
          POST: async (request: Request) => {
            const body = (await request.json()) as Parameters<typeof runRevertCommand>[1];
            try {
              await runWithActor("claude", () => runRevertCommand(sql, body));
              return Response.json({ state: {} });
            } catch (error) {
              const status = error instanceof Error && error.name === "CommandConflictError" ? 409 : 400;
              return Response.json({ error: (error as Error).message }, { status });
            }
          }
        }
      : undefined;

  const undoRun = async (...extra: string[]) => {
    holder.loadRoute = revertRoutes;
    return runCliWithAgentJournal({
      argv: ["undo", ...extra, "--json"],
      actor: { kind: "agent", principal },
      inbound: inbound(),
      agent: "claude",
      store: await databaseJournalStore()
    });
  };

  it("lists the agent's ledger writes, undoes the newest and redoes it", async () => {
    const action = await createAction();
    const first = await agentSavesNotes(action, "First");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await agentSavesNotes(action, "Second", 2);

    const store = await databaseJournalStore();
    const loaded = await store!.load("claude");
    expect(loaded.map((entry) => [entry.id, entry.status, entry.serverChecked])).toEqual([
      [first, "applied", true],
      [second, "applied", true]
    ]);

    const undone = await undoRun();
    expect(undone.exitCode, undone.stderr.join("\n")).toBe(0);
    expect(await notesOf(action.id)).toBe("First");
    expect((await list()).changes.find((change) => change.id === second)!.status).toBe("undone");

    const redone = await undoRun("--redo");
    expect(redone.exitCode, redone.stderr.join("\n")).toBe(0);
    expect(await notesOf(action.id)).toBe("Second");
    expect((await list()).changes.find((change) => change.id === second)!.status).toBe("applied");
  });

  it("does not let the agent redo what the owner undid", async () => {
    const action = await createAction();
    const writeId = await agentSavesNotes(action, "Agent note");
    expect((await post(writeId)).status).toBe(200);
    const store = await databaseJournalStore();
    expect((await store!.load("claude"))[0]).toMatchObject({ status: "undone", undoneBy: "owner" });
    const redo = await undoRun("--redo");
    expect(redo.exitCode).not.toBe(0);
    expect(await notesOf(action.id)).toBeNull();
  });

  it("does not let the agent redo a changeset the owner undid", async () => {
    const action = await createAction();
    const one = await agentSavesNotes(action, "One");
    const two = await agentSavesNotes(action, "Two", 2);
    const set = await insertWrite({
      at: new Date().toISOString(),
      commandType: "changeset",
      state: "applied",
      response: { members: [one, two], undoable: [one, two] }
    });
    expect((await post(set)).status).toBe(200);
    expect(await notesOf(action.id)).toBeNull();
    const store = await databaseJournalStore();
    expect(await store!.load("claude")).toEqual([
      expect.objectContaining({ id: set, status: "undone", undoneBy: "owner" })
    ]);
    const redo = await undoRun("--redo");
    expect(redo.exitCode).not.toBe(0);
    expect(await notesOf(action.id)).toBeNull();
  });

  it("loads only the newest 100 of the agent's writes that kept something to put back, oldest first", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 101; index += 1)
      ids.push(
        await insertWrite({
          at: new Date(Date.parse("2026-10-28T00:00:00Z") + index * 1000).toISOString(),
          state: "applied"
        })
      );
    const store = await databaseJournalStore();
    const loaded = await store!.load("claude");
    expect(loaded.map((entry) => entry.id)).toEqual(ids.slice(1));
  });

  it("keeps another agent's writes out of this agent's list", async () => {
    const action = await createAction();
    await agentSavesNotes(action, "Other", 1, "someone-else");
    const store = await databaseJournalStore();
    expect(await store!.load("claude")).toEqual([]);
  });
});

describe("the change feed's provenance image", () => {
  it("is the image of the row's own table, not another that shares its id", async () => {
    const id = crypto.randomUUID();
    const writeId = crypto.randomUUID();
    await sql`INSERT INTO writes (id, user_id, command_type, actor, kind, state, images)
      VALUES (${writeId}, ${userId}, 'confirm', 'claude', 'confirm', 'applied', ${sql.json([
        { table: "captures", id, before: { status: "pending" }, after: { status: "confirmed", version: 7 } },
        { table: "commitments", id, before: null, after: { title: "Dentist", version: 1 } }
      ] as never)})`;
    await sql`INSERT INTO write_rows (write_id, user_id, entity_type, entity_id, operation)
      VALUES (${writeId}, ${userId}, 'commitment', ${id}, 'save')`;
    const feed = await readChangeFeed(sql, userId, {
      limit: 10,
      evidence: false,
      images: true
    });
    expect((feed as { changes: unknown[] }).changes[0]).toMatchObject({
      imageTable: "commitments",
      inserted: true,
      afterVersion: 1
    });
  });
});
