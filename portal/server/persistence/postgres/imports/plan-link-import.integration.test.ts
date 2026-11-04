import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import type { ImportField, ImportRecord } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "../ensure-user";
import { createManualLink, decideLink, listPlanMap } from "../plan-map-store";
import { commitRecords } from "./commit-records";
import { resolveOperations } from "./key-resolution";

/**
 * The `plan_link` import entity: create-only, written confirmed through the
 * same checks as a link made by hand, refusing invalid ends, missing ends and rejected pairs as record
 * errors, and never deleting. Its own `_test` database, so it belongs to `corepack pnpm test:integration`.
 */

config({ path: fileURLToPath(new URL("../../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.PLAN_LINK_IMPORT_TEST_DATABASE_NAME,
  "openrhen_plan_link_import"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("PLAN_LINK_IMPORT_TEST_DATABASE_NAME must be an identifier ending in _test");
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
  sql = postgres(testUrl.toString(), { max: 4, connect_timeout: 10, fetch_types: false, prepare: true });
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users, user_preferences, portal_state CASCADE");
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

async function createProject(title: string): Promise<string> {
  const area = await sql<{ id: string }[]>`
    INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<{ id: string }[]>`
    INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<{ id: string }[]>`
    INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},${title},'active') RETURNING id`;
  return project[0]!.id;
}

function field(value: unknown): ImportField {
  return value === null || value === undefined
    ? { value: null, basis: "missing", confidence: null, evidence: [], needsReview: false, source: "cell" }
    : { value, basis: "explicit", confidence: "high", evidence: [], needsReview: false, source: "cell" };
}

function linkRecord(
  importKey: string,
  fields: Record<string, unknown>,
  overrides: Partial<ImportRecord> = {}
): ImportRecord {
  return {
    id: crypto.randomUUID(),
    importKey,
    entityType: "plan_link",
    operation: "create",
    expectedVersion: null,
    matchedEntityId: null,
    fields: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, field(value)])),
    relationships: {},
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: 0,
    ...overrides
  };
}

const commit = (records: ImportRecord[]) =>
  sql.begin(async (tx) => commitRecords(tx as unknown as typeof sql, userId, records));

describe("plan_link import", () => {
  it("previews a valid link as a create and commits it confirmed, with its weight and evidence", async () => {
    const first = await createProject("First");
    const second = await createProject("Second");
    const [resolved] = await resolveOperations(sql, userId, [
      linkRecord("link-1", {
        fromType: "project",
        fromId: first,
        toType: "project",
        toId: second,
        kind: "before",
        weight: 0.5,
        evidence: ["same term"]
      })
    ]);
    expect(resolved).toMatchObject({ operation: "create", errors: [] });
    await commit([resolved!]);
    const map = await listPlanMap(sql, userId);
    expect(map.links).toHaveLength(1);
    expect(map.links[0]).toMatchObject({
      fromId: first,
      toId: second,
      kind: "before",
      status: "confirmed",
      proposer: "owner",
      weight: 0.5,
      evidence: ["same term"]
    });
    // Committing the same record again is harmless: the confirmed link comes back unchanged.
    await commit([resolved!]);
    expect((await listPlanMap(sql, userId)).links).toHaveLength(1);
  });

  it("rejects invalid kind ends, a self link and a missing end as record errors", async () => {
    const project = await createProject("Only");
    const resolved = await resolveOperations(sql, userId, [
      linkRecord("bad-ends", { fromType: "project", fromId: project, toType: "contact", toId: "x", kind: "before" }),
      linkRecord("self", { fromType: "project", fromId: project, toType: "project", toId: project, kind: "before" }),
      linkRecord("missing", {
        fromType: "project",
        fromId: project,
        toType: "project",
        toId: crypto.randomUUID(),
        kind: "before"
      }),
      linkRecord("incomplete", { fromType: "project", fromId: project, kind: "before" })
    ]);
    expect(resolved.map((record) => record.operation)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    expect(resolved[0]!.errors.join(" ")).toContain("cannot end at a contact");
    expect(resolved[1]!.errors.join(" ")).toContain("itself");
    expect(resolved[2]!.errors.join(" ")).toContain("exists");
    expect(resolved[3]!.errors.join(" ")).toContain("toType is required");
  });

  it("rejects a pair that was rejected, and fails a commit that raced a rejection", async () => {
    const first = await createProject("First");
    const second = await createProject("Second");
    const input = { fromType: "project", fromId: first, toType: "project", toId: second, kind: "before" } as const;
    const created = await createManualLink(sql, userId, input);
    if (!created.ok) throw new Error("setup failed");
    await decideLink(sql, userId, created.link.id, "reject");
    const [resolved] = await resolveOperations(sql, userId, [linkRecord("again", input)]);
    expect(resolved).toMatchObject({ operation: "rejected" });
    expect(resolved!.errors.join(" ")).toContain("rejected");
    // A record previewed as a create before the rejection fails the whole commit and leaves the pair rejected.
    await expect(commit([linkRecord("raced", input)])).rejects.toThrow(/could not be created/);
    expect((await listPlanMap(sql, userId)).links[0]).toMatchObject({ status: "rejected" });
  });

  it("never deletes: a delete record is rejected and removes nothing", async () => {
    const first = await createProject("First");
    const second = await createProject("Second");
    const input = { fromType: "project", fromId: first, toType: "project", toId: second, kind: "before" } as const;
    await createManualLink(sql, userId, input);
    const [resolved] = await resolveOperations(sql, userId, [linkRecord("del", input, { operation: "delete" })]);
    expect(resolved).toMatchObject({ operation: "rejected" });
    await commit([{ ...resolved!, operation: "delete" }]);
    expect((await listPlanMap(sql, userId)).links).toHaveLength(1);
  });
});
