import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { getStateStore } from "@/server/persistence/state-store";
import { withDeliverableChatStore } from "@/server/persistence/postgres/deliverable-chat-store";
import { applyWorkspaceTool, revertDeliverableToPreTurnSnapshot } from "@/server/deliverables/workspace-moves";

/**
 * Finding 22: a chat turn's workspace-tool writes commit to the deliverable aggregate as soon as the
 * model calls them, not at the end of the turn — but the turn's own reply is only appended to the
 * transcript once the whole turn finishes. If the turn fails partway (a refusal, a dropped stream, the
 * tool-round budget), an earlier tool's write was already real and persisted while the transcript never
 * records the turn happening at all, so the next turn would reason from stored state the conversation
 * never actually agreed to. `route.ts`'s stream handler now compensates for this — see
 * `revertDeliverableToPreTurnSnapshot` — by putting the deliverable's content back to what it held
 * before the failed turn started. This proves that mechanism against a real database, the way the route
 * itself drives it: apply a real tool write, then either simulate the turn failing (revert, and confirm
 * no assistant transcript entry exists) or simulate it succeeding (append the reply, and confirm both
 * survive).
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_deliverable_chat_turn");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

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
  const created = state.deliverables.find((item) => item.title === "Assessment 2")!;
  // applyWorkspaceTool refuses to touch a deliverable the active session does not currently own
  // (route.ts's own staleness guard), so the session has to be real. `NormalizedPostgresStateStore.put`
  // only ever writes an action-targeted `activeSession` back to `sessions` (it has no `target_id`/
  // `target_type` in its INSERT), so a deliverable-targeted one is seeded directly the way the
  // deliverable session-start command itself would leave it.
  const userRows = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
  const userId = userRows[0]!.id;
  await sql`
    INSERT INTO sessions (
      id, user_id, target_type, target_id, target_title, status,
      planned_started_at, planned_end_at, started_at, planned_minutes, active_minutes, remaining_before_minutes
    ) VALUES (
      gen_random_uuid(), ${userId}, 'deliverable', ${created.id}, ${created.title}, 'running',
      now(), now() + interval '30 minutes', now(), 30, 0, 0
    )
  `;
  return created;
}

describe("a deliverable chat turn's writes against a real database", () => {
  it("leaves no trace of an earlier tool's write once the turn fails and is reverted", async () => {
    const preTurn = await seedDeliverable();
    const userMessage = await withDeliverableChatStore((store) =>
      store.append(preTurn.id, "user", "The teacher says it's blocked on Moodle.", [])
    );

    // Round one of the turn: the model calls record_blocker, and it really writes.
    await applyWorkspaceTool(
      preTurn.id,
      {
        name: "record_blocker",
        report: {
          description: "Waiting for the teacher to unlock the Moodle submission.",
          category: "waiting_on_someone",
          stepTitles: []
        }
      },
      { requireSession: true }
    );
    const midTurn = (await getStateStore().get())! as PortalState;
    expect(midTurn.deliverables.find((item) => item.id === preTurn.id)?.blockers).toHaveLength(1);

    // Round two dies (a refusal, a dropped stream, the tool-round budget) — the turn as a whole fails,
    // so route.ts never appends an assistant reply and instead compensates.
    await revertDeliverableToPreTurnSnapshot(preTurn.id, preTurn);

    const after = (await getStateStore().get())! as PortalState;
    const reverted = after.deliverables.find((item) => item.id === preTurn.id)!;
    expect(reverted.blockers).toHaveLength(0);
    expect(reverted.steps).toEqual(preTurn.steps);

    const history = await withDeliverableChatStore((store) => store.list(preTurn.id));
    expect(history.map((message) => message.id)).toEqual([userMessage.id]);
    expect(history.every((message) => message.role === "user")).toBe(true);
  });

  it("commits both the tool's write and the transcript entry when the turn succeeds", async () => {
    const preTurn = await seedDeliverable();
    const userMessage = await withDeliverableChatStore((store) =>
      store.append(preTurn.id, "user", "The teacher says it's blocked on Moodle.", [])
    );

    await applyWorkspaceTool(
      preTurn.id,
      {
        name: "record_blocker",
        report: {
          description: "Waiting for the teacher to unlock the Moodle submission.",
          category: "waiting_on_someone",
          stepTitles: []
        }
      },
      { requireSession: true }
    );
    // The turn finishes normally: route.ts appends the assistant's reply once streamDeliverableChat
    // resolves, and no revert ever runs.
    const assistantMessage = await withDeliverableChatStore((store) =>
      store.append(preTurn.id, "assistant", "Recorded — that step stays excluded until it clears.", [])
    );

    const after = (await getStateStore().get())! as PortalState;
    expect(after.deliverables.find((item) => item.id === preTurn.id)?.blockers).toHaveLength(1);
    const history = await withDeliverableChatStore((store) => store.list(preTurn.id));
    expect(history.map((message) => message.id)).toEqual([userMessage.id, assistantMessage.id]);
  });

  it("is a no-op when nothing actually changed the stored version since the snapshot", async () => {
    const preTurn = await seedDeliverable();
    await revertDeliverableToPreTurnSnapshot(preTurn.id, preTurn);
    const after = (await getStateStore().get())! as PortalState;
    expect(after.deliverables.find((item) => item.id === preTurn.id)?.version).toBe(preTurn.version);
  });
});
