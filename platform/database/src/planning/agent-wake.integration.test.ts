import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { enqueueAgentWake } from "./agent-wake.js";
import { integrationDatabaseName } from "../operations/integration-database.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.AGENT_WAKE_TEST_DATABASE_NAME, "openrhen_agent_wake");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("AGENT_WAKE_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
const now = new Date("2026-11-04T01:00:00.000Z");

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabaseName} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${testDatabaseName}`);
  await admin.end();
  sql = postgres(testUrl.toString(), { max: 4 });
  await migrate(drizzle(sql), { migrationsFolder: resolve(process.cwd(), "drizzle") });
});

beforeEach(async () => {
  await sql`TRUNCATE agent_wakes`;
  await sql`DELETE FROM users`;
  const rows = await sql<
    { id: string }[]
  >`INSERT INTO users (display_name, timezone) VALUES ('Wake Fixture', 'Australia/Sydney') RETURNING id`;
  userId = rows[0]!.id;
});

afterAll(async () => {
  await sql?.end();
  const admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabaseName} WITH (FORCE)`);
  await admin.end();
});

describe("enqueueAgentWake", () => {
  it("adds one pending row with the event's own lifetime", async () => {
    expect(await enqueueAgentWake(sql, { userId, event: "check_in_unanswered", targetId: "c1", now })).toBe(true);
    expect(
      await enqueueAgentWake(sql, { userId, event: "pulse_lapsed", targetId: "2026-11-04T00:30:00.000Z", now })
    ).toBe(true);
    const rows = await sql<{ event: string; status: string; attempts: number; expires_at: Date | string }[]>`
      SELECT event, status, attempts, expires_at FROM agent_wakes ORDER BY event`;
    expect(rows.map((row) => [row.event, row.status, row.attempts])).toEqual([
      ["check_in_unanswered", "pending", 0],
      ["pulse_lapsed", "pending", 0]
    ]);
    expect(new Date(rows[0]!.expires_at).getTime() - now.getTime()).toBe(10 * 60_000);
    expect(new Date(rows[1]!.expires_at).getTime() - now.getTime()).toBe(60 * 60_000);
  });

  it("adds nothing for the same event and target a second time", async () => {
    expect(await enqueueAgentWake(sql, { userId, event: "check_in_unanswered", targetId: "c1", now })).toBe(true);
    expect(await enqueueAgentWake(sql, { userId, event: "check_in_unanswered", targetId: "c1", now })).toBe(false);
    expect(await enqueueAgentWake(sql, { userId, event: "check_in_unanswered", targetId: "c2", now })).toBe(true);
    const rows = await sql<{ count: string }[]>`SELECT count(*) FROM agent_wakes`;
    expect(Number(rows[0]!.count)).toBe(2);
  });

  it("works inside a transaction that rolls back", async () => {
    await sql
      .begin(async (tx) => {
        await enqueueAgentWake(tx, { userId, event: "pulse_lapsed", targetId: "x", now });
        throw new Error("roll back");
      })
      .catch(() => undefined);
    const rows = await sql<{ count: string }[]>`SELECT count(*) FROM agent_wakes`;
    expect(Number(rows[0]!.count)).toBe(0);
  });

  it("refuses an unknown event or status", async () => {
    await expect(
      sql`INSERT INTO agent_wakes (user_id,event,target_id,dedupe_key,expires_at) VALUES (${userId},'nope','a','a',${now})`
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO agent_wakes (user_id,event,target_id,dedupe_key,expires_at,status) VALUES (${userId},'pulse_lapsed','a','a',${now},'stuck')`
    ).rejects.toThrow();
  });
});
