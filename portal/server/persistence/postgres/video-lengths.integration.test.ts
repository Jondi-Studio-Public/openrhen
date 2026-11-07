import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { parseWatchHistoryJson } from "@/server/imports/watch-history-parser";
import { importWatchHistory, readWatchHistoryReview } from "./watch-history-store";
import { countMissingLengths, fetchMissingVideoLengths } from "./video-lengths-store";
import type { VideoLengthsOutcome } from "@/integrations/youtube/youtube-proxy-client";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_video_lengths");

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
  await sql.unsafe("TRUNCATE TABLE users, video_info RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

const entry = (videoId: string, time: string, extra: Record<string, unknown> = {}) => ({
  header: "YouTube",
  title: `Watched Video ${videoId}`,
  titleUrl: `https://www.youtube.com/watch?v=${videoId}`,
  subtitles: [{ name: "Channel" }],
  time,
  ...extra
});
const A = "aaaaaaaaaaa";
const B = "bbbbbbbbbbb";
const C = "ccccccccccc";

async function seed(entries: unknown[]) {
  await importWatchHistory(sql, "w.json", parseWatchHistoryJson(JSON.stringify(entries)));
}
const infoRows = () =>
  sql<{ video_id: string; duration_s: number | null; unavailable: boolean }[]>`
    SELECT video_id, duration_s, unavailable FROM video_info ORDER BY video_id`;
const quotaRows = () =>
  sql<{ units_spent: number; exhausted_at: Date | null }[]>`SELECT units_spent, exhausted_at FROM youtube_quota_use`;

const answering = (videos: Record<string, number | null>, missing: string[] = []) =>
  vi.fn(async (_sql: unknown, _user: string, ids: readonly string[]): Promise<VideoLengthsOutcome> => ({
    kind: "ok",
    videos: ids.map((id) => ({
      id,
      durationS: videos[id] ?? null,
      unavailable: missing.includes(id)
    }))
  }));

describe("fetching video lengths", () => {
  it("looks up each watched video once, stores the answers, and counts one quota unit a call", async () => {
    await seed([
      entry(A, "2026-11-01T10:00:00Z"),
      entry(A, "2026-11-01T10:30:00Z"),
      entry(B, "2026-11-01T11:00:00Z"),
      entry(C, "2026-11-01T11:10:00Z")
    ]);
    const fetchLengths = answering({ [A]: 240, [B]: 600 }, [C]);
    const result = await fetchMissingVideoLengths(sql, { fetchLengths });
    expect(fetchLengths).toHaveBeenCalledTimes(1);
    expect(fetchLengths.mock.calls[0]![2]).toEqual([A, B, C]);
    expect(result).toMatchObject({ fetched: 3, remaining: 0, stopped: null });
    expect(await infoRows()).toEqual([
      { video_id: A, duration_s: 240, unavailable: false },
      { video_id: B, duration_s: 600, unavailable: false },
      { video_id: C, duration_s: null, unavailable: true }
    ]);
    expect((await quotaRows())[0]).toMatchObject({ units_spent: 1, exhausted_at: null });
    // A second run has nothing to do and makes no call.
    const again = answering({});
    expect(await fetchMissingVideoLengths(sql, { fetchLengths: again })).toMatchObject({
      fetched: 0,
      remaining: 0,
      stopped: null
    });
    expect(again).not.toHaveBeenCalled();
  });

  it("skips ads, posts, YouTube Music and synthetic ids, and marks a malformed id unavailable without asking Google", async () => {
    await seed([
      entry(A, "2026-11-01T10:00:00Z"),
      entry(B, "2026-11-01T10:05:00Z", { details: [{ name: "From Google Ads" }] }),
      entry(C, "2026-11-01T10:06:00Z", { header: "YouTube Music" }),
      {
        header: "YouTube",
        title: "Watched A video that has been removed",
        time: "2026-11-01T10:07:00Z"
      },
      entry("shortid", "2026-11-01T10:08:00Z")
    ]);
    const fetchLengths = answering({ [A]: 100 });
    await fetchMissingVideoLengths(sql, { fetchLengths });
    expect(fetchLengths.mock.calls.flatMap((call) => call[2])).toEqual([A]);
    const rows = await infoRows();
    expect(rows.find((row) => row.video_id === "shortid")).toEqual({
      video_id: "shortid",
      duration_s: null,
      unavailable: true
    });
    expect(rows.some((row) => row.video_id === B || row.video_id === C || row.video_id.startsWith("x:"))).toBe(false);
  });

  it("batches fifty ids a call and stops after the per-run limit, leaving the rest for the next run", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `v${String(i).padStart(10, "0")}`);
    await seed(
      ids.map((id, i) =>
        entry(
          id,
          `2026-11-01T${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`
        )
      )
    );
    const fetchLengths = answering(Object.fromEntries(ids.map((id) => [id, 60])));
    const first = await fetchMissingVideoLengths(sql, { fetchLengths, maxBatches: 2 });
    expect(fetchLengths.mock.calls.map((call) => call[2].length)).toEqual([50, 50]);
    expect(first).toMatchObject({ fetched: 100, remaining: 20, stopped: null });
    const second = await fetchMissingVideoLengths(sql, { fetchLengths, maxBatches: 2 });
    expect(second).toMatchObject({ fetched: 20, remaining: 0 });
    expect((await infoRows()).length).toBe(120);
  });

  it("stops cleanly on a quota error, keeps what it fetched, records the day as used up, and asks no more that day", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `v${String(i).padStart(10, "0")}`);
    await seed(
      ids.map((id, i) =>
        entry(id, `2026-11-01T10:${String(i % 60).padStart(2, "0")}:00Z`.replace("T10", `T${10 + Math.floor(i / 60)}`))
      )
    );
    const fetchLengths = vi
      .fn()
      .mockImplementationOnce(async (_s: unknown, _u: string, batch: readonly string[]) => ({
        kind: "ok",
        videos: batch.map((id) => ({ id, durationS: 60, unavailable: false }))
      }))
      .mockResolvedValueOnce({ kind: "quota" });
    const result = await fetchMissingVideoLengths(sql, { fetchLengths });
    expect(result).toMatchObject({ fetched: 50, remaining: 70, stopped: "quota" });
    expect(result.message).toMatch(/quota is used up/);
    expect((await infoRows()).length).toBe(50);
    expect((await quotaRows())[0]!.exhausted_at).not.toBeNull();
    const retry = vi.fn();
    expect(await fetchMissingVideoLengths(sql, { fetchLengths: retry })).toMatchObject({
      stopped: "quota",
      remaining: 70
    });
    expect(retry).not.toHaveBeenCalled();
    // Next quota day: the counter is per day, so a fresh day resumes.
    await sql`UPDATE youtube_quota_use SET quota_date = quota_date - 1`;
    const resumed = answering(Object.fromEntries(ids.map((id) => [id, 60])));
    expect(await fetchMissingVideoLengths(sql, { fetchLengths: resumed })).toMatchObject({
      fetched: 70,
      remaining: 0,
      stopped: null
    });
  });

  it("stops on no key, an unreadable key, a bad key and no network, storing nothing and fabricating nothing", async () => {
    await seed([entry(A, "2026-11-01T10:00:00Z")]);
    const cases: [VideoLengthsOutcome["kind"], string][] = [
      ["no_key", "no_key"],
      ["key_unreadable", "key_unreadable"],
      ["bad_key", "bad_key"],
      ["unreachable", "unreachable"],
      ["not_ready", "not_ready"]
    ];
    for (const [kind, stopped] of cases) {
      const result = await fetchMissingVideoLengths(sql, {
        fetchLengths: vi.fn(async () => ({ kind }) as VideoLengthsOutcome)
      });
      expect(result).toMatchObject({ fetched: 0, remaining: 1, stopped });
      expect(result.message.length).toBeGreaterThan(10);
    }
    expect((await infoRows()).length).toBe(0);
    expect(await countMissingLengths(sql, userId)).toBe(1);
    expect((await quotaRows()).length).toBe(0);
  });

  it("says to add a key, in the words the panel uses, when there is none", async () => {
    await seed([entry(A, "2026-11-01T10:00:00Z")]);
    const result = await fetchMissingVideoLengths(sql, {
      fetchLengths: vi.fn(async () => ({ kind: "no_key" }) as VideoLengthsOutcome)
    });
    expect(result.message).toBe(
      "Add a YouTube API key in Settings > Passwords and keys to estimate time from video lengths."
    );
  });
});

describe("the Review estimate with lengths", () => {
  const NOW = new Date("2026-11-02T00:00:00Z");

  it("uses a known length: min(gap, length) for each video that is followed, up to the length for the last", async () => {
    await seed([entry(A, "2026-11-01T10:00:00Z"), entry(B, "2026-11-01T10:20:00Z"), entry(C, "2026-11-01T10:30:00Z")]);
    await sql`INSERT INTO video_info (video_id, duration_s) VALUES (${A}, 600), (${B}, 3600), (${C}, 900)`;
    const review = await readWatchHistoryReview(sql, userId, { from: "2026-11-01", to: "2026-11-01" }, NOW);
    // A: min(20m gap, 10m) = 10m. B: min(10m gap, 60m) = 10m. C is last: [0, 15m].
    expect(review.estimate).toMatchObject({ lowMin: 20, highMin: 35, unknownCount: 0, videos: 3 });
    expect(review.lengths).toMatchObject({ known: 3, missing: 0, unavailable: 0, quotaPaused: false });
  });

  it("counts a video with no usable length as unknown and says how many lack a length or are unavailable", async () => {
    await seed([entry(A, "2026-11-01T10:00:00Z"), entry(B, "2026-11-01T10:20:00Z"), entry(C, "2026-11-01T11:00:00Z")]);
    await sql`INSERT INTO video_info (video_id, duration_s, unavailable) VALUES (${A}, 600, false), (${B}, NULL, true)`;
    const review = await readWatchHistoryReview(sql, userId, { from: "2026-11-01", to: "2026-11-01" }, NOW);
    expect(review.lengths).toMatchObject({ known: 1, missing: 1, unavailable: 1 });
    // B has no length: its gap to C (40m) counts to the high end only; C is last with no length: unknown.
    expect(review.estimate).toMatchObject({ lowMin: 10, highMin: 50, unknownCount: 1 });
  });

  it("does not count a removed video's synthetic id as missing, so the panel has nothing to fetch forever", async () => {
    await seed([
      entry(A, "2026-11-01T10:00:00Z"),
      {
        header: "YouTube",
        title: "Watched A video that has been removed",
        time: "2026-11-01T10:05:00Z"
      }
    ]);
    await sql`INSERT INTO video_info (video_id, duration_s) VALUES (${A}, 100)`;
    const review = await readWatchHistoryReview(sql, userId, { from: "2026-11-01", to: "2026-11-01" }, NOW);
    expect(review.total).toBe(2);
    expect(review.lengths).toMatchObject({ known: 1, missing: 0, unavailable: 0 });
    expect(await countMissingLengths(sql, userId)).toBe(0);
  });

  it("reports the key's state and a used-up quota", async () => {
    await seed([entry(A, "2026-11-01T10:00:00Z")]);
    expect(
      (await readWatchHistoryReview(sql, userId, { from: "2026-11-01", to: "2026-11-01" }, NOW)).lengths
    ).toMatchObject({
      keyState: "unset",
      quotaPaused: false
    });
    await sql`INSERT INTO youtube_quota_use (user_id, quota_date, units_spent, exhausted_at) VALUES (${userId}, (now() AT TIME ZONE 'America/Los_Angeles')::date, 10, now())`;
    expect(
      (await readWatchHistoryReview(sql, userId, { from: "2026-11-01", to: "2026-11-01" }, NOW)).lengths.quotaPaused
    ).toBe(true);
  });

  it("reports watches held when none fall in the window", async () => {
    await seed([entry(A, "2026-09-01T10:00:00Z"), entry(B, "2026-09-02T10:00:00Z")]);
    const review = await readWatchHistoryReview(sql, userId, {}, NOW);
    expect(review).toMatchObject({ total: 0, watchesHeld: 2, hasData: true });
  });
});
