import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { ensureUser } from "./ensure-user";
import { runActivityCommand } from "./activity-commands";
import { saveProject } from "./project-commands";
import { recordStateChange } from "./planning-evidence";
import { readChangeFeed, type ChangeFeedQuery, type ChangeFeedRow } from "./change-feed";

/**
 * Agent identity and audit: `writes.actor` and the
 * before-image an agent's write stores, `sessions.started_by`, and the `GET /api/changes` feed's
 * filters, paging and counts. Self-contained `_test` database, the same pattern as
 * `backfilled-start.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.AGENT_AUDIT_TEST_DATABASE_NAME, "openrhen_agent_audit");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("AGENT_AUDIT_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
let outcomeId: string;

const projectCommand = (id: string, title: string, expectedVersion: number | null) => ({
  commandId: crypto.randomUUID(),
  expectedVersion,
  project: {
    id,
    outcomeId,
    title,
    status: "active" as const,
    uncertainty: "some" as const,
    consequence: 3
  }
});

const save = (actor: string | null | "none", id: string, title: string, expectedVersion: number | null) => {
  const run = () => saveProject(sql, projectCommand(id, title, expectedVersion));
  return actor === "none" ? run() : runWithActor(actor, run);
};

async function feed(query: Partial<ChangeFeedQuery> = {}) {
  const result = await readChangeFeed(sql, userId, { limit: 50, evidence: true, ...query });
  if (!("changes" in result)) throw new Error("expected a page of changes");
  return result;
}

async function changeRows(entityId: string) {
  return sql<
    { actor: string | null; evidence: Record<string, unknown> }[]
  >`SELECT w.actor, r.evidence FROM write_rows r JOIN writes w ON w.id=r.write_id WHERE r.entity_type='project' AND r.entity_id=${entityId} ORDER BY r.created_at, r.id`;
}

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
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, session_segments, sessions, routine_steps, planning_runs, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
  const area = await sql<{ id: string }[]>`
    INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'Audit','active',1) RETURNING id`;
  const outcome = await sql<{ id: string }[]>`
    INSERT INTO outcomes (area_id,title,definition_of_done) VALUES (${area[0]!.id},'Outcome','Done') RETURNING id`;
  outcomeId = outcome[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

describe("write_rows actor and before-image", () => {
  it("stamps the agent and stores a before-image only for an agent's update", async () => {
    const id = crypto.randomUUID();
    await save("scribe", id, "First", null);
    await save("scribe", id, "Second", 1);
    await save(null, id, "Third", 2);

    const [created, updated, byPerson] = await changeRows(id);
    expect(created).toMatchObject({ actor: "scribe", evidence: { before: null } });
    expect(updated!.actor).toBe("scribe");
    expect(updated!.evidence.before).toMatchObject({ id, version: 1, title: "First" });
    // Only what the write changed is kept: the status was saved unchanged, so it is absent.
    expect(updated!.evidence.before).not.toHaveProperty("status");
    expect(byPerson!.actor).toBeNull();
    expect(byPerson!.evidence).not.toHaveProperty("before");
    expect(byPerson!.evidence).not.toHaveProperty("beforeMissing");
  });

  it("stamps system when no request is in scope", async () => {
    const id = crypto.randomUUID();
    await save("none", id, "Background", null);
    const [row] = await changeRows(id);
    expect(row!.actor).toBe("system");
    expect(row!.evidence).not.toHaveProperty("before");
  });
});

describe("sessions.started_by", () => {
  async function startActivity(actor: string | null) {
    const stepId = crypto.randomUUID();
    await sql`
      INSERT INTO routine_steps (id,user_id,anchor_type,anchor_id,purpose,title,duration_minutes,sequence,timing_rule,status)
      VALUES (${stepId},${userId},'sleep_plan',${crypto.randomUUID()},'wake','Prep',10,0,'contiguous','pending')`;
    const now = new Date();
    await sql`DELETE FROM planning_runs`;
    await sql`DELETE FROM session_segments`;
    await sql`DELETE FROM sessions`;
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
        currentDirective: { kind: "routine_step", targetId: stepId, title: "Prep", recommendedMinutes: 10 },
        upcomingDirectives: [],
        continuation: null
      } as never)})`;
    const version = await sql<{ version: number }[]>`SELECT version FROM routine_steps WHERE id=${stepId}`;
    const commandId = crypto.randomUUID();
    await runWithActor(actor, () =>
      runActivityCommand(sql, {
        commandId,
        expectedVersion: version[0]!.version,
        type: "start_activity",
        targetType: "routine_step",
        targetId: stepId,
        plannedMinutes: 10
      })
    );
    const rows = await sql<{ started_by: string | null }[]>`SELECT started_by FROM sessions WHERE id=${commandId}`;
    return rows[0]!.started_by;
  }

  it("records the agent that started a session, and null for a person", async () => {
    expect(await startActivity("scribe")).toBe("scribe");
    expect(await startActivity(null)).toBeNull();
  });
});

describe("readChangeFeed", () => {
  /** Newest first: system Q, human P v3, scribe P v2, scribe P v1. */
  async function seed() {
    const p = crypto.randomUUID();
    const q = crypto.randomUUID();
    await save("scribe", p, "P1", null);
    await save("scribe", p, "P2", 1);
    await save(null, p, "P3", 2);
    await save("none", q, "Q", null);
    return { p, q };
  }

  it("filters by agent, human and system", async () => {
    await seed();
    expect((await feed({ agent: "scribe" })).changes.map((c) => c.actor)).toEqual(["scribe", "scribe"]);
    expect((await feed({ agent: "human" })).changes.map((c) => c.actor)).toEqual([null]);
    expect((await feed({ agent: "system" })).changes.map((c) => c.actor)).toEqual(["system"]);
    expect((await feed({ agent: "nobody" })).changes).toEqual([]);
  });

  it("reports beforeRecorded only for the agent's update", async () => {
    await seed();
    const { changes } = await feed();
    expect(changes.filter((c) => c.beforeRecorded)).toHaveLength(1);
    const recorded = changes.find((c) => c.beforeRecorded)!;
    expect(recorded.actor).toBe("scribe");
    expect(recorded.evidence?.before).toMatchObject({ title: "P1" });
    expect((await feed({ evidence: false })).changes.every((c) => c.evidence === undefined)).toBe(true);
  });

  it("pages with the cursor without overlap", async () => {
    await seed();
    const ids: string[] = [];
    let before: ChangeFeedQuery["before"];
    for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
      const page = await feed({ limit: 2, ...(before ? { before } : {}) });
      expect(page.changes).toHaveLength(2);
      ids.push(...page.changes.map((c: ChangeFeedRow) => c.id));
      if (page.cursor === null) break;
      const [createdAt, id] = page.cursor.split("~");
      before = { createdAt: new Date(createdAt!), id: id! };
    }
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(before).toBeDefined();
    const last = await feed({ limit: 2, before: before! });
    expect(last.changes).toHaveLength(2);
    expect(last.cursor).toBeNull();
  });

  it("keeps the response shape for a mixed history of commands and writes with no command id", async () => {
    const { p } = await seed();
    // A writer with no client command id (location, travel spend, an ingest job, state replace) gets a
    // server-made write; its row reads like any other.
    await runWithActor(null, () =>
      sql.begin((tx) =>
        recordStateChange(tx, userId, {
          entityType: "journey_samples",
          entityId: "home:office",
          operation: "measure",
          evidence: { minutes: 20 },
          at: new Date()
        })
      )
    );
    const { changes, cursor } = await feed();
    expect(cursor).toBeNull();
    expect(changes).toHaveLength(5);
    for (const change of changes)
      expect(Object.keys(change)).toEqual([
        "id",
        "at",
        "entityType",
        "entityId",
        "operation",
        "actor",
        "commandId",
        "beforeRecorded",
        "evidence"
      ]);
    const measured = changes[0]!;
    expect(measured).toMatchObject({
      entityType: "journey_samples",
      entityId: "home:office",
      operation: "measure",
      actor: null,
      beforeRecorded: false
    });
    expect(measured.evidence).toMatchObject({ minutes: 20 });
    // Its command id is the server-made write's id, which names exactly this row.
    const [write] = await sql<
      { id: string; command_type: string }[]
    >`SELECT id, command_type FROM writes WHERE id=${measured.commandId!}`;
    expect(write).toEqual({ id: measured.commandId, command_type: "journey_samples" });
    // The project rows carry their command's id, one write per command, and the agent's before-image.
    const projectRows = changes.filter((c) => c.entityId === p);
    expect(new Set(projectRows.map((c) => c.commandId)).size).toBe(3);
    expect(projectRows.filter((c) => c.beforeRecorded)).toHaveLength(1);
    expect(changes.map((c) => c.at)).toEqual(
      changes
        .map((c) => c.at)
        .sort()
        .reverse()
    );
  });

  it("counts by agent and by entity", async () => {
    await seed();
    const byAgent = await readChangeFeed(sql, userId, { limit: 1, evidence: false, count: { by: "agent" } });
    expect(byAgent).toEqual({
      total: 4,
      counts: [
        { value: "scribe", count: 2 },
        { value: "human", count: 1 },
        { value: "system", count: 1 }
      ]
    });
    const byEntity = await readChangeFeed(sql, userId, { limit: 1, evidence: false, count: { by: "entity" } });
    expect(byEntity).toEqual({ total: 4, counts: [{ value: "project", count: 4 }] });
  });
});
