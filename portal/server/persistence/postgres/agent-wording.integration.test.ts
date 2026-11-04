import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { InvalidCommandError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { saveEntity } from "./entity-commands";
import { saveAction } from "./project-commands";
import { saveActionCommandSchema } from "@openrhen/contracts";

/**
 * What an agent reads when a save names a title where an id belongs, or leaves out a commitment buffer
 * (owner rule: an agent never has to guess).
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.WORDING_TEST_DATABASE_NAME, "openrhen_wording");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("WORDING_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

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

afterAll(async () => {
  await sql?.end();
});

const commitment = (extra: Record<string, unknown>) => ({
  commandId: crypto.randomUUID(),
  expectedVersion: null,
  type: "save_entity" as const,
  entityType: "commitment" as const,
  entity: {
    id: crypto.randomUUID(),
    title: "Dentist",
    status: "confirmed",
    startsAt: "2026-11-10T09:00:00+00:00",
    endsAt: "2026-11-10T10:00:00+00:00",
    ...extra
  }
});

describe("agent wording at the store", () => {
  const buffersOf = async (rawId: string) =>
    (
      await sql<{ setup_before_minutes: number; transition_after_minutes: number }[]>`
        SELECT setup_before_minutes, transition_after_minutes FROM commitments WHERE title = ${rawId}`
    )[0];

  it("a commitment without its buffers gets the owner's default buffers, not 0", async () => {
    await sql`UPDATE user_preferences SET default_setup_buffer_minutes = 15, default_transition_buffer_minutes = 20`;
    await saveEntity(sql, commitment({ title: "Buffers: neither sent" }) as never);
    expect(await buffersOf("Buffers: neither sent")).toEqual({
      setup_before_minutes: 15,
      transition_after_minutes: 20
    });
  });

  it("naming only one buffer defaults the other from the settings", async () => {
    await sql`UPDATE user_preferences SET default_setup_buffer_minutes = 15, default_transition_buffer_minutes = 20`;
    await saveEntity(sql, commitment({ title: "Buffers: one sent", setupBeforeMinutes: 0 }) as never);
    expect(await buffersOf("Buffers: one sent")).toEqual({ setup_before_minutes: 0, transition_after_minutes: 20 });
  });

  it("an explicit 0 is kept, and an update that leaves a buffer out keeps the stored one", async () => {
    await sql`UPDATE user_preferences SET default_setup_buffer_minutes = 15, default_transition_buffer_minutes = 20`;
    const created = commitment({ title: "Buffers: explicit", setupBeforeMinutes: 0, transitionAfterMinutes: 5 });
    await saveEntity(sql, created as never);
    expect(await buffersOf("Buffers: explicit")).toEqual({ setup_before_minutes: 0, transition_after_minutes: 5 });
    const version = (
      await sql<{ version: number }[]>`SELECT version FROM commitments WHERE title = 'Buffers: explicit'`
    )[0]!.version;
    await saveEntity(sql, {
      ...created,
      commandId: crypto.randomUUID(),
      expectedVersion: version,
      entity: {
        ...created.entity,
        title: "Buffers: explicit",
        setupBeforeMinutes: undefined,
        transitionAfterMinutes: undefined
      }
    } as never);
    expect(await buffersOf("Buffers: explicit")).toEqual({ setup_before_minutes: 0, transition_after_minutes: 5 });
  });

  it("F19: a title sent as projectId is called a title, not a record that no longer exists", async () => {
    const command = saveActionCommandSchema.parse({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      action: {
        id: crypto.randomUUID(),
        projectId: "Kids: end of semester admin",
        title: "E2E: x",
        status: "planned",
        optimisticMinutes: 30,
        expectedMinutes: 30,
        pessimisticMinutes: 30,
        remainingMinutes: 30,
        energy: "medium",
        minimumSessionMinutes: 15,
        maximumSessionMinutes: 60,
        splittable: true,
        setupMinutes: 0,
        importance: 3,
        consequence: 3,
        contexts: [],
        dependencyIds: []
      }
    });
    const error = await saveAction(sql, command).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidCommandError);
    const typed = error as InvalidCommandError;
    expect(typed.message).toContain("is not an id");
    expect(typed.message).not.toContain("no longer exists");
    expect(typed.message).toContain("rhen_search");
    expect(typed.nextCall).toMatchObject({ tool: "rhen_list", arguments: { entity: "projects" } });
  });
});
