import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { enqueueAgentWake } from "./agent-wake.js";
import { pruneAgentWakes, sendNextAgentWake } from "./agent-wake-sender.js";
import { integrationDatabaseName } from "../operations/integration-database.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.AGENT_WAKE_SENDER_TEST_DATABASE_NAME,
  "openrhen_agent_wake_sender"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("AGENT_WAKE_SENDER_TEST_DATABASE_NAME must be an identifier ending in _test");
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
  await sql`DELETE FROM pulse_segments`;
  await sql`DELETE FROM check_in`;
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

const TOKEN = "s3cret-token-value";
const URL_BASE = "http://127.0.0.1:18789/";

function okFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("gateway output with s3cret-token-value", { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

async function makeCheckIn(status: string, answered = false): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO check_in (user_id, slot_at, directive_kind, directive_title, status, answered_at)
    VALUES (${userId}, ${now.toISOString()}::timestamptz, 'task', 'T', ${status},
      ${answered ? now.toISOString() : null}::timestamptz)
    RETURNING id`;
  return rows[0]!.id;
}

async function openLapse(): Promise<void> {
  await sql`INSERT INTO pulse_segments (user_id, started_at, state, reason)
    VALUES (${userId}, ${now.toISOString()}::timestamptz, 'off', 'lapsed')`;
}

async function wake(): Promise<{
  status: string;
  attempts: number;
  last_error: string | null;
  sent_at: Date | string | null;
}> {
  const rows = await sql<
    { status: string; attempts: number; last_error: string | null; sent_at: Date | string | null }[]
  >`
    SELECT status, attempts, last_error, sent_at FROM agent_wakes`;
  return rows[0]!;
}

describe("sendNextAgentWake", () => {
  it("posts the template to /hooks/agent with the bearer token and marks the row sent", async () => {
    const id = await makeCheckIn("unknown");
    await enqueueAgentWake(sql, { userId, event: "check_in_unanswered", targetId: id, now });
    const fetcher = okFetch();
    const result = await sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: fetcher.impl, now });
    expect(result.outcome).toBe("sent");
    expect(fetcher.calls).toHaveLength(1);
    const call = fetcher.calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:18789/hooks/agent");
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.init.redirect).toBe("error");
    const body = JSON.parse(call.init.body as string) as { message: string; name: string };
    expect(body.name).toBe("rhen");
    expect(body.message.startsWith("[OpenRhen wake]")).toBe(true);
    expect(body.message).toContain(id);
    const row = await wake();
    expect(row.status).toBe("sent");
    expect(row.last_error).toBe("HTTP 200");
  });

  it("makes exactly one POST when two ticks race", async () => {
    const id = await makeCheckIn("unknown");
    await enqueueAgentWake(sql, { userId, event: "check_in_unanswered", targetId: id, now });
    const fetcher = okFetch();
    const results = await Promise.all([
      sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: fetcher.impl, now }),
      sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: fetcher.impl, now })
    ]);
    expect(fetcher.calls).toHaveLength(1);
    expect(results.map((r) => r.outcome).sort()).toEqual(["none", "sent"]);
  });

  it("drops a check-in that was answered and tries the next row", async () => {
    const answered = await makeCheckIn("on_track", true);
    await enqueueAgentWake(sql, { userId, event: "check_in_unanswered", targetId: answered, now });
    const fetcher = okFetch();
    const result = await sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: fetcher.impl, now });
    expect(result).toEqual({ outcome: "none", dropped: 1 });
    expect(fetcher.calls).toHaveLength(0);
    expect(await wake()).toMatchObject({ status: "dead", last_error: "stale" });
  });

  it("sends a still-lapsed pulse wake but drops one after re-entry", async () => {
    await openLapse();
    await enqueueAgentWake(sql, { userId, event: "pulse_lapsed", targetId: now.toISOString(), now });
    const first = okFetch();
    expect((await sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: first.impl, now })).outcome).toBe(
      "sent"
    );
    expect(first.calls).toHaveLength(1);

    await sql`TRUNCATE agent_wakes`;
    await sql`UPDATE pulse_segments SET ended_at = ${now.toISOString()}::timestamptz`;
    await enqueueAgentWake(sql, { userId, event: "pulse_lapsed", targetId: now.toISOString(), now });
    const second = okFetch();
    const result = await sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: second.impl, now });
    expect(result).toEqual({ outcome: "none", dropped: 1 });
    expect(second.calls).toHaveLength(0);
    expect(await wake()).toMatchObject({ status: "dead", last_error: "stale" });
  });

  it("sends a pulse_unknown wake while the pulse is still unknown, but drops one once the segment closed", async () => {
    await sql`INSERT INTO pulse_segments (user_id, started_at, state, reason)
      VALUES (${userId}, ${now.toISOString()}::timestamptz, 'unknown', 'unconfirmed')`;
    await enqueueAgentWake(sql, { userId, event: "pulse_unknown", targetId: now.toISOString(), now });
    const first = okFetch();
    expect((await sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: first.impl, now })).outcome).toBe(
      "sent"
    );
    expect(first.calls).toHaveLength(1);

    await sql`TRUNCATE agent_wakes`;
    await sql`UPDATE pulse_segments SET ended_at = ${now.toISOString()}::timestamptz`;
    await enqueueAgentWake(sql, { userId, event: "pulse_unknown", targetId: now.toISOString(), now });
    const second = okFetch();
    const result = await sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: second.impl, now });
    expect(result).toEqual({ outcome: "none", dropped: 1 });
    expect(second.calls).toHaveLength(0);
    expect(await wake()).toMatchObject({ status: "dead", last_error: "stale" });
  });

  it("marks an expired pending row dead without sending", async () => {
    const id = await makeCheckIn("unknown");
    await enqueueAgentWake(sql, { userId, event: "check_in_unanswered", targetId: id, now });
    const fetcher = okFetch();
    const later = new Date(now.getTime() + 11 * 60_000);
    expect(
      (await sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: fetcher.impl, now: later })).outcome
    ).toBe("none");
    expect(fetcher.calls).toHaveLength(0);
    expect(await wake()).toMatchObject({ status: "dead", last_error: "expired" });
  });

  it("returns a refused connection to pending, then dead on the third refusal", async () => {
    const id = await makeCheckIn("unknown");
    await enqueueAgentWake(sql, { userId, event: "check_in_unanswered", targetId: id, now });
    const refuse = (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
    }) as unknown as typeof fetch;
    const first = await sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: refuse, now });
    expect(first).toMatchObject({ outcome: "refused", attempts: 1, dead: false });
    expect(await wake()).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error: "connection refused",
      sent_at: null
    });
    await sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: refuse, now });
    expect(await wake()).toMatchObject({ status: "pending", attempts: 2 });
    const third = await sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: refuse, now });
    expect(third).toMatchObject({ outcome: "refused", attempts: 3, dead: true });
    expect(await wake()).toMatchObject({ status: "dead", attempts: 3 });
  });

  it("keeps a row sent after an HTTP 500 or a timeout and never retries", async () => {
    const id = await makeCheckIn("unknown");
    await enqueueAgentWake(sql, { userId, event: "check_in_unanswered", targetId: id, now });
    const fetcher = okFetch(500);
    expect(await sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: fetcher.impl, now })).toMatchObject({
      outcome: "sent",
      httpStatus: 500
    });
    expect(await wake()).toMatchObject({ status: "sent", attempts: 0, last_error: "HTTP 500" });
    expect((await sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: fetcher.impl, now })).outcome).toBe(
      "none"
    );
    expect(fetcher.calls).toHaveLength(1);

    await sql`TRUNCATE agent_wakes`;
    await enqueueAgentWake(sql, { userId, event: "check_in_unanswered", targetId: id, now });
    const slow = (async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    expect((await sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: slow, now })).outcome).toBe(
      "sent-unconfirmed"
    );
    expect(await wake()).toMatchObject({ status: "sent", last_error: "timeout" });
  });

  it("never stores or returns the token or gateway output", async () => {
    const id = await makeCheckIn("unknown");
    await enqueueAgentWake(sql, { userId, event: "check_in_unanswered", targetId: id, now });
    const leaky = (async () => {
      throw new Error(`boom ${TOKEN}`);
    }) as unknown as typeof fetch;
    const result = await sendNextAgentWake(sql, { url: URL_BASE, token: TOKEN, fetchImpl: leaky, now });
    const row = await wake();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(row.last_error).toBe("network error");
    const dump = await sql`SELECT * FROM agent_wakes`;
    expect(JSON.stringify(dump)).not.toContain(TOKEN);
  });

  it("does nothing when the URL or token is empty or the URL is not allowed", async () => {
    const id = await makeCheckIn("unknown");
    await enqueueAgentWake(sql, { userId, event: "check_in_unanswered", targetId: id, now });
    const fetcher = okFetch();
    for (const input of [
      { url: "", token: TOKEN },
      { url: URL_BASE, token: "" },
      { url: "http://192.168.1.5", token: TOKEN }
    ]) {
      expect(await sendNextAgentWake(sql, { ...input, fetchImpl: fetcher.impl, now })).toEqual({
        outcome: "none",
        dropped: 0
      });
    }
    expect(fetcher.calls).toHaveLength(0);
    expect(await wake()).toMatchObject({ status: "pending", attempts: 0 });
  });
});

describe("pruneAgentWakes", () => {
  it("deletes only rows older than 30 days", async () => {
    await enqueueAgentWake(sql, { userId, event: "pulse_lapsed", targetId: "old", now });
    await enqueueAgentWake(sql, { userId, event: "pulse_lapsed", targetId: "new", now });
    const old = new Date(now.getTime() - 31 * 24 * 60 * 60_000);
    const recent = new Date(now.getTime() - 29 * 24 * 60 * 60_000);
    await sql`UPDATE agent_wakes SET created_at = ${old.toISOString()}::timestamptz WHERE target_id = 'old'`;
    await sql`UPDATE agent_wakes SET created_at = ${recent.toISOString()}::timestamptz WHERE target_id = 'new'`;
    expect(await pruneAgentWakes(sql, now)).toBe(1);
    const rows = await sql<{ target_id: string }[]>`SELECT target_id FROM agent_wakes`;
    expect(rows.map((r) => r.target_id)).toEqual(["new"]);
  });
});
