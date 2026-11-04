import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import {
  addPushSubscription,
  deletePushSubscriptionById,
  listPushSubscriptions,
  MAX_PUSH_SUBSCRIPTIONS,
  upsertPushSubscription
} from "./push-subscriptions";

/**
 * Security finding: `deletePushSubscriptionById` (behind
 * `DELETE /api/push/subscriptions/[id]`) must scope its delete to the caller's own `user_id`, the
 * same way the sibling list/subscribe routes resolve the caller through `ensureUser`. This proves a
 * second user's row survives an attempt to delete it by id, that the call reports "not removed" (the
 * route's 404), and that the owner's own delete still works.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.PUSH_SUBSCRIPTIONS_TEST_DATABASE_NAME,
  "openrhen_push_subscriptions"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("PUSH_SUBSCRIPTIONS_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userA: string;
let userB: string;

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
  userA = await ensureUser(sql);
  const created = await sql<{ id: string }[]>`
    INSERT INTO users (display_name, timezone) VALUES ('Other Test User', 'Australia/Sydney') RETURNING id
  `;
  userB = created[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

describe("deletePushSubscriptionById — ownership scoping", () => {
  it("does not delete another user's subscription, and reports nothing removed", async () => {
    await upsertPushSubscription(
      sql as never,
      userB,
      { endpoint: "https://push.example/b", keys: { p256dh: "p", auth: "a" } },
      "current-key",
      "B's iPhone"
    );
    const [subscription] = await listPushSubscriptions(sql as never, userB);
    expect(subscription).toBeDefined();

    const removed = await deletePushSubscriptionById(sql as never, userA, subscription!.id);

    expect(removed).toBe(false);
    const stillThere = await listPushSubscriptions(sql as never, userB);
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0]!.id).toBe(subscription!.id);
  });

  it("deletes the owner's own subscription and reports it removed", async () => {
    await upsertPushSubscription(
      sql as never,
      userA,
      { endpoint: "https://push.example/a", keys: { p256dh: "p", auth: "a" } },
      "current-key",
      "A's iPhone"
    );
    const [subscription] = await listPushSubscriptions(sql as never, userA);
    expect(subscription).toBeDefined();

    const removed = await deletePushSubscriptionById(sql as never, userA, subscription!.id);

    expect(removed).toBe(true);
    expect(await listPushSubscriptions(sql as never, userA)).toHaveLength(0);
  });

  it("reports nothing removed for an id that does not exist at all", async () => {
    const removed = await deletePushSubscriptionById(sql as never, userA, "00000000-0000-0000-0000-000000000000");
    expect(removed).toBe(false);
  });
});

describe("addPushSubscription (security review W3)", () => {
  const wire = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: "p", auth: "a" } });
  // `null` sends no label at all (a default parameter would swallow an explicit `undefined`).
  const add = (n: number, label: string | null = `Device ${n}`) =>
    addPushSubscription(sql as never, userA, wire(n), "current-key", label ?? undefined, {
      now: new Date("2026-10-18T09:42:00.000Z")
    });
  const announcements = () =>
    sql<{ dedupe_key: string; kind: string; status: string; body: string }[]>`
      SELECT dedupe_key, kind, status, payload->>'body' AS body FROM push_outbox WHERE user_id=${userA} ORDER BY created_at
    `;

  it("adds the first device without announcing it to anyone", async () => {
    expect(await add(1)).toBe("added");
    expect(await listPushSubscriptions(sql as never, userA)).toHaveLength(1);
    expect(await announcements()).toHaveLength(0);
  });

  it("announces a second device to the first, naming it and pointing at Settings", async () => {
    await add(1);
    expect(await add(2, "iPhone")).toBe("added");
    const [newest] = (await listPushSubscriptions(sql as never, userA)).slice(-1);
    const rows = await announcements();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dedupe_key: `device_added:${newest!.id}`, kind: "test", status: "pending" });
    expect(rows[0]!.body).toMatch(
      /^New device added for OpenRhen notifications: iPhone, .*Not yours\? Remove it in Settings > Notifications\.$/
    );
  });

  it("says Unnamed device when the new device sent no label", async () => {
    await add(1);
    await add(2, null);
    expect((await announcements())[0]!.body).toContain("notifications: Unnamed device,");
  });

  it("refreshes an existing endpoint without counting it against the cap or announcing it", async () => {
    await add(1);
    await add(2);
    expect(await add(2)).toBe("refreshed");
    expect(await listPushSubscriptions(sql as never, userA)).toHaveLength(2);
    expect(await announcements()).toHaveLength(1);
  });

  it("refuses the sixth new endpoint but still refreshes one of the five", async () => {
    for (let n = 1; n <= MAX_PUSH_SUBSCRIPTIONS; n++) expect(await add(n)).toBe("added");
    expect(await add(MAX_PUSH_SUBSCRIPTIONS + 1)).toBe("cap_reached");
    expect(await listPushSubscriptions(sql as never, userA)).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
    expect(await add(3)).toBe("refreshed");
    expect(await announcements()).toHaveLength(MAX_PUSH_SUBSCRIPTIONS - 1);
  });

  it("does not let simultaneous adds slip past the cap", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, n) => add(n + 1)));
    expect(results.filter((r) => r === "added")).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
    expect(results.filter((r) => r === "cap_reached")).toHaveLength(8 - MAX_PUSH_SUBSCRIPTIONS);
    expect(await listPushSubscriptions(sql as never, userA)).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
  });
});
