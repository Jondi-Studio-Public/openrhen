import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { deleteActivityImport, ingestActivityEvents, purgeActivitySource } from "./activity-store";
import { deleteDerivedForSources, recordLineage } from "./derived-lineage-store";
import { ensureUser } from "./ensure-user";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_lineage");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const now = new Date("2026-11-07T12:00:00.000Z");
const sha = (c: string) => c.repeat(64);

/** Inserts one row of any source for `user` and returns its id. */
async function row(user: string, source: string, key: string, importId: string | null = null): Promise<string> {
  const [made] = await sql<{ id: string }[]>`
    INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, import_id)
    VALUES (${user}, ${source}, ${source === "derived" ? "fact" : "message"}, ${key}, '2026-11-01T00:00:00Z', ${importId})
    RETURNING id`;
  return made!.id;
}
const derived = (key: string, user = userId) => row(user, "derived", key);
const keys = async (source: string) =>
  (
    await sql<
      { event_key: string }[]
    >`SELECT event_key FROM activity_events WHERE source = ${source} ORDER BY event_key`
  ).map((r) => r.event_key);
const lineageCount = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM derived_lineage`)[0]!.n;

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

describe("recordLineage", () => {
  it("links every derived row to every source, and a repeat adds nothing", async () => {
    const [m1, m2] = [await row(userId, "gmail", "m1"), await row(userId, "gmail", "m2")];
    const [f1, f2] = [await derived("f1"), await derived("f2")];
    expect(await recordLineage(sql, userId, [f1, f2], [m1, m2])).toBe(4);
    expect(await lineageCount()).toBe(4);
    expect(await recordLineage(sql, userId, [f1, f2], [m1, m2])).toBe(0);
    expect(await recordLineage(sql, userId, [f1], [m1])).toBe(0);
    expect(await lineageCount()).toBe(4);
    expect(await recordLineage(sql, userId, [], [m1])).toBe(0);
  });

  it("skips ids that are not the person's, and a link from a non-derived row", async () => {
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    const mine = await row(userId, "gmail", "m1");
    const theirs = await row(other, "gmail", "t1");
    const fact = await derived("f1");
    const theirFact = await derived("tf", other);
    expect(await recordLineage(sql, userId, [fact], [theirs])).toBe(0);
    expect(await recordLineage(sql, userId, [theirFact], [mine])).toBe(0);
    expect(await recordLineage(sql, userId, [mine], [mine])).toBe(0);
    expect(await lineageCount()).toBe(0);
  });
});

describe("deleting sources takes the derived rows read from them", () => {
  it("undoing an import deletes the facts read from it, and only those", async () => {
    const first = await ingestActivityEvents(
      sql,
      {
        events: [{ id: "m1", source: "gmail", kind: "message", start: "2026-11-01T00:00:00Z" }],
        import: { sha256: sha("a"), filename: "mail.mbox" }
      },
      "agent-a",
      now
    );
    const importId = first.importId!;
    const [kept] = [await row(userId, "gmail", "outside")];
    const [m1] = (await sql<{ id: string }[]>`SELECT id FROM activity_events WHERE event_key = 'm1'`).map((r) => r.id);
    const [gone, stays] = [await derived("from-import"), await derived("from-outside")];
    await recordLineage(sql, userId, [gone], [m1!]);
    await recordLineage(sql, userId, [stays], [kept]);
    expect(await deleteActivityImport(sql, importId)).toEqual({ deleted: true, removed: 1 });
    expect(await keys("derived")).toEqual(["from-outside"]);
    expect(await lineageCount()).toBe(1);
  });

  it("purging a source across the 5000-row batch boundary deletes every fact read from it", async () => {
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start)
              SELECT ${userId}, 'gmail', 'message', 'k' || g, '2026-01-01T00:00:00Z'::timestamptz + g * interval '1 second'
              FROM generate_series(1, 10001) g`;
    const ends = await sql<{ id: string }[]>`
      (SELECT id FROM activity_events WHERE source = 'gmail' ORDER BY ctid LIMIT 1)
      UNION ALL (SELECT id FROM activity_events WHERE source = 'gmail' ORDER BY ctid DESC LIMIT 1)`;
    const middle = await sql<{ id: string }[]>`
      SELECT id FROM activity_events WHERE source = 'gmail' ORDER BY ctid OFFSET 5000 LIMIT 1`;
    const early = await derived("early");
    const late = await derived("late");
    const straddling = await derived("straddling");
    await recordLineage(sql, userId, [early], [ends[0]!.id]);
    await recordLineage(sql, userId, [late], [ends[1]!.id]);
    await recordLineage(sql, userId, [straddling], [ends[0]!.id, middle[0]!.id, ends[1]!.id]);
    const steam = await row(userId, "steam", "s1");
    const survivor = await derived("survivor");
    await recordLineage(sql, userId, [survivor], [steam]);

    expect(await purgeActivitySource(sql, "gmail")).toEqual({ removed: 10001 });
    expect(await keys("derived")).toEqual(["survivor"]);
    expect(await keys("steam")).toEqual(["s1"]);
    expect(await lineageCount()).toBe(1);
  });

  it("keeps a two-source fact until its last source goes", async () => {
    const mail = await row(userId, "gmail", "m1");
    const chat = await row(userId, "spotify", "c1");
    const fact = await derived("both");
    await recordLineage(sql, userId, [fact], [mail, chat]);

    await purgeActivitySource(sql, "gmail");
    expect(await keys("derived")).toEqual(["both"]);
    expect(await lineageCount()).toBe(1);

    await purgeActivitySource(sql, "spotify");
    expect(await keys("derived")).toEqual([]);
    expect(await lineageCount()).toBe(0);
  });

  it("removes a two-source fact in one pass when both sources are in the batch", async () => {
    const a = await row(userId, "gmail", "a");
    const b = await row(userId, "gmail", "b");
    const fact = await derived("both");
    await recordLineage(sql, userId, [fact], [a, b]);
    expect(await sql.begin((tx) => deleteDerivedForSources(tx, userId, [a]))).toBe(0);
    expect(await sql.begin((tx) => deleteDerivedForSources(tx, userId, [a, b]))).toBe(1);
    expect(await keys("derived")).toEqual([]);
  });

  it("never touches another person's rows, even when given their source ids", async () => {
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    const theirSource = await row(other, "gmail", "t1");
    const theirFact = await derived("theirs", other);
    await recordLineage(sql, other, [theirFact], [theirSource]);
    const mine = await row(userId, "gmail", "m1");
    const myFact = await derived("mine");
    await recordLineage(sql, userId, [myFact], [mine]);

    expect(await sql.begin((tx) => deleteDerivedForSources(tx, userId, [theirSource]))).toBe(0);
    await purgeActivitySource(sql, "gmail");
    expect(await keys("derived")).toEqual(["theirs"]);
    expect(await lineageCount()).toBe(0 + 1);
    expect(await sql`SELECT 1 FROM activity_events WHERE user_id = ${other} AND source = 'gmail'`).toHaveLength(1);
  });

  it("cascades with the user: deleting the person removes their events and lineage", async () => {
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    const source = await row(other, "gmail", "t1");
    const fact = await derived("theirs", other);
    await recordLineage(sql, other, [fact], [source]);
    await sql`INSERT INTO extractor_state (user_id, extractor, version) VALUES (${other}, 'msg_class', 'v1')`;
    const mine = await row(userId, "gmail", "m1");
    const myFact = await derived("mine");
    await recordLineage(sql, userId, [myFact], [mine]);

    await sql`DELETE FROM users WHERE id = ${other}`;
    expect(await keys("derived")).toEqual(["mine"]);
    expect(await lineageCount()).toBe(1);
    expect(await sql`SELECT 1 FROM extractor_state`).toHaveLength(0);
  });
});

describe("extractor_state", () => {
  it("allows many versions of an extractor but one active version", async () => {
    await sql`INSERT INTO extractor_state (user_id, extractor, version, active) VALUES (${userId}, 'msg_class', 'v1', true)`;
    await sql`INSERT INTO extractor_state (user_id, extractor, version, active) VALUES (${userId}, 'msg_class', 'v2', false)`;
    await sql`INSERT INTO extractor_state (user_id, extractor, version, active) VALUES (${userId}, 'fact', 'v1', true)`;
    await expect(
      sql`INSERT INTO extractor_state (user_id, extractor, version, active) VALUES (${userId}, 'msg_class', 'v3', true)`
    ).rejects.toMatchObject({ code: "23505" });
    await sql.begin(async (tx) => {
      await tx`UPDATE extractor_state SET active = false WHERE extractor = 'msg_class' AND version = 'v1'`;
      await tx`UPDATE extractor_state SET active = true WHERE extractor = 'msg_class' AND version = 'v2'`;
    });
    const active = await sql<{ extractor: string; version: string }[]>`
      SELECT extractor, version FROM extractor_state WHERE active ORDER BY extractor`;
    expect(active).toEqual([
      { extractor: "fact", version: "v1" },
      { extractor: "msg_class", version: "v2" }
    ]);
  });

  it("defaults to inactive with no progress, and refuses a repeat of the same version", async () => {
    await sql`INSERT INTO extractor_state (user_id, extractor, version) VALUES (${userId}, 'msg_class', 'v1')`;
    const [state] = await sql<Record<string, unknown>[]>`SELECT * FROM extractor_state`;
    expect(state).toMatchObject({ active: false, cursor: null, last_ok_at: null, last_error: null });
    await expect(
      sql`INSERT INTO extractor_state (user_id, extractor, version) VALUES (${userId}, 'msg_class', 'v1')`
    ).rejects.toMatchObject({ code: "23505" });
  });
});
