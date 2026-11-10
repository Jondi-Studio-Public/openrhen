import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { markCheckInShown, readAnsweredCheckIns, readCurrentCheckIn } from "./readers/check-in-read";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_check_in_shown");

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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE check_in CASCADE");
});

afterAll(async () => {
  await sql?.end();
});

async function insertCheckIn(status = "pending"): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO check_in (user_id,slot_at,directive_kind,directive_title,status)
    VALUES (${userId}, now(), 'action', 'Write section 2', ${status}) RETURNING id
  `;
  return row!.id;
}

const promptedAt = async (id: string) =>
  (await sql<{ prompted_at: Date | null }[]>`SELECT prompted_at FROM check_in WHERE id=${id}`)[0]!.prompted_at;

describe("reading for the client view does not stamp prompted_at", () => {
  it("leaves prompted_at null on a peek, and stamps on the portal's own read", async () => {
    const id = await insertCheckIn();
    expect((await readCurrentCheckIn(sql, userId, { stamp: false }))?.id).toBe(id);
    expect(await promptedAt(id)).toBeNull();
    await readCurrentCheckIn(sql, userId);
    expect(await promptedAt(id)).not.toBeNull();
  });
});

describe("markCheckInShown", () => {
  it("stamps prompted_at on the first call and keeps the first time on every repeat", async () => {
    const id = await insertCheckIn();
    const first = await markCheckInShown(sql, userId, id);
    expect(first).toMatchObject({ id, status: "pending", stamped: true });
    const stored = await promptedAt(id);
    expect(stored?.toISOString()).toBe(first?.promptedAt);
    const again = await markCheckInShown(sql, userId, id);
    expect(again).toMatchObject({ stamped: false, promptedAt: first?.promptedAt });
    expect((await promptedAt(id))?.toISOString()).toBe(first?.promptedAt);
  });

  it("does not move the timeout of a row that is answered or timed out, and answers what is stored", async () => {
    const answered = await insertCheckIn("on_track");
    expect(await markCheckInShown(sql, userId, answered)).toMatchObject({
      status: "on_track",
      promptedAt: null,
      stamped: false
    });
    expect(await promptedAt(answered)).toBeNull();
    const timedOut = await insertCheckIn("unknown");
    expect(await markCheckInShown(sql, userId, timedOut)).toMatchObject({ status: "unknown", stamped: false });
    expect(await promptedAt(timedOut)).toBeNull();
  });

  it("is null for an id that is not this user's, and never stamps another user's row", async () => {
    const id = await insertCheckIn();
    const [other] = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Someone else') RETURNING id`;
    expect(await markCheckInShown(sql, userId, "11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(await markCheckInShown(sql, other!.id, id)).toBeNull();
    expect(await promptedAt(id)).toBeNull();
    await sql`DELETE FROM users WHERE id=${other!.id}`;
  });
});

describe("readAnsweredCheckIns", () => {
  const answer = (status: string, at: string, note: string | null, source: string | null) => sql<{ id: string }[]>`
    INSERT INTO check_in (user_id,slot_at,directive_kind,directive_title,status,answered_at,deviation_note,answer_source,tags)
    VALUES (${userId}, ${at}, 'action', 'Write section 2', ${status}, ${at}, ${note}, ${source},
      ${sql.json([{ tag: "tired", mark: "stated" }])})
    RETURNING id`;

  it("lists answered rows newest first with id, words, tags and source, and leaves out unanswered and superseded", async () => {
    const [older] = await answer("on_track", "2026-11-09T01:00:00Z", null, "sheet");
    const [newer] = await answer("deviated", "2026-11-09T02:00:00Z", "a loud neighbour", "app");
    await insertCheckIn("pending");
    await insertCheckIn("unknown");
    await sql`INSERT INTO check_in (user_id,slot_at,directive_kind,directive_title,status,answered_at)
      VALUES (${userId}, now(), 'action', 'x', 'superseded', now())`;
    const rows = await readAnsweredCheckIns(sql, userId);
    expect(rows.map((r) => r.id)).toEqual([newer!.id, older!.id]);
    expect(rows[0]).toMatchObject({
      status: "deviated",
      deviationNote: "a loud neighbour",
      answerSource: "app",
      answeredAt: "2026-11-09T02:00:00.000Z",
      tags: [{ tag: "tired", mark: "stated" }]
    });
  });

  it("pages with since, before and limit, and never returns another user's rows", async () => {
    await answer("on_track", "2026-11-09T01:00:00Z", null, "sheet");
    const [mid] = await answer("on_track", "2026-11-09T02:00:00Z", null, "sheet");
    await answer("on_track", "2026-11-09T03:00:00Z", null, "sheet");
    expect(await readAnsweredCheckIns(sql, userId, { limit: 2 })).toHaveLength(2);
    const page = await readAnsweredCheckIns(sql, userId, {
      since: new Date("2026-11-09T02:00:00Z"),
      before: new Date("2026-11-09T03:00:00Z")
    });
    expect(page.map((r) => r.id)).toEqual([mid!.id]);
    const [other] = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Someone else') RETURNING id`;
    expect(await readAnsweredCheckIns(sql, other!.id)).toEqual([]);
    await sql`DELETE FROM users WHERE id=${other!.id}`;
  });
});
