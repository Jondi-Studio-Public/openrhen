import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { parseWatchHistoryJson } from "@/server/imports/watch-history-parser";
import { ensureUser } from "./ensure-user";
import {
  deleteWatchImport,
  importWatchHistory,
  readWatchHistoryReview,
  WatchHistoryInputError
} from "./watch-history-store";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_watch_history");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const entry = (videoId: string, time: string, extra: Record<string, unknown> = {}) => ({
  header: "YouTube",
  title: `Watched Video ${videoId}`,
  titleUrl: `https://www.youtube.com/watch?v=${videoId}`,
  subtitles: [{ name: "Channel" }],
  time,
  ...extra
});
const file = (entries: unknown[]) => parseWatchHistoryJson(JSON.stringify(entries));
const count = async (table: string) =>
  (await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n;

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

describe("importing a watch history", () => {
  it("adds every entry once and is idempotent on a repeat upload", async () => {
    const parsed = file([
      entry("aaaaaaaaaa1", "2026-11-01T10:00:00.5Z"),
      entry("aaaaaaaaaa1", "2026-11-01T10:00:00Z"), // same video, same second: both are real
      entry("bbbbbbbbbb2", "2026-11-01T10:05:00Z"),
      entry("cccccccccc3", "2026-11-01T10:06:00Z", { details: [{ name: "From Google Ads" }] }),
      entry("dddddddddd4", "2026-11-01T10:07:00Z", { header: "YouTube Music" }),
      { title: "Watched no time", titleUrl: "https://www.youtube.com/watch?v=eeeeeeeeee5" }
    ]);
    const first = await importWatchHistory(sql, "watch-history.json", parsed);
    expect(first).toMatchObject({ read: 5, added: 5, alreadyHeld: 0, skipped: 1, watches: 3, ads: 1, music: 1 });
    expect(first.importId).toBeTruthy();
    expect(await count("watch_events")).toBe(5);

    const again = await importWatchHistory(sql, "watch-history.json", parsed);
    expect(again).toMatchObject({ importId: null, added: 0, alreadyHeld: 5 });
    expect(await count("watch_events")).toBe(5);
    expect(await count("watch_imports")).toBe(1);
  });

  it("treats a file with fractional seconds and the same file without them as one watch", async () => {
    await importWatchHistory(sql, "a.json", file([entry("aaaaaaaaaa1", "2026-11-01T10:00:00.250Z")]));
    const second = await importWatchHistory(
      sql,
      "b.json",
      file([entry("aaaaaaaaaa1", "2026-11-01T10:00:00Z"), entry("bbbbbbbbbb2", "2026-11-01T11:00:00Z")])
    );
    expect(second).toMatchObject({ added: 1, alreadyHeld: 1 });
  });

  it("inserts more than one batch of rows in one go", async () => {
    const many = Array.from({ length: 2500 }, (_, i) =>
      entry(`v${String(i).padStart(9, "0")}`, new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString())
    );
    const result = await importWatchHistory(sql, "big.json", file(many));
    expect(result.added).toBe(2500);
    expect(await count("watch_events")).toBe(2500);
  });

  it("undoes one import and only that import", async () => {
    const one = await importWatchHistory(sql, "one.json", file([entry("aaaaaaaaaa1", "2026-11-01T10:00:00Z")]));
    await importWatchHistory(sql, "two.json", file([entry("bbbbbbbbbb2", "2026-11-02T10:00:00Z")]));
    expect(await deleteWatchImport(sql, one.importId!)).toBe(true);
    expect(await count("watch_events")).toBe(1);
    expect(await count("watch_imports")).toBe(1);
    expect(await deleteWatchImport(sql, one.importId!)).toBe(false);
    // Undone, the same file imports again.
    expect(
      await importWatchHistory(sql, "one.json", file([entry("aaaaaaaaaa1", "2026-11-01T10:00:00Z")]))
    ).toMatchObject({ added: 1 });
  });

  it("does not delete another person's import", async () => {
    const other = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`;
    const [imported] = await sql<{ id: string }[]>`
      INSERT INTO watch_imports (user_id, filename) VALUES (${other[0]!.id}, 'x.json') RETURNING id
    `;
    expect(await deleteWatchImport(sql, imported!.id)).toBe(false);
    expect(await count("watch_imports")).toBe(1);
  });
});

describe("the review read", () => {
  const now = new Date("2026-11-06T12:00:00Z");

  it("counts watches per local day and hour in the person's zone, leaving out ads, posts and music", async () => {
    await sql`UPDATE users SET timezone = 'Asia/Tokyo' WHERE id = ${userId}`;
    await importWatchHistory(
      sql,
      "w.json",
      file([
        // 23:30 UTC on 1 Nov is 08:30 on 2 Nov in Tokyo.
        entry("aaaaaaaaaa1", "2026-11-01T23:30:00Z"),
        entry("bbbbbbbbbb2", "2026-11-01T23:40:00Z"),
        entry("cccccccccc3", "2026-11-03T00:00:00Z"),
        entry("dddddddddd4", "2026-11-03T00:10:00Z", { details: [{ name: "From Google Ads" }] }),
        entry("eeeeeeeeee5", "2026-11-03T00:20:00Z", { header: "YouTube Music" }),
        { title: "Viewed post", titleUrl: "https://www.youtube.com/post/Ugk1", time: "2026-11-03T00:30:00Z" }
      ])
    );
    const review = await readWatchHistoryReview(sql, userId, { from: "2026-11-01", to: "2026-11-04" }, now);
    expect(review).toMatchObject({
      timezone: "Asia/Tokyo",
      from: "2026-11-01",
      to: "2026-11-04",
      hasData: true,
      total: 3
    });
    expect(review.days).toEqual([
      { date: "2026-11-01", count: 0 },
      { date: "2026-11-02", count: 2 },
      { date: "2026-11-03", count: 1 },
      { date: "2026-11-04", count: 0 }
    ]);
    expect(review.hours[8]).toBe(2);
    expect(review.hours[9]).toBe(1);
    expect(review.excluded).toEqual({ ads: 1, posts: 1, music: 1 });
    expect(review.imports).toHaveLength(1);
    // 8:30 and 8:40 are ten minutes apart; 8:40 to 9:00 on the 3rd is a day later, so a new session.
    expect(review.estimate).toMatchObject({ videos: 3, sessions: 2, lowMin: 0, highMin: 10, unknownCount: 2 });
  });

  it("defaults to the last 30 local days ending today, and says nothing was imported when so", async () => {
    const empty = await readWatchHistoryReview(sql, userId, {}, now);
    expect(empty).toMatchObject({ hasData: false, total: 0, to: "2026-11-06", from: "2026-10-08" });
    expect(empty.days).toHaveLength(30);
    expect(empty.estimate.videos).toBe(0);
  });

  it("keeps a 23-hour and a 25-hour day whole across clock changes", async () => {
    await sql`UPDATE users SET timezone = 'America/New_York' WHERE id = ${userId}`;
    // Hourly, around the clock, across New York's 2026-03-08 (23 h) and 2026-11-01 (25 h).
    const hourly = (startUtc: string, hours: number) =>
      Array.from({ length: hours }, (_, i) =>
        entry(
          `s${startUtc.slice(5, 10).replace("-", "")}${String(i).padStart(2, "0")}`.padEnd(11, "x"),
          new Date(Date.parse(startUtc) + i * 3_600_000).toISOString()
        )
      );
    await importWatchHistory(
      sql,
      "dst.json",
      file([...hourly("2026-03-08T05:00:00Z", 23), ...hourly("2026-11-01T04:00:00Z", 25)])
    );
    const spring = await readWatchHistoryReview(sql, userId, { from: "2026-03-08", to: "2026-03-08" }, now);
    const fall = await readWatchHistoryReview(sql, userId, { from: "2026-11-01", to: "2026-11-01" }, now);
    expect(spring.days).toEqual([{ date: "2026-03-08", count: 23 }]);
    expect(fall.days).toEqual([{ date: "2026-11-01", count: 25 }]);
    // The repeated 01:00 hour on the fall-back day lands in hour 1 twice.
    expect(fall.hours[1]).toBe(2);
    expect(spring.hours[2]).toBe(0);
  });

  it("rejects bad dates and ranges instead of guessing", async () => {
    await expect(readWatchHistoryReview(sql, userId, { from: "yesterday" }, now)).rejects.toThrow(
      WatchHistoryInputError
    );
    await expect(readWatchHistoryReview(sql, userId, { from: "2026-11-05", to: "2026-11-01" }, now)).rejects.toThrow(
      /not be after/
    );
    await expect(readWatchHistoryReview(sql, userId, { from: "2024-01-01", to: "2026-11-01" }, now)).rejects.toThrow(
      /at most 366/
    );
    await expect(readWatchHistoryReview(sql, userId, { from: "2026-02-30" }, now)).rejects.toThrow(
      WatchHistoryInputError
    );
  });
});
