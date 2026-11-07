import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "../operations/integration-database.js";
import { recordShown, type ShownInput } from "./offer-log.js";

/** The `shown` writer: the five-minute repeat rule, the client-id idempotency, and what a row carries. */
config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.OFFER_LOG_SHOWN_TEST_DATABASE_NAME,
  "openrhen_offer_log_shown"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("OFFER_LOG_SHOWN_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (display_name, timezone) VALUES ('Shown Fixture', 'Australia/Sydney') RETURNING id`;
  userId = users[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

const shown = (overrides: Partial<ShownInput> = {}): ShownInput => ({
  surface: "portal",
  resolutionKind: "recommended",
  targetType: "action",
  targetId: "action-1",
  label: "Write essay",
  actor: "person",
  ...overrides
});
const rows = () =>
  sql<
    {
      surface: string;
      resolution_kind: string;
      target_id: string;
      recommendation_id: string | null;
      actor: string | null;
      command_id: string | null;
      detail: Record<string, unknown>;
    }[]
  >`SELECT * FROM offer_log WHERE user_id=${userId} AND event='shown' ORDER BY occurred_at, id`;
const id = () => crypto.randomUUID();

describe("recordShown", () => {
  it("writes a row with the latest offered row's recommendation, the user's timezone and the actor", async () => {
    const recommendationId = id();
    await sql`INSERT INTO offer_log (user_id, event, recommendation_id, target_type, surface) VALUES (${userId}, 'offered', ${recommendationId}, 'action', 'server')`;
    expect(await recordShown(sql, userId, shown({ commandId: id() }))).toBe(true);
    const [row] = await rows();
    expect(row).toMatchObject({
      surface: "portal",
      resolution_kind: "recommended",
      target_id: "action-1",
      recommendation_id: recommendationId,
      actor: "person"
    });
    expect(row!.detail).toEqual({ timezone: "Australia/Sydney" });
  });

  it("keeps suppressed_by in detail", async () => {
    await recordShown(
      sql,
      userId,
      shown({
        resolutionKind: "commitment",
        targetType: "fixed_commitment",
        targetId: "c-1",
        suppressedBy: { targetType: "action", targetId: "action-1", label: "Write essay" }
      })
    );
    const [row] = await rows();
    expect(row!.detail.suppressed_by).toEqual({ targetType: "action", targetId: "action-1", label: "Write essay" });
  });

  it("drops an identical repeat inside five minutes but not a different target, kind or surface", async () => {
    expect(await recordShown(sql, userId, shown())).toBe(true);
    expect(await recordShown(sql, userId, shown())).toBe(false);
    expect(await recordShown(sql, userId, shown({ targetId: "action-2" }))).toBe(true);
    expect(await recordShown(sql, userId, shown({ resolutionKind: "free" }))).toBe(true);
    expect(await recordShown(sql, userId, shown({ surface: "handheld" }))).toBe(true);
    expect(await rows()).toHaveLength(4);
  });

  it("writes the repeat again once the first is older than five minutes", async () => {
    await recordShown(sql, userId, shown());
    await sql`UPDATE offer_log SET occurred_at = now() - interval '6 minutes' WHERE user_id=${userId}`;
    expect(await recordShown(sql, userId, shown())).toBe(true);
    expect(await rows()).toHaveLength(2);
  });

  it("is idempotent on the client id", async () => {
    const commandId = id();
    expect(await recordShown(sql, userId, shown({ commandId }))).toBe(true);
    await sql`UPDATE offer_log SET occurred_at = now() - interval '10 minutes' WHERE user_id=${userId}`;
    expect(await recordShown(sql, userId, shown({ commandId }))).toBe(false);
    expect(await rows()).toHaveLength(1);
  });

  it("does not dedupe across users", async () => {
    const other = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`;
    await recordShown(sql, userId, shown());
    expect(await recordShown(sql, other[0]!.id, shown())).toBe(true);
  });

  it("lets two simultaneous identical beacons write one row", async () => {
    const results = await Promise.all(
      [0, 1].map(() => sql.begin((tx) => recordShown(tx, userId, shown({ commandId: id() }))))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });
});
