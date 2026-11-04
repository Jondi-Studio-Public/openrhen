import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { readPortalState } from "./state-read";

/**
 * Cold-start hygiene (finding 27): the portal and the worker can both call `ensureUser` moments apart
 * on a fresh database, and a plain select-then-insert would let both see no row and both insert one.
 * `ensureUser` now serializes the whole read-or-create behind `pg_advisory_xact_lock`, so this proves
 * the real failure mode directly — a pile of concurrent callers racing a truly empty `users` table —
 * rather than just asserting the SQL shape.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_ensure_user");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

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
  // Enough connections that ten concurrent `ensureUser` calls can each open their own transaction
  // rather than queueing behind the pool limit, which would mask the race this test exists to catch.
  sql = postgres(testUrl.toString(), { max: 10, connect_timeout: 10, fetch_types: false, prepare: true });
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users, user_preferences, portal_state CASCADE");
});

afterAll(async () => {
  await sql?.end();
});

describe("ensureUser — cold-start concurrency", () => {
  it("creates exactly one user row when ten callers race a fresh database", async () => {
    const userIds = await Promise.all(Array.from({ length: 10 }, () => ensureUser(sql)));

    const rows = await sql<{ id: string }[]>`SELECT id FROM users`;
    expect(rows).toHaveLength(1);
    // Every caller must also have resolved to that same row, not a stale or mismatched id.
    expect(new Set(userIds)).toEqual(new Set([rows[0]!.id]));
  });

  it("still returns the existing row when called again after the row already exists", async () => {
    const first = await ensureUser(sql);
    const second = await ensureUser(sql);
    expect(second).toBe(first);
    const rows = await sql<{ id: string }[]>`SELECT id FROM users`;
    expect(rows).toHaveLength(1);
  });

  // Real callers — `NormalizedPostgresStateStore.put()` via `persistPlanningEvidence` /
  // `readPortalState` — already hold an open `sql.begin` transaction and pass that handle in. A
  // postgres.js transaction handle has no `.begin` (nested transactions are `tx.savepoint`), so
  // `ensureUser` must detect that case and run its body directly on the handle instead of trying to
  // open a nested transaction.
  //
  // `tx` is passed to `ensureUser` with no cast: `ensureUser(sql: Sql)` accepts `PoolSql | TxSql`
  // directly now (sql-pool.ts), so this line itself is proof the type reflects what postgres.js hands
  // the callback — a cast here would silently readmit exactly the mismatch `PoolSql`/`TxSql` exist to
  // catch at every other call site.
  it("resolves and creates one row when called with an already-open transaction handle", async () => {
    const userId = await sql.begin(async (tx) => ensureUser(tx));

    expect(typeof userId).toBe("string");
    const rows = await sql<{ id: string }[]>`SELECT id FROM users`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(userId);
  });

  // The exact chain that broke before commit 31b2a11: `NormalizedPostgresStateStore.put()` opens its
  // own transaction and calls `persistPlanningEvidence(tx, ...)`, which calls `readPortalState(tx)`,
  // which calls `ensureUser(tx)` — three layers removed from the top-level `sql.begin` call, and on a
  // cold database `ensureUser` also has to create the row, not just read one. `readPortalState` is the
  // "representative store method" here: it is the one every write path re-reads through, and it is
  // exactly what `persistPlanningEvidence` calls on the caller's open transaction. If `ensureUser` (or
  // anything it calls) ever regresses to an unconditional `sql.begin`, this throws
  // `TypeError: sql.begin is not a function` the same way the original bug did.
  it("hydrates portal state through readPortalState when called from inside an already-open transaction, on a cold database", async () => {
    const state = await sql.begin(async (tx) => readPortalState(tx));

    expect(state).not.toBeNull();
    const rows = await sql<{ id: string }[]>`SELECT id FROM users`;
    expect(rows).toHaveLength(1);
  });

  // A restore truncates plan_subjects, and a format 12 backup carries none, so the user survives with no
  // subjects; the next ensureUser has to bring the starting five back.
  it("reseeds the starting subjects for an existing user whose plan_subjects were truncated by a restore", async () => {
    const userId = await ensureUser(sql);
    await sql`TRUNCATE TABLE plan_subjects`;

    expect(await ensureUser(sql)).toBe(userId);

    const rows = await sql<{ id: string }[]>`SELECT id FROM plan_subjects WHERE user_id = ${userId} ORDER BY id`;
    expect(rows.map((row) => row.id)).toEqual(["drafting", "exercise", "maths", "meals", "money"]);
  });

  it("leaves a user's own subject set alone when they have archived some", async () => {
    const userId = await ensureUser(sql);
    await sql`DELETE FROM plan_subjects WHERE user_id = ${userId} AND id <> 'maths'`;
    await sql`UPDATE plan_subjects SET status = 'archived' WHERE user_id = ${userId}`;

    await ensureUser(sql);

    const rows = await sql<{ id: string }[]>`SELECT id FROM plan_subjects WHERE user_id = ${userId}`;
    expect(rows).toHaveLength(1);
  });
});
