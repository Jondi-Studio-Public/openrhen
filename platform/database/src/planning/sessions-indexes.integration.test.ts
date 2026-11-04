import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "../operations/integration-database.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.SESSIONS_INDEX_TEST_DATABASE_NAME,
  "openrhen_sessions_idx"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("SESSIONS_INDEX_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
const SESSION_COUNT = 6000;

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
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 2, connect_timeout: 10, fetch_types: false });
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  const users = await sql<
    { id: string }[]
  >`INSERT INTO users (display_name) VALUES ('Sessions Index Fixture') RETURNING id`;
  userId = users[0]!.id;
  // Many ended sessions spread over many distinct commitment targets, so an index is selective.
  await sql`
    INSERT INTO sessions (user_id, target_type, target_id, status, planned_started_at, planned_end_at, started_at, ended_at, planned_minutes, remaining_before_minutes)
    SELECT ${userId}, 'fixed_commitment', gen_random_uuid(), 'completed',
           now() - make_interval(mins => g), now() - make_interval(mins => g - 30),
           now() - make_interval(mins => g), now() - make_interval(mins => g - 30), 30, 30
    FROM generate_series(1, ${SESSION_COUNT}) AS g
  `;
  await sql`ANALYZE sessions`;
}, 120_000);

afterAll(async () => {
  await sql?.end();
});

/** Every plan node's relation and node type, from EXPLAIN (FORMAT JSON), for `sessions` only. */
async function sessionsScanNodes(query: string): Promise<string[]> {
  const rows = await sql.unsafe(`EXPLAIN (FORMAT JSON) ${query}`);
  const nodes: string[] = [];
  const walk = (plan: Record<string, unknown>) => {
    if (plan["Relation Name"] === "sessions") nodes.push(String(plan["Node Type"]));
    for (const child of (plan["Plans"] as Record<string, unknown>[] | undefined) ?? []) walk(child);
  };
  walk((rows[0] as unknown as { "QUERY PLAN": { Plan: Record<string, unknown> }[] })["QUERY PLAN"][0]!.Plan);
  return nodes;
}

describe("sessions indexes (F4-04)", () => {
  it("exists as the three lookup indexes", async () => {
    const rows = await sql<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE tablename = 'sessions'`;
    const defs = rows.map((r) => r.indexdef).join("\n");
    expect(defs).toMatch(/\(user_id, ended_at\)/);
    expect(defs).toMatch(/\(target_type, target_id\)/);
    expect(defs).toMatch(/\(occurrence_id\) WHERE \(occurrence_id IS NOT NULL\)/);
  });

  it("serves the routine-read per-commitment MAX(ended_at) lookup without a sequential scan", async () => {
    const target = (await sql<{ target_id: string }[]>`SELECT target_id FROM sessions LIMIT 1`)[0]!.target_id;
    const nodes = await sessionsScanNodes(
      `SELECT MAX(se.ended_at) FROM sessions se WHERE se.target_type='fixed_commitment' AND se.target_id='${target}'`
    );
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes).not.toContain("Seq Scan");
  });

  it("serves the per-user ended-session read without a sequential scan", async () => {
    const nodes = await sessionsScanNodes(
      `SELECT id FROM sessions WHERE user_id='${userId}' AND ended_at >= now() - interval '10 minutes'`
    );
    expect(nodes).not.toContain("Seq Scan");
  });

  it("serves the NOT EXISTS occurrence lookup without a sequential scan", async () => {
    const nodes = await sessionsScanNodes(`SELECT 1 FROM sessions WHERE occurrence_id = 'occ-that-is-dropped'`);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes).not.toContain("Seq Scan");
  });
});
