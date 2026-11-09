import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { hostedUsageLast24Hours, recordModelCall } from "./derived-model-calls-store";

/** The audit rows the call policy writes and the 24-hour usage the caps and the settings card read. */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_model_calls");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
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
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "../platform/database/drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

const row = (over: Partial<Parameters<typeof recordModelCall>[2]> = {}) => ({
  sourceEventKey: "mail:1",
  tier: "t3" as const,
  model: "Qwen/Qwen3-14B",
  tokensIn: 100,
  tokensOut: 20,
  reason: "ok",
  ...over
});

describe("derived model calls store", () => {
  it("counts hosted sends and tokens from the last 24 hours only", async () => {
    await recordModelCall(sql, userId, row());
    await recordModelCall(sql, userId, row({ tokensIn: 50, tokensOut: 5, reason: "timeout" }));
    await sql`INSERT INTO derived_model_calls (user_id, source_event_key, at, tier, model, tokens_in, tokens_out, reason)
              VALUES (${userId}, 'old', now() - interval '25 hours', 't3', 'm', 999, 999, 'ok')`;
    await recordModelCall(sql, userId, row({ tier: "t2", model: "qwen3:8b", tokensIn: 1000 }));
    expect(await hostedUsageLast24Hours(sql, userId)).toEqual({ messages: 2, tokens: 175 });
  });

  it("keeps people apart and reports zero when nothing was sent", async () => {
    expect(await hostedUsageLast24Hours(sql, userId)).toEqual({ messages: 0, tokens: 0 });
    const [other] = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Second') RETURNING id`;
    await recordModelCall(sql, other!.id, row());
    expect(await hostedUsageLast24Hours(sql, userId)).toEqual({ messages: 0, tokens: 0 });
  });

  it("refuses an over-long text instead of truncating the audit", async () => {
    await expect(recordModelCall(sql, userId, row({ reason: "x".repeat(201) }))).rejects.toThrow();
  });
});
