import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { cancelPendingAttentionWakes, enqueueAgentWake, runAttentionWakeTick } from "./agent-wake.js";
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
    expect(
      await enqueueAgentWake(sql, { userId, event: "pulse_unknown", targetId: "2026-11-04T00:40:00.000Z", now })
    ).toBe(true);
    const rows = await sql<{ event: string; status: string; attempts: number; expires_at: Date | string }[]>`
      SELECT event, status, attempts, expires_at FROM agent_wakes ORDER BY event`;
    expect(rows.map((row) => [row.event, row.status, row.attempts])).toEqual([
      ["check_in_unanswered", "pending", 0],
      ["pulse_lapsed", "pending", 0],
      ["pulse_unknown", "pending", 0]
    ]);
    expect(await enqueueAgentWake(sql, { userId, event: "attention_waiting", targetId: now.toISOString(), now })).toBe(
      true
    );
    const attention = await sql<
      { expires_at: Date | string }[]
    >`SELECT expires_at FROM agent_wakes WHERE event='attention_waiting'`;
    expect(new Date(attention[0]!.expires_at).getTime() - now.getTime()).toBe(15 * 60_000);
    await sql`DELETE FROM agent_wakes WHERE event='attention_waiting'`;
    expect(new Date(rows[0]!.expires_at).getTime() - now.getTime()).toBe(10 * 60_000);
    expect(new Date(rows[1]!.expires_at).getTime() - now.getTime()).toBe(60 * 60_000);
    expect(new Date(rows[2]!.expires_at).getTime() - now.getTime()).toBe(30 * 60_000);
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

describe("runAttentionWakeTick", () => {
  const minutes = (n: number) => new Date(now.getTime() + n * 60_000);
  const tick = (waiting: number, at = 0, asleep = false) =>
    runAttentionWakeTick(sql, { userId, waiting, asleep, now: minutes(at) });
  const rows = () =>
    sql<{ status: string; last_error: string | null; dedupe_key: string }[]>`
      SELECT status, last_error, dedupe_key FROM agent_wakes WHERE event='attention_waiting' ORDER BY created_at`;

  it("wakes once when the count rises above 0 and not again while it stays up", async () => {
    expect(await tick(0)).toBe("idle");
    expect(await tick(2, 1)).toBe("enqueued");
    expect(await tick(3, 2)).toBe("capped");
    // Even after the hour, the same episode (the count never fell to 0) wakes nobody again.
    expect(await tick(3, 90)).toBe("open");
    expect(await rows()).toHaveLength(1);
  });

  it("allows another wake only when the count has fallen to 0 and an hour has passed", async () => {
    expect(await tick(1, 0)).toBe("enqueued");
    expect(await tick(0, 10)).toBe("closed");
    expect(await tick(1, 20)).toBe("capped");
    expect(await tick(1, 61)).toBe("enqueued");
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all[0]!.dedupe_key).toMatch(/^attention_waiting:closed:/);
    expect(all[1]!.dedupe_key).toBe("attention_waiting:open");
  });

  it("waits while the owner is asleep and wakes on the first tick after", async () => {
    expect(await tick(1, 0, true)).toBe("asleep");
    expect(await rows()).toHaveLength(0);
    expect(await tick(1, 1, false)).toBe("enqueued");
  });

  it("cancels a wake not yet sent when the count falls to 0 or the feed is read, keeping the episode open on a read", async () => {
    await tick(1, 0);
    expect(await cancelPendingAttentionWakes(sql, userId)).toBe(1);
    expect(await rows()).toEqual([{ status: "dead", last_error: "cancelled", dedupe_key: "attention_waiting:open" }]);
    expect(await tick(1, 120)).toBe("open");

    await sql`TRUNCATE agent_wakes`;
    await tick(1, 0);
    expect(await tick(0, 5)).toBe("closed");
    expect((await rows())[0]).toMatchObject({ status: "dead", last_error: "cancelled" });
  });

  it("leaves a sent wake sent when the episode closes", async () => {
    await tick(1, 0);
    await sql`UPDATE agent_wakes SET status='sent', sent_at=${now.toISOString()}::timestamptz`;
    expect(await tick(0, 5)).toBe("closed");
    expect((await rows())[0]).toMatchObject({ status: "sent" });
  });
});
