import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { planningEntityCommandSchema } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { CommandIdReusedError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { saveEntity } from "./entity-commands";
import { runSessionCommand } from "./session-commands";

/**
 * A command id is a receipt for one write. Sending it again with the same write replays; sending it with a
 * different payload or command type is refused instead of silently dropping the second write. Self-contained
 * `_test` database, same pattern as `create-undo.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.COMMAND_ID_REUSE_TEST_DATABASE_NAME,
  "openrhen_command_id_reuse"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("COMMAND_ID_REUSE_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

const commandId = "6f1c2f3e-0000-4000-8000-0000000000a1";

const saveArea = (name: string, id = commandId) =>
  saveEntity(
    sql,
    planningEntityCommandSchema.parse({
      commandId: id,
      type: "save_entity",
      entityType: "area",
      expectedVersion: null,
      entity: { id: "area-1", name, status: "active", sortOrder: 1 }
    })
  );

const receipt = async (id = commandId) =>
  (
    await sql<
      { command_type: string; request_hash: string | null }[]
    >`SELECT command_type, request_hash FROM writes WHERE id=${id}`
  )[0];

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
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, routine_preset_steps, routine_presets, spans, commitments, actions, projects, outcomes, areas, captures, sources, condition_definitions RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

describe("reusing a command id", () => {
  it("stores the hash of the write on its receipt", async () => {
    await saveArea("Home");
    const stored = await receipt();
    expect(stored?.command_type).toBe("area");
    expect(stored?.request_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replays the same write, whatever order its keys come in, and applies it once", async () => {
    const first = await saveArea("Home");
    const again = await saveEntity(
      sql,
      planningEntityCommandSchema.parse({
        entity: { sortOrder: 1, status: "active", name: "Home", id: "area-1" },
        expectedVersion: null,
        entityType: "area",
        type: "save_entity",
        commandId
      })
    );
    expect(again.areas).toEqual(first.areas);
    expect((await sql`SELECT id FROM writes WHERE id=${commandId}`).length).toBe(1);
  });

  it("refuses a different payload under the same id and keeps the first write", async () => {
    await saveArea("Home");
    await expect(saveArea("Work")).rejects.toBeInstanceOf(CommandIdReusedError);
    const names = await sql<{ name: string }[]>`SELECT name FROM areas`;
    expect(names.map((row) => row.name)).toEqual(["Home"]);
  });

  it("refuses a different kind of command under the same id", async () => {
    await saveArea("Home");
    await expect(
      runSessionCommand(sql, { commandId, type: "finish", sessionId: "s", at: new Date().toISOString() } as never)
    ).rejects.toBeInstanceOf(CommandIdReusedError);
  });

  it("still replays a receipt written before hashes were kept", async () => {
    await saveArea("Home");
    await sql`UPDATE writes SET request_hash = NULL WHERE id=${commandId}`;
    await expect(saveArea("Home")).resolves.toBeDefined();
    await expect(saveArea("Work")).resolves.toBeDefined();
    const names = await sql<{ name: string }[]>`SELECT name FROM areas`;
    expect(names.map((row) => row.name)).toEqual(["Home"]);
  });

  it("refuses the loser of a race too: the claim compares what the winner stored", async () => {
    const results = await Promise.allSettled([saveArea("Home"), saveArea("Work")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
    expect(refused?.reason).toBeInstanceOf(CommandIdReusedError);
  });
});

/**
 * The CLI fills a few fields from its own clock (`CLOCK_STAMPED` in command-receipt.ts). Repeating a command
 * "with the same --command-id" re-runs it, so the stamp is later; that must replay, not answer 409.
 */
describe("repeating a command the CLI stamps with its clock", () => {
  const newCapture = async () => {
    const captureId = crypto.randomUUID();
    const created = await saveEntity(
      sql,
      planningEntityCommandSchema.parse({
        commandId: crypto.randomUUID(),
        type: "save_entity",
        entityType: "capture",
        expectedVersion: null,
        entity: {
          id: captureId,
          text: "Call back",
          status: "pending",
          proposalType: "unclassified",
          proposedFields: {}
        }
      })
    );
    return { captureId, version: created.captures.find((item) => item.id === captureId)!.version ?? null };
  };

  it("replays an ignored capture sent again with a later reviewedAt, and refuses a changed field", async () => {
    const { captureId, version } = await newCapture();
    const ignore = (reviewedAt: string, proposalType = "unclassified") =>
      saveEntity(
        sql,
        planningEntityCommandSchema.parse({
          commandId,
          type: "save_entity",
          entityType: "capture",
          expectedVersion: version,
          entity: { id: captureId, status: "ignored", proposalType, proposedFields: {}, reviewedAt }
        })
      );
    await ignore("2026-10-28T01:00:00.000Z");
    await expect(ignore("2026-10-28T09:30:00.000Z")).resolves.toBeDefined();
    await expect(ignore("2026-10-28T09:30:00.000Z", "someday")).rejects.toBeInstanceOf(CommandIdReusedError);
    expect((await sql`SELECT id FROM writes WHERE id=${commandId}`).length).toBe(1);
  });

  it("replays a confirm (capture review) sent again, and refuses a changed draft", async () => {
    const { captureId, version } = await newCapture();
    const confirm = (title: string) =>
      saveEntity(
        sql,
        planningEntityCommandSchema.parse({
          commandId,
          type: "save_entity",
          entityType: "capture_review",
          expectedVersion: version,
          entity: { id: captureId, proposalType: "someday", draft: { title } }
        })
      );
    await confirm("Call back");
    await expect(confirm("Call back")).resolves.toBeDefined();
    await expect(confirm("Call someone else")).rejects.toBeInstanceOf(CommandIdReusedError);
  });

  it("replays a session start sent again, and refuses a changed plan for it", async () => {
    const userId = await ensureUser(sql);
    const area = await sql<
      { id: string }[]
    >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'Area','active',0) RETURNING id`;
    const outcome = await sql<
      { id: string }[]
    >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
    const project = await sql<
      { id: string }[]
    >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Project','active') RETURNING id`;
    const action = await sql<{ id: string; version: number }[]>`
      INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
      VALUES (${project[0]!.id},'Draft','one_off','active',30,60,90,60,'medium',15,90) RETURNING id, version`;
    const actionId = action[0]!.id;
    const now = new Date();
    await sql`
      INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
      VALUES (${userId},${crypto.randomUUID()},'v1','1','v1',${now},${new Date(now.getTime() + 3_600_000)},
        ${sql.json({
          contractVersion: "1",
          requestId: crypto.randomUUID(),
          inputVersion: "v1",
          engineVersion: "v1",
          calculatedAt: now.toISOString(),
          validUntil: new Date(now.getTime() + 3_600_000).toISOString(),
          derivedState: {
            sleepPlans: [],
            occurrences: [],
            routineSteps: [],
            commitmentRepeats: [],
            commitmentTimelines: [],
            stepPlacements: []
          },
          schedule: {},
          recommendation: {},
          currentDirective: { kind: "action", targetId: actionId, title: "Draft", recommendedMinutes: 30 },
          upcomingDirectives: [],
          continuation: null
        } as never)})`;
    // The CLI stamps no clock on a start (`startedAt` is only what the caller passed), so a re-run is the same command.
    const start = (plannedMinutes: number) =>
      runSessionCommand(sql, {
        commandId,
        type: "start",
        actionId,
        expectedVersion: action[0]!.version,
        plannedMinutes
      } as never);
    await start(30);
    await expect(start(30)).resolves.toBeDefined();
    await expect(start(45)).rejects.toBeInstanceOf(CommandIdReusedError);
    expect((await sql`SELECT id FROM sessions`).length).toBe(1);
  });
});

describe("repeating an update after the version moved", () => {
  const rename = (name: string, expectedVersion: number | null) =>
    saveEntity(
      sql,
      planningEntityCommandSchema.parse({
        commandId,
        type: "save_entity",
        entityType: "area",
        expectedVersion,
        entity: { id: "area-1", name, status: "active", sortOrder: 1 }
      })
    );

  it("replays the repeat the CLI sends with the new version, and refuses a changed field", async () => {
    const created = await saveEntity(
      sql,
      planningEntityCommandSchema.parse({
        commandId: crypto.randomUUID(),
        type: "save_entity",
        entityType: "area",
        expectedVersion: null,
        entity: { id: "area-1", name: "Home", status: "active", sortOrder: 1 }
      })
    );
    const version = created.areas[0]!.version ?? 1;
    await rename("Garden", version);
    // The first try landed and bumped the version; the repeat re-reads the record and sends the new one.
    await expect(rename("Garden", version + 1)).resolves.toBeDefined();
    await expect(rename("Shed", version + 1)).rejects.toBeInstanceOf(CommandIdReusedError);
    const names = await sql<{ name: string }[]>`SELECT name FROM areas`;
    expect(names.map((row) => row.name)).toEqual(["Garden"]);
  });
});
