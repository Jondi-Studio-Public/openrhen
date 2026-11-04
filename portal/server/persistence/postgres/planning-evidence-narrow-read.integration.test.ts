import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { planningEntityCommandSchema } from "@openrhen/contracts";
import { buildPlanForecastRequest, integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { saveEntity } from "./entity-commands";
import { readPortalState } from "./state-read";

/**
 * F6-01: a write's planning evidence needs the plan input, never the ~583 KB engine result. The in-transaction
 * state read must not select `planning_runs.result`, and the request it builds must be the one the full read builds.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.PLANNING_EVIDENCE_NARROW_TEST_DATABASE_NAME,
  "openrhen_evidence_narrow"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("PLANNING_EVIDENCE_NARROW_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let queries: string[] = [];
let userId: string;

const resultSelects = () => queries.filter((text) => /FROM planning_runs/i.test(text) && /\bresult\b/i.test(text));

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
  sql = postgres(testUrl.toString(), {
    max: 5,
    connect_timeout: 10,
    fetch_types: false,
    prepare: true,
    debug: (_connection, query) => {
      queries.push(query);
    }
  });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, planning_runs, routine_preset_steps, routine_presets, spans, commitments, actions, projects, outcomes, areas, captures, sources, condition_definitions RESTART IDENTITY CASCADE"
  );
  queries = [];
});

afterAll(async () => {
  await sql?.end();
});

const storePlanningRun = async () => {
  const now = new Date();
  const requestId = crypto.randomUUID();
  await sql`
    INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
    VALUES (${userId},${requestId},'v1','1','v1',${now},${new Date(now.getTime() + 3_600_000)},
      ${sql.json({
        contractVersion: "1",
        requestId,
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
        currentDirective: { kind: "none", title: "Nothing", recommendedMinutes: 0 },
        upcomingDirectives: [],
        continuation: null
      } as never)})
  `;
};

describe("a write's planning evidence", () => {
  it("does not read the engine result in its own transaction, only once for the reply", async () => {
    await storePlanningRun();
    queries = [];
    await saveEntity(
      sql,
      planningEntityCommandSchema.parse({
        commandId: "6f1c2f3e-0000-4000-8000-0000000000c1",
        type: "save_entity",
        entityType: "area",
        expectedVersion: null,
        entity: { id: "area-1", name: "Home", status: "active", sortOrder: 1 }
      })
    );
    // One read remains: the reply's state after commit. The transaction's read used to be a second.
    expect(resultSelects()).toHaveLength(1);
  });
});

describe("readPortalState without the planning block", () => {
  it("omits planning, keeps the recommendation id, and builds the same forecast request", async () => {
    await storePlanningRun();
    const full = (await readPortalState(sql))!;
    const narrow = (await readPortalState(sql, { planning: false }))!;
    expect(full.planning?.result).toBeDefined();
    expect(narrow.planning).toBeUndefined();
    // `horizonEnd` is read from the wall clock on each call, so it differs by milliseconds.
    const { planning: _planning, horizonEnd: _fullHorizon, ...rest } = full;
    const { horizonEnd: _narrowHorizon, ...narrowRest } = narrow;
    expect(narrowRest).toEqual(rest);
    const at = new Date("2026-11-04T10:00:00Z");
    narrow.horizonEnd = full.horizonEnd;
    const fromFull = await buildPlanForecastRequest(full, at, undefined, sql, userId);
    const fromNarrow = await buildPlanForecastRequest(narrow, at, undefined, sql, userId);
    expect({ ...fromNarrow, requestId: "x" }).toEqual({ ...fromFull, requestId: "x" });
    expect(fromNarrow.inputVersion).toBe(fromFull.inputVersion);
  });
});
