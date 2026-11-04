import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import type { ImportField, ImportRecord } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "../ensure-user";
import { readPrerequisiteMap } from "../prerequisites";
import { commitRecords } from "./commit-records";
import { resolveOperations } from "./key-resolution";

/**
 * The `entity_prerequisite` import entity: every edge the two dependency
 * entities cannot hold, resolved by import key, written through the prerequisite helpers, refusing a cycle,
 * and never removing an edge an omitted row left alone. Its own `_test` database, so it belongs to `corepack pnpm test:integration`.
 */

config({ path: fileURLToPath(new URL("../../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.ENTITY_PREREQUISITE_IMPORT_TEST_DATABASE_NAME,
  "openrhen_entity_prerequisite_import"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ENTITY_PREREQUISITE_IMPORT_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

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
    await migrate(drizzle(migrationSql), {
      migrationsFolder: fileURLToPath(new URL("../../../../../platform/database/drizzle", import.meta.url))
    });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 4, connect_timeout: 10, prepare: true });
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users, user_preferences, portal_state CASCADE");
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

type Kind = "project" | "deliverable" | "action";

/** One project with a deliverable and an action, each mapped by import key (`<prefix>-project` and so on). */
async function seed(prefix: string) {
  const area = await sql<{ id: string }[]>`
    INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<{ id: string }[]>`
    INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<{ id: string }[]>`
    INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},${prefix},'active') RETURNING id`;
  const deliverable = await sql<{ id: string }[]>`
    INSERT INTO deliverables (project_id,title) VALUES (${project[0]!.id},${prefix}) RETURNING id`;
  const action = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${project[0]!.id},${prefix},'one_off','active',10,20,30,20,'medium',10,30) RETURNING id`;
  const ids: Record<Kind, string> = {
    project: project[0]!.id,
    deliverable: deliverable[0]!.id,
    action: action[0]!.id
  };
  for (const kind of ["project", "deliverable", "action"] as const) {
    await sql`INSERT INTO import_entity_keys (user_id,entity_type,import_key,entity_id) VALUES (${userId},${kind},${`${prefix}-${kind}`},${ids[kind]})`;
  }
  await sql`INSERT INTO import_entity_keys (user_id,entity_type,import_key,entity_id) VALUES (${userId},'outcome',${`${prefix}-outcome`},${outcome[0]!.id})`;
  return ids;
}

function field(value: unknown): ImportField {
  return { value, basis: "explicit", confidence: "high", evidence: [], needsReview: false, source: "cell" };
}

function edge(importKey: string, entityKind: Kind, entityKey: string, requiresKind: Kind, requiresKey: string) {
  return {
    id: crypto.randomUUID(),
    importKey,
    entityType: "entity_prerequisite",
    operation: "create",
    expectedVersion: null,
    matchedEntityId: null,
    fields: {
      entityKind: field(entityKind),
      entityKey: field(entityKey),
      requiresKind: field(requiresKind),
      requiresKey: field(requiresKey)
    },
    relationships: {},
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: 0
  } as ImportRecord;
}

const commit = (records: ImportRecord[]) =>
  sql.begin(async (tx) => commitRecords(tx as unknown as typeof sql, userId, records));

describe("entity_prerequisite import", () => {
  it("previews edges between stored records as creates and commits them", async () => {
    const a = await seed("a");
    const b = await seed("b");
    const resolved = await resolveOperations(sql, userId, [
      edge("e1", "action", "a-action", "project", "b-project"),
      edge("e2", "deliverable", "a-deliverable", "action", "b-action"),
      edge("e3", "project", "a-project", "project", "b-project")
    ]);
    expect(resolved.map((record) => [record.operation, record.errors])).toEqual([
      ["create", []],
      ["create", []],
      ["create", []]
    ]);
    await commit(resolved);
    const map = await readPrerequisiteMap(sql, userId);
    expect(map.get(`action:${a.action}`)).toEqual([{ kind: "project", id: b.project }]);
    expect(map.get(`deliverable:${a.deliverable}`)).toEqual([{ kind: "action", id: b.action }]);
    expect(map.get(`project:${a.project}`)).toEqual([{ kind: "project", id: b.project }]);
  });

  it("leaves stored edges alone when the batch does not mention them, and adds without duplicating", async () => {
    const a = await seed("a");
    const b = await seed("b");
    const c = await seed("c");
    await commit(await resolveOperations(sql, userId, [edge("e1", "action", "a-action", "project", "b-project")]));
    const second = await resolveOperations(sql, userId, [
      edge("e1", "action", "a-action", "project", "b-project"),
      edge("e2", "action", "a-action", "deliverable", "c-deliverable")
    ]);
    await commit(second);
    // A batch that names an unrelated edge keeps both of the first action's edges.
    await commit(await resolveOperations(sql, userId, [edge("e3", "project", "b-project", "project", "c-project")]));
    const map = await readPrerequisiteMap(sql, userId);
    expect(map.get(`action:${a.action}`)).toEqual(
      expect.arrayContaining([
        { kind: "project", id: b.project },
        { kind: "deliverable", id: c.deliverable }
      ])
    );
    expect(map.get(`action:${a.action}`)).toHaveLength(2);
    expect(map.get(`project:${b.project}`)).toEqual([{ kind: "project", id: c.project }]);
  });

  it("rejects an unmapped key and a same-kind action edge as record errors", async () => {
    await seed("a");
    const resolved = await resolveOperations(sql, userId, [
      edge("e1", "action", "a-action", "project", "nowhere"),
      edge("e2", "action", "a-action", "action", "a-action")
    ]);
    expect(resolved.map((record) => record.operation)).toEqual(["rejected", "rejected"]);
    expect(resolved[0]!.errors.join(" ")).toContain("requires_key does not resolve");
    expect(resolved[1]!.errors.join(" ")).toContain("Dependencies sheet");
  });

  it("fails the commit, writing nothing, when an edge closes a loop with stored edges", async () => {
    const a = await seed("a");
    await seed("b");
    await commit(
      await resolveOperations(sql, userId, [edge("e1", "action", "a-action", "deliverable", "b-deliverable")])
    );
    const closing = await resolveOperations(sql, userId, [
      edge("e2", "deliverable", "b-deliverable", "action", "a-action")
    ]);
    expect(closing[0]).toMatchObject({ operation: "create", errors: [] });
    await expect(commit(closing)).rejects.toThrow(/cycle/);
    const map = await readPrerequisiteMap(sql, userId);
    expect(map.get(`action:${a.action}`)).toHaveLength(1);
    expect([...map.keys()].filter((key) => key.startsWith("deliverable:"))).toEqual([]);
  });

  it("writes an edge whose ends are created in the same batch", async () => {
    const a = await seed("a");
    const records: ImportRecord[] = [
      {
        ...edge("e1", "project", "a-project", "project", "new-project"),
        sortOrder: 1
      },
      {
        id: crypto.randomUUID(),
        importKey: "new-project",
        entityType: "project",
        operation: "create",
        expectedVersion: null,
        matchedEntityId: null,
        fields: {
          title: field("New"),
          status: field("active"),
          uncertainty: field("some"),
          consequence: field(3)
        },
        relationships: { outcomeKey: "a-outcome" },
        errors: [],
        warnings: [],
        removed: false,
        sortOrder: 0
      }
    ];
    const resolved = await resolveOperations(sql, userId, records);
    expect(resolved.map((record) => record.errors)).toEqual([[], []]);
    await commit(resolved);
    const map = await readPrerequisiteMap(sql, userId);
    const created = await sql<{ id: string }[]>`SELECT id FROM projects WHERE title='New'`;
    expect(map.get(`project:${a.project}`)).toEqual([{ kind: "project", id: created[0]!.id }]);
  });
});
