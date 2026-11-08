import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { ensureExtractorStateTx, promoteExtractorVersion, saveExtractorProgressTx } from "./extractor-state-store";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_extractor_state");

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

const t0 = new Date("2026-11-07T12:00:00.000Z");
const t1 = new Date("2026-11-07T13:00:00.000Z");
const t2 = new Date("2026-11-07T14:00:00.000Z");
const states = () =>
  sql<{ version: string; active: boolean; cursor: Record<string, unknown> | null }[]>`
    SELECT version, active, cursor FROM extractor_state WHERE extractor = 'msg-class-t0' ORDER BY version`;

describe("ensureExtractorStateTx", () => {
  it("makes the first version of an extractor active on creation and records the time", async () => {
    const state = await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "msg-class-t0", "1", t0));
    expect(state.active).toBe(true);
    expect(await states()).toEqual([
      { version: "1", active: true, cursor: { promotions: [{ version: "1", at: t0.toISOString() }] } }
    ]);
  });

  it("returns what is stored on a later call and does not record a second promotion", async () => {
    await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "msg-class-t0", "1", t0));
    const again = await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "msg-class-t0", "1", t1));
    expect(again.active).toBe(true);
    expect((await states())[0]!.cursor).toEqual({ promotions: [{ version: "1", at: t0.toISOString() }] });
  });

  it("creates a later version inactive when another version is already held", async () => {
    await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "msg-class-t0", "1", t0));
    const second = await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "msg-class-t0", "2", t1));
    expect(second.active).toBe(false);
    expect((await states()).map((s) => [s.version, s.active])).toEqual([
      ["1", true],
      ["2", false]
    ]);
  });

  it("keeps extractors and people apart", async () => {
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "msg-class-t0", "1", t0));
    const theirs = await sql.begin((tx) => ensureExtractorStateTx(tx, other, "msg-class-t0", "1", t0));
    const another = await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "fact-t2", "1", t0));
    expect(theirs.active).toBe(true);
    expect(another.active).toBe(true);
  });
});

describe("saveExtractorProgressTx", () => {
  it("merges the cursor patch and keeps the promotion record, and sets or clears the error", async () => {
    await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "msg-class-t0", "1", t0));
    await sql.begin((tx) =>
      saveExtractorProgressTx(tx, userId, "msg-class-t0", "1", {
        cursor: { skipped: 2 },
        lastOkAt: t1,
        lastError: "boom"
      })
    );
    let row = (await states())[0]!;
    expect(row.cursor).toEqual({ skipped: 2, promotions: [{ version: "1", at: t0.toISOString() }] });
    const [meta] = await sql<
      { last_ok_at: Date; last_error: string | null }[]
    >`SELECT last_ok_at, last_error FROM extractor_state`;
    expect(meta).toMatchObject({ last_ok_at: t1, last_error: "boom" });
    await sql.begin((tx) =>
      saveExtractorProgressTx(tx, userId, "msg-class-t0", "1", {
        cursor: { skipped: 3 },
        lastOkAt: t2,
        lastError: null
      })
    );
    row = (await states())[0]!;
    expect(row.cursor).toMatchObject({ skipped: 3 });
    const [after] = await sql<{ last_error: string | null }[]>`SELECT last_error FROM extractor_state`;
    expect(after!.last_error).toBeNull();
  });
});

describe("promoteExtractorVersion", () => {
  it("flips the active flag to the new version, atomically, and records the promotion time", async () => {
    await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "msg-class-t0", "1", t0));
    await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "msg-class-t0", "2", t0));
    const result = await promoteExtractorVersion(sql, userId, "msg-class-t0", "2", t1);
    expect(result).toEqual({ promoted: true });
    const rows = await states();
    expect(rows.map((s) => [s.version, s.active])).toEqual([
      ["1", false],
      ["2", true]
    ]);
    expect(rows[1]!.cursor).toMatchObject({ promotions: [{ version: "2", at: t1.toISOString() }] });
    expect(rows[0]!.cursor).toMatchObject({ promotions: [{ version: "1", at: t0.toISOString() }] });
  });

  it("creates the version when it has no row yet", async () => {
    await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "msg-class-t0", "1", t0));
    expect(await promoteExtractorVersion(sql, userId, "msg-class-t0", "3", t1)).toEqual({ promoted: true });
    expect((await states()).map((s) => [s.version, s.active])).toEqual([
      ["1", false],
      ["3", true]
    ]);
  });

  it("is a no-op for the version that is already active", async () => {
    await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "msg-class-t0", "1", t0));
    expect(await promoteExtractorVersion(sql, userId, "msg-class-t0", "1", t1)).toEqual({ promoted: false });
    expect((await states())[0]!.cursor).toEqual({ promotions: [{ version: "1", at: t0.toISOString() }] });
  });

  it("can go back to an earlier version, appending to that version's record", async () => {
    await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "msg-class-t0", "1", t0));
    await promoteExtractorVersion(sql, userId, "msg-class-t0", "2", t1);
    await promoteExtractorVersion(sql, userId, "msg-class-t0", "1", t2);
    const rows = await states();
    expect(rows.map((s) => [s.version, s.active])).toEqual([
      ["1", true],
      ["2", false]
    ]);
    expect(rows[0]!.cursor).toMatchObject({
      promotions: [
        { version: "1", at: t0.toISOString() },
        { version: "1", at: t2.toISOString() }
      ]
    });
  });

  it("leaves exactly one active version when two promotions race", async () => {
    await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "msg-class-t0", "1", t0));
    const settled = await Promise.allSettled(
      ["2", "3", "4", "5"].map((version) => promoteExtractorVersion(sql, userId, "msg-class-t0", version, t1))
    );
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    expect((await states()).filter((s) => s.active)).toHaveLength(1);
  });

  it("refuses an empty extractor or version", async () => {
    await expect(promoteExtractorVersion(sql, userId, "", "1", t0)).rejects.toThrow(/extractor/);
    await expect(promoteExtractorVersion(sql, userId, "msg-class-t0", " ", t0)).rejects.toThrow(/version/);
  });
});
