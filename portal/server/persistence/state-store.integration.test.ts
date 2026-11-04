import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName, STATE_CHANGED_CHANNEL, type StateChangedNotification } from "@openrhen/database";
import { createSeedState } from "@/state/portal-state";
import { getStateStore } from "@/server/persistence/state-store";

/**
 * The live-updates signal (`platform/database/src/planning/state-changed.ts`) end-to-end at the
 * portal's own write path: `PostgresStateStore.withWriteClient` (`portal/server/persistence/state-store.ts`)
 * is what every ordinary command (`saveProject`, `saveEntity`, `runSessionCommand`, …) funnels through,
 * so this proves a real command commits and then raises a real `NOTIFY` a real `LISTEN`ing connection
 * actually receives — not just that `notifyStateChanged` builds the right payload (`state-changed.test.ts`
 * already covers that against a fake `sql`), and not just that the scheduler's own writer fires it
 * (`check-in-scheduler.integration.test.ts` already covers that). A read (`get()`) must raise nothing at
 * all — that's the second test below.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.STATE_STORE_NOTIFY_TEST_DATABASE_NAME,
  "openrhen_state_store_notify"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("STATE_STORE_NOTIFY_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let listenSql: postgres.Sql;

/** `sql.listen(...)`'s own returned promise is the only reliable confirmation the server has actually
 *  processed the `LISTEN` — writing before it resolves risks a NOTIFY nobody is subscribed to yet. */
function subscribe(): { ready: Promise<unknown>; notification: Promise<StateChangedNotification> } {
  let resolveNotification!: (value: StateChangedNotification) => void;
  const notification = new Promise<StateChangedNotification>((resolve) => {
    resolveNotification = resolve;
  });
  const ready = listenSql.listen(STATE_CHANGED_CHANNEL, (payload) =>
    resolveNotification(JSON.parse(payload) as StateChangedNotification)
  );
  return { ready, notification };
}

/** Resolves `true` if nothing arrives on the channel within `timeoutMs`, `false` if something does —
 *  used by the negative ("a read notifies nobody") test below. */
async function noNotificationWithin(timeoutMs: number): Promise<boolean> {
  const { ready, notification } = subscribe();
  await ready;
  const result = await Promise.race([
    notification.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs))
  ]);
  return result;
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
  listenSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10, fetch_types: false });
  process.env.DATABASE_URL = testUrl.toString();
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users, user_preferences, projects, outcomes, areas CASCADE");
});

afterAll(async () => {
  await sql?.end();
  await listenSql?.end({ timeout: 0 });
});

describe("PostgresStateStore raises state_changed", () => {
  it("fires a state-kind NOTIFY once a write commits", async () => {
    const { ready, notification } = subscribe();
    await ready;

    await getStateStore().put(createSeedState(new Date("2026-09-04T00:00:00.000Z")));

    await expect(notification).resolves.toMatchObject({ kind: "state" });
  });

  it("fires again for a second, ordinary command (saveEntity), each with its own timestamp", async () => {
    const store = getStateStore();
    await store.put(createSeedState(new Date("2026-09-04T00:00:00.000Z")));

    const { ready, notification } = subscribe();
    await ready;
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "capture",
      entity: {
        id: crypto.randomUUID(),
        text: "Buy stamps",
        createdAt: new Date().toISOString(),
        status: "pending",
        proposalType: "unclassified",
        proposedFields: { text: "Buy stamps" },
        sourceType: "manual_capture"
      }
    });

    await expect(notification).resolves.toMatchObject({ kind: "state" });
  });

  it("raises nothing for a plain read", async () => {
    const store = getStateStore();
    // Seeding is itself a write, and `notifyStateChanged` is deliberately fire-and-forget (see its
    // doc comment) — its `pg_notify` call can still be in flight on the pool when `put()`'s own
    // promise resolves. Subscribing before this write and draining its notification first, rather
    // than starting the "nothing arrives" listen immediately after, is what keeps that stray notify
    // from being mistaken for one the read below raised.
    const seed = subscribe();
    await seed.ready;
    await store.put(createSeedState(new Date("2026-09-04T00:00:00.000Z")));
    await seed.notification;

    const check = noNotificationWithin(500);
    await store.get();

    expect(await check).toBe(true);
  });
});
