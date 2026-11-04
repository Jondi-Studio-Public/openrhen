import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { runWithActor } from "@/server/agent-actor";
import { readAgentChangeDetail } from "./agent-change-detail";
import { readChangeFeed } from "./change-feed";
import { saveProject } from "./project-commands";

/** The detail of one write read back from the ledger: images give before/after, titles come from the actions table, and an unrelated write is absent. */
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.AGENT_CHANGE_DETAIL_TEST_DATABASE_NAME,
  "openrhen_agent_change_detail"
);
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("AGENT_CHANGE_DETAIL_TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

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
      migrationsFolder: fileURLToPath(new URL("../../../../platform/database/drizzle", import.meta.url))
    });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
}, 30_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, planning_runs, commitments, condition_definitions, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

const MINUTE = 60_000;

async function storeRun(calculatedAt: Date, inputVersion: string): Promise<void> {
  const requestId = crypto.randomUUID();
  const validUntil = new Date(calculatedAt.getTime() + 60 * MINUTE);
  await sql`
    INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result,superseded_at)
    VALUES (${userId},${requestId},${inputVersion},'1','v1',${calculatedAt},${validUntil},
    ${sql.json({
      contractVersion: "1",
      requestId,
      inputVersion,
      engineVersion: "v1",
      calculatedAt: calculatedAt.toISOString(),
      validUntil: validUntil.toISOString(),
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
      currentDirective: { kind: "none", title: "Nothing", recommendedMinutes: 0 },
      upcomingDirectives: [],
      continuation: null
    } as never)},${calculatedAt})`;
}

async function insertWrite(options: {
  owner?: string;
  createdAt?: Date;
  images?: unknown;
  entityType?: string;
  entityId?: string | null;
  evidence?: Record<string, unknown>;
}): Promise<string> {
  const writeId = crypto.randomUUID();
  const owner = options.owner ?? userId;
  await sql`INSERT INTO writes (id, user_id, command_type, actor, kind, images, state, created_at)
    VALUES (${writeId}, ${owner}, 'x', 'companion', ${options.images ? "session" : null}, ${options.images ? sql.json(options.images as never) : null}, ${options.images ? "applied" : null}, ${options.createdAt ?? new Date()})`;
  await sql`INSERT INTO write_rows (write_id, user_id, entity_type, entity_id, operation, evidence)
    VALUES (${writeId}, ${owner}, ${options.entityType ?? "commitment"}, ${options.entityId ?? null}, 'save', ${sql.json((options.evidence ?? {}) as never)})`;
  return writeId;
}

describe("readAgentChangeDetail", () => {
  it("reads a write's allowed field changes, basis, evidence, and hides engine columns", async () => {
    const writeId = crypto.randomUUID();
    const actionId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const images = [
      {
        table: "actions",
        id: actionId,
        before: {
          id: actionId,
          title: "Write",
          expected_minutes: 30,
          version: 1,
          project_id: crypto.randomUUID(),
          sort_order: 1
        },
        after: {
          id: actionId,
          title: "Write",
          expected_minutes: 45,
          version: 2,
          project_id: crypto.randomUUID(),
          sort_order: 2
        }
      },
      {
        table: "sessions",
        id: sessionId,
        before: null,
        after: { id: sessionId, action_id: actionId, status: "done", recommendation_id: "r" }
      }
    ];
    await sql`INSERT INTO writes (id, user_id, command_type, actor, kind, images, state) VALUES (${writeId}, ${userId}, 'action', 'companion', 'session', ${sql.json(images as never)}, 'applied')`;
    await sql`INSERT INTO write_rows (write_id, user_id, entity_type, entity_id, operation, evidence)
      VALUES (${writeId}, ${userId}, 'action', ${actionId}, 'save', ${sql.json({ basis: "stated", statedEvidence: "make it 45", inputVersion: "v1" } as never)})`;

    const detail = await readAgentChangeDetail(sql, userId, writeId);
    expect(detail).toMatchObject({ writeId, actor: "companion", kind: "session", state: "applied" });
    expect(detail!.rows).toHaveLength(2);
    expect(detail!.rows[0]).toMatchObject({
      entityType: "action",
      title: "Write",
      basis: "stated",
      statedEvidence: "make it 45"
    });
    // sort_order is bookkeeping; the two project ids resolve to "a removed project" rather than a bare uuid.
    expect(detail!.rows[0]!.fields).toEqual([
      { field: "expected_minutes", before: 30, after: 45, afterKnown: true },
      { field: "project_id", before: "a removed project", after: "a removed project", afterKnown: true }
    ]);
    expect(detail!.rows[1]).toMatchObject({ entityType: "sessions", operation: "create", title: null });
    expect(detail!.rows[1]!.fields.map((f) => f.field)).toEqual(["status", "action_id"].sort());
    expect(detail!.plan.available).toBe(false);
  });

  it("falls back to the recorded before values when no image was kept", async () => {
    const commitmentId = crypto.randomUUID();
    await sql`INSERT INTO commitments (id, user_id, title, starts_at, ends_at) VALUES (${commitmentId}, ${userId}, 'Plan trip', now(), now() + interval '1 hour')`;
    const writeId = await insertWrite({
      entityId: commitmentId,
      evidence: { before: { title: "Old", version: 3, recommendation_id: "r" } }
    });
    const detail = await readAgentChangeDetail(sql, userId, writeId);
    expect(detail!.rows[0]).toMatchObject({
      title: "Plan trip",
      fields: [{ field: "title", before: "Old", after: null, afterKnown: false }]
    });
  });

  it("answers null for a missing write and for another user's write", async () => {
    expect(await readAgentChangeDetail(sql, userId, crypto.randomUUID())).toBeNull();
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    const theirs = await insertWrite({ owner: other });
    expect(await readAgentChangeDetail(sql, userId, theirs)).toBeNull();
    expect(await readAgentChangeDetail(sql, other, theirs)).not.toBeNull();
  });

  it("diffs the plan before and after when the run for the write's input exists", async () => {
    const at = new Date(Date.now() - 30 * MINUTE);
    await storeRun(new Date(at.getTime() - 10 * MINUTE), "v-before");
    await storeRun(new Date(at.getTime() + MINUTE), "v-after");
    const writeId = await insertWrite({ createdAt: at, evidence: { inputVersion: "v-after" } });
    const { plan } = (await readAgentChangeDetail(sql, userId, writeId))!;
    expect(plan).toMatchObject({ available: true, pending: false, reason: null });
    expect(plan.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("does not borrow a later run with a different input version", async () => {
    const at = new Date(Date.now() - 30 * MINUTE);
    await storeRun(new Date(at.getTime() - 10 * MINUTE), "v-before");
    await storeRun(new Date(at.getTime() + MINUTE), "v-someone-else");
    const writeId = await insertWrite({ createdAt: at, evidence: { inputVersion: "v-mine" } });
    const { plan } = (await readAgentChangeDetail(sql, userId, writeId))!;
    expect(plan).toMatchObject({ available: false, pending: true, reason: "pending" });
  });

  it("calls an old write with no matching run pruned", async () => {
    const at = new Date(Date.now() - 3 * 60 * MINUTE);
    await storeRun(new Date(at.getTime() - 10 * MINUTE), "v-before");
    const writeId = await insertWrite({ createdAt: at, evidence: { inputVersion: "v-gone" } });
    expect((await readAgentChangeDetail(sql, userId, writeId))!.plan).toMatchObject({
      available: false,
      pending: false,
      reason: "pruned"
    });
  });

  it("resolves a place and a project id to names", async () => {
    await sql`INSERT INTO condition_definitions (user_id, id, name, kind) VALUES (${userId}, 'home', 'Home base', 'location')`;
    const area = (
      await sql<
        { id: string }[]
      >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'A','active',1) RETURNING id`
    )[0]!.id;
    const outcome = (
      await sql<
        { id: string }[]
      >`INSERT INTO outcomes (area_id,title,definition_of_done) VALUES (${area},'O','Done') RETURNING id`
    )[0]!.id;
    const project = (
      await sql<
        { id: string }[]
      >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome},'Renovation','active') RETURNING id`
    )[0]!.id;
    const id = crypto.randomUUID();
    const writeId = await insertWrite({
      entityId: id,
      images: [
        {
          table: "commitments",
          id,
          before: { id, title: "Dentist", location_id: null, project_id: null },
          after: { id, title: "Dentist", location_id: "home", project_id: project }
        }
      ]
    });
    const row = (await readAgentChangeDetail(sql, userId, writeId))!.rows[0]!;
    expect(row.fields).toEqual([
      { field: "location_id", before: null, after: "Home base", afterKnown: true },
      { field: "project_id", before: null, after: "Renovation", afterKnown: true }
    ]);
  });

  it("explains a write made by a real agent command from its recorded evidence", async () => {
    const area = (
      await sql<
        { id: string }[]
      >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'A','active',1) RETURNING id`
    )[0]!.id;
    const outcome = (
      await sql<
        { id: string }[]
      >`INSERT INTO outcomes (area_id,title,definition_of_done) VALUES (${area},'O','Done') RETURNING id`
    )[0]!.id;
    const id = crypto.randomUUID();
    const command = (title: string, expectedVersion: number | null) => ({
      commandId: crypto.randomUUID(),
      expectedVersion,
      project: {
        id,
        outcomeId: outcome,
        title,
        status: "active" as const,
        uncertainty: "some" as const,
        consequence: 3
      }
    });
    await runWithActor("scribe", () => saveProject(sql, command("First", null)));
    const second = command("Second", 1);
    await runWithActor("scribe", () => saveProject(sql, second), undefined, { basis: "stated", evidence: "rename it" });
    const detail = await readAgentChangeDetail(sql, userId, second.commandId);
    expect(detail).toMatchObject({ actor: "scribe" });
    expect(detail!.rows[0]).toMatchObject({
      entityType: "project",
      title: "Second",
      basis: "stated",
      statedEvidence: "rename it"
    });
    // An agent's project save now keeps row images (write-snapshot.ts), so the after value is known.
    expect(detail!.rows[0]!.fields).toEqual([{ field: "title", before: "First", after: "Second", afterKnown: true }]);
  });

  it("adds the image facts to the change feed only when asked", async () => {
    const id = crypto.randomUUID();
    await insertWrite({
      entityId: id,
      images: [{ table: "commitments", id, before: null, after: { id, title: "New", version: 1 } }]
    });
    const plain = await readChangeFeed(sql, userId, { limit: 10, evidence: false });
    const withImages = await readChangeFeed(sql, userId, { limit: 10, evidence: false, images: true });
    if (!("changes" in plain) || !("changes" in withImages)) throw new Error("expected pages");
    expect(plain.changes[0]).not.toHaveProperty("imageTable");
    expect(withImages.changes[0]).toMatchObject({ imageTable: "commitments", inserted: true, afterVersion: 1 });
  });
});
