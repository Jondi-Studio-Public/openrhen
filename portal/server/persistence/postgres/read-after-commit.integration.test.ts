import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { planningEntityCommandSchema } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";

// The answer's read is the one thing this suite makes fail; everything else runs against the real database.
const readFailure = vi.hoisted(() => ({ failNext: false }));
vi.mock("./state-read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state-read")>();
  return {
    ...actual,
    readPortalState: async (...args: Parameters<typeof actual.readPortalState>) => {
      // Only the read made on the pool, after the transaction: the one inside it (the planning evidence) is not this suite's subject.
      if (readFailure.failNext && typeof (args[0] as { begin?: unknown }).begin === "function") {
        readFailure.failNext = false;
        throw new Error("terminating connection due to administrator command");
      }
      return actual.readPortalState(...args);
    }
  };
});

import { CommittedReadFailedError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { saveEntity } from "./entity-commands";

/**
 * A write that committed but whose state read failed must not answer as though nothing landed. The error is a
 * `CommittedReadFailedError` (a route answers 503 with `committed: true`), the row is saved, and repeating the
 * command id replays the receipt and reads the state without saving a second copy. Self-contained `_test`
 * database, same pattern as `command-id-reuse.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.READ_AFTER_COMMIT_TEST_DATABASE_NAME,
  "openrhen_read_after_commit"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("READ_AFTER_COMMIT_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

const commandId = "6f1c2f3e-0000-4000-8000-0000000000b1";

const saveArea = () =>
  saveEntity(
    sql,
    planningEntityCommandSchema.parse({
      commandId,
      type: "save_entity",
      entityType: "area",
      expectedVersion: null,
      entity: { id: "area-1", name: "Home", status: "active", sortOrder: 1 }
    })
  );

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
  readFailure.failNext = false;
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, routine_preset_steps, routine_presets, spans, commitments, actions, projects, outcomes, areas, captures, sources, condition_definitions RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

describe("a write whose state read fails after it committed", () => {
  it("is reported as committed, keeps the row, and a repeat under the same id reads it back once", async () => {
    readFailure.failNext = true;
    await expect(saveArea()).rejects.toBeInstanceOf(CommittedReadFailedError);
    expect((await sql`SELECT id FROM areas`).length).toBe(1);

    const again = await saveArea();
    expect(again.areas.map((area) => area.name)).toEqual(["Home"]);
    expect((await sql`SELECT id FROM areas`).length).toBe(1);
    expect((await sql`SELECT id FROM writes WHERE id=${commandId}`).length).toBe(1);
  });

  it("is also reported as committed when the failing read is a replay's", async () => {
    await saveArea();
    readFailure.failNext = true;
    await expect(saveArea()).rejects.toBeInstanceOf(CommittedReadFailedError);
  });
});
