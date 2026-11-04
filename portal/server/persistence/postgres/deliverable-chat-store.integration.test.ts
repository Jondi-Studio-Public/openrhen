import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { createSeedState } from "@/state/portal-state";
import { NormalizedPostgresStateStore } from "./state-store";
import { DeliverableChatStore } from "./deliverable-chat-store";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_deliverable_chat_store");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

const fixedNow = new Date();

let sql: postgres.Sql;
let store: NormalizedPostgresStateStore;
let chatStore: DeliverableChatStore;
let deliverableId: string;

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
  store = new NormalizedPostgresStateStore(sql);
  chatStore = new DeliverableChatStore(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users, portal_state, jobs RESTART IDENTITY CASCADE");

  // Seed initial state and create a deliverable
  await store.put(createSeedState(fixedNow));
  const state = (await store.get())!;
  const project = state.projects[0]!;

  deliverableId = crypto.randomUUID();
  await store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion: null,
    type: "save_entity",
    entityType: "deliverable",
    entity: {
      id: deliverableId,
      projectId: project.id,
      title: "Test Deliverable",
      status: "needs_breakdown",
      uncertainty: "some",
      importance: 5,
      consequence: 5,
      steps: [],
      criteria: [],
      blockers: []
    }
  });
});

afterAll(async () => {
  await sql?.end();
});

describe("DeliverableChatStore", () => {
  it("appends an external row with meta and list returns it with that meta", async () => {
    const message = await chatStore.append(deliverableId, "external", "Picked up in Claude Desktop", [], {
      kind: "pick_up",
      tool: "Claude Desktop"
    });

    expect(message.role).toBe("external");
    expect(message.meta).toEqual({ kind: "pick_up", tool: "Claude Desktop" });

    const messages = await chatStore.list(deliverableId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "external",
      meta: { kind: "pick_up", tool: "Claude Desktop" }
    });
  });

  it("appends user and assistant messages without meta, and list returns them without meta key", async () => {
    await chatStore.append(deliverableId, "user", "Hello", [], undefined);
    await chatStore.append(deliverableId, "assistant", "Hi there", [], undefined);

    const messages = await chatStore.list(deliverableId);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: "Hello"
      })
    );
    expect(messages[0]).not.toHaveProperty("meta");
    expect(messages[1]).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: "Hi there"
      })
    );
    expect(messages[1]).not.toHaveProperty("meta");
  });

  it("coordinationState reports handedOff: false, tool: null, since: null, lastDropOffSummary: null before any external row", async () => {
    const state = await chatStore.coordinationState(deliverableId);

    expect(state).toEqual({
      handedOff: false,
      tool: null,
      since: null,
      lastDropOffSummary: null
    });
  });

  it("after appending a pick_up external row, coordinationState reports handedOff: true with tool and since", async () => {
    const message = await chatStore.append(deliverableId, "external", "Picked up in Claude Desktop", [], {
      kind: "pick_up",
      tool: "Claude Desktop"
    });

    const state = await chatStore.coordinationState(deliverableId);

    expect(state.handedOff).toBe(true);
    expect(state.tool).toBe("Claude Desktop");
    expect(state.since).toBe(message.createdAt);
    expect(state.lastDropOffSummary).toBeNull();
  });

  it("after then appending a drop_off external row with non-empty content, coordinationState reports handedOff: false and lastDropOffSummary", async () => {
    await chatStore.append(deliverableId, "external", "Picked up in Claude Desktop", [], {
      kind: "pick_up",
      tool: "Claude Desktop"
    });

    const dropOffSummary = "Decided on the approach, completed steps A and B, still need step C";
    await chatStore.append(deliverableId, "external", dropOffSummary, [], { kind: "drop_off", tool: "Claude Desktop" });

    const state = await chatStore.coordinationState(deliverableId);

    expect(state.handedOff).toBe(false);
    expect(state.tool).toBeNull();
    expect(state.since).toBeNull();
    expect(state.lastDropOffSummary).toBe(dropOffSummary);
  });

  it("after a further pick_up by a different tool, coordinationState reflects the new tool and handedOff: true, while lastDropOffSummary persists", async () => {
    await chatStore.append(deliverableId, "external", "Picked up in Claude Desktop", [], {
      kind: "pick_up",
      tool: "Claude Desktop"
    });

    const dropOffSummary = "Completed steps A and B";
    await chatStore.append(deliverableId, "external", dropOffSummary, [], { kind: "drop_off", tool: "Claude Desktop" });

    const message = await chatStore.append(deliverableId, "external", "Picked up in Claude Code", [], {
      kind: "pick_up",
      tool: "Claude Code"
    });

    const state = await chatStore.coordinationState(deliverableId);

    expect(state.handedOff).toBe(true);
    expect(state.tool).toBe("Claude Code");
    expect(state.since).toBe(message.createdAt);
    expect(state.lastDropOffSummary).toBe(dropOffSummary);
  });

  it("a drop_off appended with empty content does not become lastDropOffSummary, and the field stays as the last non-empty drop-off", async () => {
    const firstDropOffSummary = "Step A completed";
    await chatStore.append(deliverableId, "external", "Picked up in Claude Desktop", [], {
      kind: "pick_up",
      tool: "Claude Desktop"
    });

    await chatStore.append(deliverableId, "external", firstDropOffSummary, [], {
      kind: "drop_off",
      tool: "Claude Desktop"
    });

    await chatStore.append(deliverableId, "external", "Picked up in Claude Code", [], {
      kind: "pick_up",
      tool: "Claude Code"
    });

    // Append an empty drop-off
    await chatStore.append(deliverableId, "external", "", [], { kind: "drop_off", tool: "Claude Code" });

    const state = await chatStore.coordinationState(deliverableId);

    expect(state.handedOff).toBe(false);
    expect(state.lastDropOffSummary).toBe(firstDropOffSummary);
  });

  it("a drop_off with only whitespace is treated as empty and does not become lastDropOffSummary", async () => {
    const firstDropOffSummary = "Step A completed";
    await chatStore.append(deliverableId, "external", "Picked up", [], { kind: "pick_up", tool: "Claude Desktop" });

    await chatStore.append(deliverableId, "external", firstDropOffSummary, [], {
      kind: "drop_off",
      tool: "Claude Desktop"
    });

    await chatStore.append(deliverableId, "external", "Picked up again", [], { kind: "pick_up", tool: "Claude Code" });

    // Append a drop-off with only whitespace
    await chatStore.append(deliverableId, "external", "   \n\t  ", [], { kind: "drop_off", tool: "Claude Code" });

    const state = await chatStore.coordinationState(deliverableId);

    expect(state.lastDropOffSummary).toBe(firstDropOffSummary);
  });
});
