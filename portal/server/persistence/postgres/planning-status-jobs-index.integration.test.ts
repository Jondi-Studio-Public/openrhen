import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { PLAN_FORECAST_JOB_TYPE } from "@openrhen/database";
import { readPlanning } from "./readers/planning-status";
import { readPlanningStatus } from "./state-read";

/**
 * The plan-job lookups run inside every state read and status poll. Each job row carries a large TOASTed
 * payload, so `payload->>'userId'` without an index detoasts every job (36 ms at 255 rows, growing).
 * Self-contained `_test` database, same pattern as `command-id-reuse.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.PLANNING_STATUS_JOBS_TEST_DATABASE_NAME,
  "openrhen_planning_status_jobs"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("PLANNING_STATUS_JOBS_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

let userId: string;

async function seedJob(i: number, status: string, createdAgoMinutes: number, capturedAgoMinutes: number) {
  const created = new Date(Date.now() - createdAgoMinutes * 60_000);
  const captured = new Date(Date.now() - capturedAgoMinutes * 60_000);
  await sql`
    INSERT INTO jobs (type,payload,idempotency_key,status,created_at,available_at)
    VALUES (${PLAN_FORECAST_JOB_TYPE},
      ${sql.json({ userId, stateCapturedAt: captured.toISOString(), filler: "x".repeat(20_000) + i } as never)},
      ${`job-${i}`},${status},${created},${created})
  `;
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
  await sql.unsafe("TRUNCATE TABLE jobs");
});

afterAll(async () => {
  await sql?.end();
});

describe("plan job lookups", () => {
  it("can answer the per-user job lookups from an index on the payload's userId", async () => {
    for (let i = 0; i < 40; i += 1) await seedJob(i, "completed", i + 1, i + 1);
    await sql`ANALYZE jobs`;
    // Force the planner off a sequential scan: this asks whether an index COULD serve the lookup, which is
    // what stops it detoasting every payload once the table is large enough for the planner to prefer one.
    const plan = await sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      const rows = await tx<{ "QUERY PLAN": string }[]>`
        EXPLAIN SELECT status FROM jobs
        WHERE type=${PLAN_FORECAST_JOB_TYPE} AND payload->>'userId'=${userId}
          AND status NOT IN ('pending','running','retrying')
        ORDER BY created_at DESC LIMIT 1
      `;
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toMatch(/Index Cond:.*userId/);
  });

  it("still reports the job whose state was captured last when it was created a little earlier", async () => {
    for (let i = 0; i < 55; i += 1) await seedJob(i, "completed", i + 1, i + 1);
    // More than 50 jobs exist, so the 50-row window is exercised. Created 25 minutes ago (inside the newest 50) but captured the newest state, and failed: this is the latest finished job.
    await seedJob(100, "failed", 25, 0);
    const status = await readPlanningStatus(sql);
    expect(status.lastFinishedStatus).toBe("failed");
    const planning = await readPlanning(sql, userId);
    expect(planning).toBeDefined();
  });
});
