import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import type { RevertCommand } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { applyWorkspaceTool } from "@/server/deliverables/workspace-moves";
import { POST } from "@/app/api/deliverables/[id]/workspace/route";
import { AGENT_HEADER } from "@/server/agent-actor";
import { CommandConflictError } from "@/server/persistence/postgres/command-errors";
import { runRevertCommand } from "@/server/persistence/postgres/write-revert";
import type { WorkspaceToolCall } from "@/server/imports/openai-deliverable-chat";
import { getStateStore } from "@/server/persistence/state-store";
import { createSeedState, type PortalState } from "@/state/portal-state";

/**
 * An agent's deliverable workspace move (the `rhen_deliverable` tool on `/mcp`) is one deliverable save keyed on
 * the caller's command id: undone and redone through the server revert, replayable by id, refused as stale once the
 * deliverable changed since, and kept unimaged for the person's own move.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_workspace_move_undo");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

const revert = (target: string, direction: "undo" | "redo", force?: boolean): RevertCommand => ({
  commandId: crypto.randomUUID(),
  target,
  direction,
  ...(force === undefined ? {} : { force })
});

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
  process.env.DATABASE_URL = testUrl.toString();
}, 30_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE users, user_preferences, deliverables, deliverable_chat_messages, projects, outcomes, areas CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

async function seedDeliverable(): Promise<PortalState["deliverables"][number]> {
  const store = getStateStore();
  await store.put(createSeedState(new Date("2026-08-25T00:00:00.000Z")));
  const project = (await store.get())! as PortalState;
  const state = await store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion: null,
    type: "save_entity",
    entityType: "deliverable",
    entity: {
      id: crypto.randomUUID(),
      projectId: project.projects[0]!.id,
      title: "Assessment 2",
      status: "needs_breakdown",
      uncertainty: "some",
      importance: 5,
      consequence: 5,
      steps: [
        {
          id: "step-model",
          title: "Create the model",
          status: "planned",
          optimisticMinutes: 20,
          expectedMinutes: 30,
          pessimisticMinutes: 45,
          remainingMinutes: 30,
          energy: "medium",
          minimumSessionMinutes: 15,
          maximumSessionMinutes: 60
        }
      ],
      criteria: [],
      blockers: []
    }
  });
  return state.deliverables.find((item) => item.title === "Assessment 2")!;
}

async function seedSecondDeliverable(first: PortalState["deliverables"][number]) {
  const state = await getStateStore().saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion: null,
    type: "save_entity",
    entityType: "deliverable",
    entity: { id: crypto.randomUUID(), projectId: first.projectId, title: "Assessment 3", status: "needs_breakdown" }
  } as never);
  return state.deliverables.find((item) => item.title === "Assessment 3")!;
}

const blockerCall = (description: string): WorkspaceToolCall => ({
  name: "record_blocker",
  report: { description, category: "waiting_on_someone", stepTitles: [] }
});

const blockersOf = async (id: string) =>
  ((await getStateStore().get()) as PortalState).deliverables.find((item) => item.id === id)!.blockers;

describe("an agent's workspace move against a real database", () => {
  it("undoes and redoes the move whole, under the caller's command id", async () => {
    const deliverable = await seedDeliverable();
    const commandId = crypto.randomUUID();
    await runWithActor("claude", () =>
      applyWorkspaceTool(deliverable.id, blockerCall("Waiting for the rubric."), { requireSession: false, commandId })
    );
    expect(await blockersOf(deliverable.id)).toHaveLength(1);
    expect(await getStateStore().hasSnapshot(commandId)).toBe(true);
    expect(await getStateStore().hasCommandReceipt(commandId)).toBe(true);

    await runWithActor("claude", () => runRevertCommand(sql, revert(commandId, "undo")));
    expect(await blockersOf(deliverable.id)).toHaveLength(0);
    await runWithActor("claude", () => runRevertCommand(sql, revert(commandId, "redo")));
    expect(await blockersOf(deliverable.id)).toHaveLength(1);
  });

  it("refuses the undo once the deliverable changed after the move, and changes nothing", async () => {
    const deliverable = await seedDeliverable();
    const commandId = crypto.randomUUID();
    await runWithActor("claude", () =>
      applyWorkspaceTool(deliverable.id, blockerCall("Waiting for the rubric."), { requireSession: false, commandId })
    );
    await runWithActor("claude", () =>
      applyWorkspaceTool(deliverable.id, blockerCall("Waiting for the teacher."), {
        requireSession: false,
        commandId: crypto.randomUUID()
      })
    );
    await expect(runWithActor("claude", () => runRevertCommand(sql, revert(commandId, "undo")))).rejects.toBeInstanceOf(
      CommandConflictError
    );
    expect(await blockersOf(deliverable.id)).toHaveLength(2);
  });

  it("keeps no images for the person's own move", async () => {
    const deliverable = await seedDeliverable();
    const commandId = crypto.randomUUID();
    await runWithActor(null, () =>
      applyWorkspaceTool(deliverable.id, blockerCall("Waiting for the rubric."), { requireSession: false, commandId })
    );
    expect(await blockersOf(deliverable.id)).toHaveLength(1);
    expect(await getStateStore().hasSnapshot(commandId)).toBe(false);
    expect(await getStateStore().hasCommandReceipt(commandId)).toBe(true);
  });
});

describe("a repeated workspace move through the route", () => {
  const send = (id: string, call: WorkspaceToolCall, commandId: string) =>
    POST(
      new Request("http://x", {
        method: "POST",
        headers: { [AGENT_HEADER]: "claude" },
        body: JSON.stringify({ call, commandId })
      }),
      { params: Promise.resolve({ id }) }
    );

  it("replays the same move under its id, and refuses the id for any other write", async () => {
    const deliverable = await seedDeliverable();
    const other = await seedSecondDeliverable(deliverable);
    const commandId = crypto.randomUUID();
    const first = await send(deliverable.id, blockerCall("Waiting for the rubric."), commandId);
    expect(first.status).toBe(200);
    expect((await first.json()).revertible).toBe(commandId);

    const again = await send(deliverable.id, blockerCall("Waiting for the rubric."), commandId);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ applied: true, replayed: true, revertible: commandId });
    expect(await blockersOf(deliverable.id)).toHaveLength(1);

    // A different move, a move on another deliverable and an id from an ordinary save are all someone else's receipt.
    expect((await send(deliverable.id, blockerCall("Waiting for the teacher."), commandId)).status).toBe(409);
    expect((await send(other.id, blockerCall("Waiting for the rubric."), commandId)).status).toBe(409);
    const saved = (await getStateStore().get()) as PortalState;
    const saveId = crypto.randomUUID();
    await getStateStore().saveEntity({
      commandId: saveId,
      expectedVersion: other.version ?? null,
      type: "save_entity",
      entityType: "deliverable",
      entity: { ...(saved.deliverables.find((item) => item.id === other.id) as object), title: "Renamed" }
    } as never);
    expect((await send(deliverable.id, blockerCall("Waiting for the rubric."), saveId)).status).toBe(409);
    expect(await blockersOf(deliverable.id)).toHaveLength(1);
  });
});
