import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { ingestAgentSessionsSchema, type ReportedSession } from "@openrhen/contracts";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { ingestAgentSessions, readAgentTime, recordAgentCall } from "./agent-session-store";

/**
 * Agent time storage: calls become sessions split by a 30-minute idle gap, a reported
 * session is idempotent on the client's id per agent, and the reading counts overlapping time once. Self-contained
 * `_test` database, the same pattern as the agent token store's test.
 */
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.AGENT_SESSIONS_TEST_DATABASE_NAME,
  "openrhen_agent_sessions"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("AGENT_SESSIONS_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

const at = (hhmm: string) => new Date(`2026-10-26T${hhmm}:00.000Z`);
const reported = (id: string, from: string, to: string, extra: Partial<ReportedSession> = {}): ReportedSession =>
  ingestAgentSessionsSchema.parse({
    schemaVersion: 1,
    sessions: [{ id, startedAt: at(from).toISOString(), endedAt: at(to).toISOString(), ...extra }]
  }).sessions[0]!;

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
      migrationsFolder: fileURLToPath(new URL("../../platform/database/drizzle", import.meta.url))
    });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE agent_sessions RESTART IDENTITY CASCADE");
  await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

describe("recordAgentCall", () => {
  it("extends one session while the calls keep coming and opens a new one after a 30-minute gap", async () => {
    await recordAgentCall(sql, { agent: "companion", route: "/api/state", write: false }, at("09:00"));
    await recordAgentCall(sql, { agent: "companion", route: "/api/state", write: false }, at("09:20"));
    await recordAgentCall(sql, { agent: "companion", route: "/api/commands/session", write: true }, at("09:45"));
    await recordAgentCall(sql, { agent: "companion", route: "/api/state", write: false }, at("11:00"));
    const rows = await sql<
      {
        started_at: Date;
        ended_at: Date;
        request_count: number;
        write_count: number;
        touched: Record<string, number>;
      }[]
    >`SELECT started_at, ended_at, request_count, write_count, touched FROM agent_sessions ORDER BY started_at`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      started_at: at("09:00"),
      ended_at: at("09:45"),
      request_count: 3,
      write_count: 1,
      touched: { "/api/state": 2, "/api/commands/session": 1 }
    });
    expect(rows[1]).toMatchObject({ started_at: at("11:00"), ended_at: at("11:00"), request_count: 1 });
  });

  it("keeps each agent's sessions apart", async () => {
    await recordAgentCall(sql, { agent: "companion", route: "/api/state", write: false }, at("09:00"));
    await recordAgentCall(sql, { agent: "reasoner", route: "/api/state", write: false }, at("09:05"));
    const rows = await sql<{ agent: string }[]>`SELECT agent FROM agent_sessions ORDER BY agent`;
    expect(rows.map((row) => row.agent)).toEqual(["companion", "reasoner"]);
  });

  it("survives overlapping calls for one agent without splitting its session", async () => {
    await recordAgentCall(sql, { agent: "companion", route: "/api/state", write: false }, at("09:00"));
    await Promise.all(
      Array.from({ length: 5 }, () =>
        recordAgentCall(sql, { agent: "companion", route: "/api/changes", write: false }, at("09:10"))
      )
    );
    const [row] = await sql<{ request_count: number }[]>`SELECT request_count FROM agent_sessions`;
    expect(row!.request_count).toBe(6);
  });
});

describe("ingestAgentSessions", () => {
  it("creates, then reports an identical repost as unchanged and a changed one as updated", async () => {
    const first = reported("oc-1", "09:00", "09:30", { title: "Lockdown", topics: ["rhen"] });
    expect((await ingestAgentSessions(sql, "openclaw", [first])).results).toEqual([{ id: "oc-1", status: "created" }]);
    expect((await ingestAgentSessions(sql, "openclaw", [first])).results).toEqual([
      { id: "oc-1", status: "unchanged" }
    ]);
    const extended = reported("oc-1", "09:00", "10:15", { title: "Lockdown", topics: ["rhen"] });
    expect((await ingestAgentSessions(sql, "openclaw", [extended])).results).toEqual([
      { id: "oc-1", status: "updated" }
    ]);
    const rows = await sql<{ ended_at: Date; source: string }[]>`SELECT ended_at, source FROM agent_sessions`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ended_at: at("10:15"), source: "reported" });
  });

  it("scopes an id to its agent, so two agents may reuse one", async () => {
    await ingestAgentSessions(sql, "openclaw", [reported("s1", "09:00", "09:30")]);
    await ingestAgentSessions(sql, "claude-code", [reported("s1", "10:00", "10:30")]);
    expect(await sql`SELECT 1 FROM agent_sessions`).toHaveLength(2);
  });

  it("applies a batch in one transaction and in order", async () => {
    const result = await ingestAgentSessions(sql, "openclaw", [
      reported("a", "09:00", "09:30"),
      reported("b", "10:00", "10:30"),
      reported("a", "09:00", "09:45")
    ]);
    expect(result.results.map((entry) => entry.status)).toEqual(["created", "created", "updated"]);
    expect(await sql`SELECT 1 FROM agent_sessions`).toHaveLength(2);
  });
});

describe("readAgentTime", () => {
  it("counts a reported conversation and the calls made during it once, and lists the newest sessions", async () => {
    await ingestAgentSessions(sql, "openclaw", [
      reported("conv", "09:00", "10:00", { title: "Lockdown", topics: ["OpenRhen build"] })
    ]);
    await recordAgentCall(sql, { agent: "openclaw", route: "/api/state", write: false }, at("09:10"));
    await recordAgentCall(sql, { agent: "openclaw", route: "/api/state", write: false }, at("09:40"));
    await recordAgentCall(sql, { agent: "claude-code", route: "/api/state", write: false }, at("12:00"));
    await recordAgentCall(sql, { agent: "claude-code", route: "/api/state", write: false }, at("12:20"));
    const reading = await readAgentTime(sql, 7, at("18:00"));
    expect(reading.totalMinutes).toBe(80);
    expect(reading.agents).toEqual([
      { agent: "openclaw", minutes: 60, sessions: 2 },
      { agent: "claude-code", minutes: 20, sessions: 1 }
    ]);
    expect(reading.topics).toEqual([{ topic: "OpenRhen build", minutes: 60 }]);
    expect(reading.recent).toHaveLength(3);
    expect(reading.recent[0]).toMatchObject({ agent: "claude-code", source: "calls", requestCount: 2 });
  });

  it("ignores sessions older than the window", async () => {
    await ingestAgentSessions(sql, "openclaw", [reported("old", "09:00", "10:00")]);
    const reading = await readAgentTime(sql, 7, new Date("2026-11-20T00:00:00Z"));
    expect(reading.totalMinutes).toBe(0);
    expect(reading.recent).toEqual([]);
  });
});
