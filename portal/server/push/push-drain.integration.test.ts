import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import type { PushSendRequest, PushSendResult } from "@openrhen/contracts";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";

/**
 * No real push sends or network calls: `fetchVapidPublicKey`/`sendPushViaProxy` are mocked at the
 * module boundary `push-drain.ts` calls them through, so this exercises the drain's own transaction
 * (claiming, per-subscription send outcomes, retry/backoff, expiry) against a real database without
 * ever reaching the outbound proxy.
 */
const fetchVapidPublicKeyMock = vi.fn<() => Promise<string | null>>();
const sendPushViaProxyMock = vi.fn<(request: PushSendRequest) => Promise<PushSendResult>>();
vi.mock("./push-proxy-client", () => ({
  fetchVapidPublicKey: () => fetchVapidPublicKeyMock(),
  sendPushViaProxy: (request: PushSendRequest) => sendPushViaProxyMock(request)
}));

const { runPushDrain } = await import("./push-drain");
const { addPushSubscription, upsertPushSubscription, listPushSubscriptions } = await import("./push-subscriptions");

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.PUSH_DRAIN_TEST_DATABASE_NAME, "openrhen_push_drain");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("PUSH_DRAIN_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const CURRENT_KEY = "current-key";

async function enqueue(dedupeKey: string, options: { expiresInMs?: number; kind?: string } = {}) {
  const expiresAt = new Date(Date.now() + (options.expiresInMs ?? 5 * 60_000));
  const payload = { title: "OpenRhen", body: "Leave by 08:10.", tag: dedupeKey, url: "/now" };
  await sql`
    INSERT INTO push_outbox (user_id, dedupe_key, kind, payload, status, expires_at)
    VALUES (${userId}, ${dedupeKey}, ${options.kind ?? "reminder"}, ${sql.json(payload as never)}, 'pending', ${expiresAt})
  `;
}

async function outboxRow(dedupeKey: string) {
  const rows = await sql<{ status: string; attempts: number; sent_at: Date | null; last_error: string | null }[]>`
    SELECT status, attempts, sent_at, last_error FROM push_outbox WHERE user_id=${userId} AND dedupe_key=${dedupeKey}
  `;
  return rows[0]!;
}

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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
  fetchVapidPublicKeyMock.mockReset().mockResolvedValue(CURRENT_KEY);
  sendPushViaProxyMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await sql?.end();
});

describe("runPushDrain", () => {
  it("releases every claimed row when the proxy call throws, instead of stranding them for the 5 minute lease", async () => {
    await upsertPushSubscription(
      sql as never,
      userId,
      { endpoint: "https://push.example/one", keys: { p256dh: "p", auth: "a" } },
      CURRENT_KEY,
      "iPhone"
    );
    await enqueue("reminder:1");
    await enqueue("reminder:2");
    sendPushViaProxyMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(runPushDrain(sql as never, userId)).resolves.toMatchObject({ claimed: 2, sent: 0 });
    const due = await sql<{ dedupe_key: string; attempts: number; soon: boolean; status: string }[]>`
      SELECT dedupe_key, attempts, status, next_attempt_at <= now() + INTERVAL '31 seconds' AS soon
      FROM push_outbox WHERE user_id=${userId} ORDER BY dedupe_key`;
    expect(due.map((r) => r.soon)).toEqual([true, true]);
    expect(due.map((r) => r.status)).toEqual(["pending", "pending"]);
    // The proxy being down is not the row's fault: no attempt is spent without a send.
    expect(due.map((r) => r.attempts)).toEqual([0, 0]);
  });

  it("returns all-zero, sends nothing and records why when the proxy has no VAPID key configured", async () => {
    fetchVapidPublicKeyMock.mockResolvedValue(null);
    await enqueue("reminder:1");
    const result = await runPushDrain(sql as never, userId);
    expect(result).toEqual({ claimed: 0, sent: 0, deferredNoSubscription: 0, expired: 0 });
    expect(sendPushViaProxyMock).not.toHaveBeenCalled();
    const row = await outboxRow("reminder:1");
    expect(row.status).toBe("pending");
    expect(row.last_error).toBe("push_service_unavailable");
  });

  it("keeps a pending row (and its dedupe key) when there is no subscription, and sends it once one appears", async () => {
    await enqueue("reminder:1");
    const result = await runPushDrain(sql as never, userId);
    expect(result).toMatchObject({ claimed: 1, sent: 0, deferredNoSubscription: 1 });
    let row = await outboxRow("reminder:1");
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.last_error).toBe("no_subscriptions");
    expect(sendPushViaProxyMock).not.toHaveBeenCalled();

    await upsertPushSubscription(
      sql as never,
      userId,
      { endpoint: "https://push.example/late", keys: { p256dh: "p", auth: "a" } },
      CURRENT_KEY,
      "iPhone"
    );
    await sql`UPDATE push_outbox SET next_attempt_at=now() WHERE user_id=${userId}`;
    sendPushViaProxyMock.mockResolvedValue({ outcome: "delivered" });
    await runPushDrain(sql as never, userId);
    row = await outboxRow("reminder:1");
    expect(row.status).toBe("sent");
  });

  it("does not let an overlapping drain send a row another drain is still sending", async () => {
    await upsertPushSubscription(
      sql as never,
      userId,
      { endpoint: "https://push.example/slow", keys: { p256dh: "p", auth: "a" } },
      CURRENT_KEY,
      "iPhone"
    );
    await enqueue("reminder:1");
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    sendPushViaProxyMock.mockImplementation(async () => {
      await gate;
      return { outcome: "delivered" };
    });
    const first = runPushDrain(sql as never, userId);
    await vi.waitFor(() => expect(sendPushViaProxyMock).toHaveBeenCalledTimes(1));
    const second = await runPushDrain(sql as never, userId);
    expect(second.claimed).toBe(0);
    release();
    expect((await first).sent).toBe(1);
    expect(sendPushViaProxyMock).toHaveBeenCalledTimes(1);
    expect((await outboxRow("reminder:1")).attempts).toBe(1);
  });

  it("stops sending when the batch budget is spent and releases the unsent rows instead of holding their lease", async () => {
    await upsertPushSubscription(
      sql as never,
      userId,
      { endpoint: "https://push.example/dead", keys: { p256dh: "p", auth: "a" } },
      CURRENT_KEY,
      "iPhone"
    );
    for (const key of ["reminder:1", "reminder:2", "reminder:3"]) await enqueue(key);
    sendPushViaProxyMock.mockImplementation(async () => {
      await new Promise((resolveSend) => setTimeout(resolveSend, 600));
      return { outcome: "delivered" };
    });
    const result = await runPushDrain(sql as never, userId, { sendBudgetMs: 300 });
    expect(result).toMatchObject({ claimed: 3, sent: 1 });
    expect(sendPushViaProxyMock).toHaveBeenCalledTimes(1);
    const rows = await sql<{ status: string; attempts: number; ready: boolean }[]>`
      SELECT status, attempts, next_attempt_at <= now() AS ready FROM push_outbox WHERE user_id=${userId}
    `;
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(1);
    const pending = rows.filter((r) => r.status === "pending");
    expect(pending).toHaveLength(2);
    expect(pending.every((r) => r.attempts === 0 && r.ready)).toBe(true);

    const next = await runPushDrain(sql as never, userId);
    expect(next.claimed).toBe(2);
  });

  it("sends to a matching subscription and marks the row sent", async () => {
    await upsertPushSubscription(
      sql as never,
      userId,
      { endpoint: "https://push.example/a", keys: { p256dh: "p", auth: "a" } },
      CURRENT_KEY,
      "iPhone"
    );
    await enqueue("reminder:1");
    sendPushViaProxyMock.mockResolvedValue({ outcome: "delivered" });
    const result = await runPushDrain(sql as never, userId);
    expect(result).toMatchObject({ claimed: 1, sent: 1, deferredNoSubscription: 0 });
    const row = await outboxRow("reminder:1");
    expect(row.status).toBe("sent");
    expect(row.sent_at).not.toBeNull();
    const [subscription] = await listPushSubscriptions(sql as never, userId);
    expect(subscription!.lastSuccessAt).not.toBeNull();
  });

  it("deletes a subscription the push service reports gone, and still cancels with none left", async () => {
    await upsertPushSubscription(
      sql as never,
      userId,
      { endpoint: "https://push.example/gone", keys: { p256dh: "p", auth: "a" } },
      CURRENT_KEY,
      "iPhone"
    );
    await enqueue("reminder:1");
    sendPushViaProxyMock.mockResolvedValue({ outcome: "gone", httpStatus: 410 });
    const result = await runPushDrain(sql as never, userId);
    expect(result.deferredNoSubscription).toBe(0); // the send was attempted, not skipped for lack of one
    const subscriptions = await listPushSubscriptions(sql as never, userId);
    expect(subscriptions).toHaveLength(0);
    // Nothing was delivered, so the row is scheduled for retry like any other undelivered send — the
    // dead subscription is gone, but that alone does not fail the row on this first attempt.
    const row = await outboxRow("reminder:1");
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
  });

  it("retries a failed send up to the attempt limit before giving up", async () => {
    await upsertPushSubscription(
      sql as never,
      userId,
      { endpoint: "https://push.example/flaky", keys: { p256dh: "p", auth: "a" } },
      CURRENT_KEY,
      "iPhone"
    );
    await enqueue("reminder:1");
    sendPushViaProxyMock.mockResolvedValue({ outcome: "failed" });
    await runPushDrain(sql as never, userId);
    let row = await outboxRow("reminder:1");
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    await sql`UPDATE push_outbox SET next_attempt_at=now() WHERE user_id=${userId}`;
    await runPushDrain(sql as never, userId);
    await sql`UPDATE push_outbox SET next_attempt_at=now() WHERE user_id=${userId}`;
    await runPushDrain(sql as never, userId);
    row = await outboxRow("reminder:1");
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
  });

  it("deletes subscriptions under a mismatched (rotated) VAPID key and never sends to them", async () => {
    await upsertPushSubscription(
      sql as never,
      userId,
      { endpoint: "https://push.example/stale", keys: { p256dh: "p", auth: "a" } },
      "an-old-key",
      "iPhone"
    );
    await enqueue("reminder:1");
    const result = await runPushDrain(sql as never, userId);
    expect(sendPushViaProxyMock).not.toHaveBeenCalled();
    expect(result.deferredNoSubscription).toBe(1);
    expect(await listPushSubscriptions(sql as never, userId)).toHaveLength(0);
  });

  it("expires a pending row past its own expires_at instead of sending it", async () => {
    await enqueue("reminder:1", { expiresInMs: -1000 });
    const result = await runPushDrain(sql as never, userId);
    expect(result.expired).toBe(1);
    expect((await outboxRow("reminder:1")).status).toBe("expired");
    expect(sendPushViaProxyMock).not.toHaveBeenCalled();
  });

  it("sends a new-device announcement to the devices that already existed, never to the new one", async () => {
    const wire = (n: number) => ({ endpoint: `https://push.example/d${n}`, keys: { p256dh: "p", auth: "a" } });
    const add = (n: number) => addPushSubscription(sql as never, userId, wire(n), CURRENT_KEY, `Device ${n}`);
    await add(1);
    await add(2);
    await add(3);
    sendPushViaProxyMock.mockResolvedValue({ outcome: "delivered" });

    // Two rows must be queued and due before the drain runs; if the claim then finds none, the state
    // below (not just `claimed: 0`) says whether they were missing, not yet due, expired or locked.
    const queued = await sql<{ dedupe_key: string; status: string; due: boolean; live: boolean }[]>`
      SELECT dedupe_key, status, next_attempt_at <= now() AS due, expires_at > now() AS live
      FROM push_outbox WHERE user_id=${userId} AND dedupe_key LIKE 'device_added:%'
    `;
    expect(queued, "announcements queued before the drain").toHaveLength(2);
    expect(
      queued.every((r) => r.status === "pending" && r.due && r.live),
      JSON.stringify(queued)
    ).toBe(true);

    const result = await runPushDrain(sql as never, userId);

    // A claim of 0 is read back from the rows: a lock or lease shows as a moved next_attempt_at or a
    // spent attempt, an untouched row as the original values.
    const after =
      result.claimed === 0
        ? await sql`
            SELECT dedupe_key, status, attempts, next_attempt_at, expires_at, now() AS db_now
            FROM push_outbox WHERE user_id=${userId} AND dedupe_key LIKE 'device_added:%'
          `
        : [];
    expect(
      result,
      `drain result ${JSON.stringify(result)}; outbox before it: ${JSON.stringify(queued)}; after: ${JSON.stringify(after)}`
    ).toMatchObject({ claimed: 2, sent: 2 });
    const sentTo = sendPushViaProxyMock.mock.calls.map(([request]) => request.subscription.endpoint);
    // Each announcement goes to every device registered when the drain runs except the one it names:
    // device 2's to devices 1 and 3, device 3's to devices 1 and 2.
    expect(sentTo.filter((e) => e.endsWith("/d3"))).toHaveLength(1);
    expect(sentTo.filter((e) => e.endsWith("/d2"))).toHaveLength(1);
    expect(sentTo.filter((e) => e.endsWith("/d1"))).toHaveLength(2);
  });

  it("keeps an announcement pending, not failed, when the new device is the only one left", async () => {
    await addPushSubscription(
      sql as never,
      userId,
      { endpoint: "https://push.example/o", keys: { p256dh: "p", auth: "a" } },
      CURRENT_KEY,
      "Old",
      {}
    );
    await addPushSubscription(
      sql as never,
      userId,
      { endpoint: "https://push.example/n", keys: { p256dh: "p", auth: "a" } },
      CURRENT_KEY,
      "New",
      {}
    );
    await sql`DELETE FROM push_subscriptions WHERE endpoint='https://push.example/o'`;

    const result = await runPushDrain(sql as never, userId);

    expect(result).toMatchObject({ claimed: 1, sent: 0, deferredNoSubscription: 1 });
    expect(sendPushViaProxyMock).not.toHaveBeenCalled();
  });
});
