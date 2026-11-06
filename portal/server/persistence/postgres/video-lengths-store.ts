import {
  VIDEO_DURATIONS_BATCH,
  YOUTUBE_DAILY_UNIT_LIMIT,
  YOUTUBE_VIDEO_ID,
  type WatchLengthsFetchResult
} from "@openrhen/contracts";
import { fetchVideoLengths, type VideoLengthsOutcome } from "@/integrations/youtube/youtube-proxy-client";
import type { PoolSql, Sql } from "./sql-pool";
import { ensureUser } from "./ensure-user";

/**
 * Fills `video_info` with the length of each video in the watch history that has none, through the outbound proxy
 * and the person's saved YouTube key (the key never passes through this file: `fetchVideoLengths` reads and sends it).
 * Only Takeout watches count (ads, posts and YouTube Music are skipped), and a synthetic `x:` id for a removed
 * video is never looked up. A run is bounded (`maxBatches` calls of 50 ids), so the caller repeats it while
 * `remaining` falls. It stops at once on a quota, key or network failure and the next run resumes where it left
 * off, because only fetched videos are stored. Nothing is guessed: a video is unavailable only when Google says so.
 */

/** Calls one run makes at most: 20 x 50 = 1,000 videos, so a request stays short. */
export const LENGTH_BATCHES_PER_RUN = 20;
export const LENGTH_MESSAGES = {
  no_key: "Add a YouTube API key in Settings > Passwords and keys to estimate time from video lengths.",
  key_unreadable:
    "The saved YouTube key can no longer be opened (the secrets key changed). Enter it again in Settings > Passwords and keys.",
  bad_key:
    "Google did not accept the YouTube key. Check it in Settings > Passwords and keys, and that the YouTube Data API v3 is enabled for it.",
  rate_limited: "YouTube asked for a short pause. Nothing was lost; try again in a minute.",
  quota: "YouTube's daily quota is used up. Lengths resume on the next run, after midnight Pacific time.",
  unreachable: "Could not reach YouTube just now. Nothing was lost; try again later.",
  not_ready:
    "The outbound proxy is not set up (check OUTBOUND_PROXY_URL and OUTBOUND_PROXY_TOKEN in .env, and that the token is not the placeholder), so video lengths cannot be fetched."
} as const;

type Stop = NonNullable<WatchLengthsFetchResult["stopped"]>;
const STOP_OF: Record<Exclude<VideoLengthsOutcome["kind"], "ok">, Stop> = {
  no_key: "no_key",
  key_unreadable: "key_unreadable",
  bad_key: "bad_key",
  quota: "quota",
  rate_limited: "rate_limited",
  unreachable: "unreachable",
  not_ready: "not_ready"
};

export interface LengthsDeps {
  /** Replaced in tests. */
  fetchLengths?: typeof fetchVideoLengths;
  maxBatches?: number;
}

/** The watched videos (Takeout YouTube watches, real ids) that have no row in `video_info`. */
const withoutLength = (sql: Sql, userId: string) => sql`
  FROM watch_events e
  WHERE e.user_id = ${userId} AND e.source = 'youtube_takeout' AND e.kind = 'watch' AND e.video_id NOT LIKE 'x:%'
    AND NOT EXISTS (SELECT 1 FROM video_info v WHERE v.video_id = e.video_id)`;

/** Distinct watched videos with no stored length. */
export async function countMissingLengths(sql: Sql, userId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`SELECT count(DISTINCT e.video_id)::int AS n ${withoutLength(sql, userId)}`;
  return row?.n ?? 0;
}

/** Google resets the quota at midnight Pacific time, so the quota day is the Pacific date. */
const quotaDay = (sql: Sql) => sql`(now() AT TIME ZONE 'America/Los_Angeles')::date`;

async function quotaUsedUp(sql: Sql, userId: string): Promise<boolean> {
  const [row] = await sql<{ used_up: boolean }[]>`
    SELECT (exhausted_at IS NOT NULL OR units_spent >= ${YOUTUBE_DAILY_UNIT_LIMIT}) AS used_up
    FROM youtube_quota_use WHERE user_id = ${userId} AND quota_date = ${quotaDay(sql)}`;
  return row?.used_up ?? false;
}

/** Counts one call's unit against today, or (`exhausted`) records that Google said the day's quota is gone. */
async function spendUnit(sql: Sql, userId: string, exhausted: boolean): Promise<void> {
  if (exhausted)
    await sql`
      INSERT INTO youtube_quota_use (user_id, quota_date, units_spent, exhausted_at)
      VALUES (${userId}, ${quotaDay(sql)}, 0, now())
      ON CONFLICT (user_id, quota_date) DO UPDATE SET exhausted_at = COALESCE(youtube_quota_use.exhausted_at, now())`;
  else
    await sql`
      INSERT INTO youtube_quota_use (user_id, quota_date, units_spent) VALUES (${userId}, ${quotaDay(sql)}, 1)
      ON CONFLICT (user_id, quota_date) DO UPDATE SET units_spent = youtube_quota_use.units_spent + 1`;
}

async function store(
  sql: Sql,
  videos: readonly { id: string; durationS: number | null; unavailable: boolean }[]
): Promise<void> {
  if (videos.length === 0) return;
  await sql`
    INSERT INTO video_info ${sql(videos.map((v) => ({ video_id: v.id, duration_s: v.durationS, unavailable: v.unavailable })))}
    ON CONFLICT (video_id) DO UPDATE
      SET duration_s = EXCLUDED.duration_s, unavailable = EXCLUDED.unavailable, fetched_at = now()
  `;
}

export async function fetchMissingVideoLengths(sql: PoolSql, deps: LengthsDeps = {}): Promise<WatchLengthsFetchResult> {
  const userId = await ensureUser(sql);
  const fetchLengths = deps.fetchLengths ?? fetchVideoLengths;
  const maxBatches = deps.maxBatches ?? LENGTH_BATCHES_PER_RUN;
  let fetched = 0;
  const done = async (stopped: Stop | null, message?: string): Promise<WatchLengthsFetchResult> => {
    const remaining = await countMissingLengths(sql, userId);
    return {
      fetched,
      remaining,
      stopped,
      message:
        message ??
        (stopped
          ? LENGTH_MESSAGES[stopped]
          : remaining === 0
            ? fetched === 0
              ? "Every watched video already has its length."
              : `Looked up ${fetched} video${fetched === 1 ? "" : "s"}; every watched video now has its length.`
            : `Looked up ${fetched} video${fetched === 1 ? "" : "s"}; ${remaining} still to do.`)
    };
  };

  if (await quotaUsedUp(sql, userId)) return done("quota");
  const ids = (
    await sql<{ video_id: string }[]>`
      SELECT DISTINCT e.video_id ${withoutLength(sql, userId)} ORDER BY e.video_id LIMIT ${maxBatches * VIDEO_DURATIONS_BATCH}`
  ).map((row) => row.video_id);
  // An id that is not eleven characters of the id alphabet is no YouTube video, so there is nothing to ask Google.
  const malformed = ids.filter((id) => !YOUTUBE_VIDEO_ID.test(id));
  await store(
    sql,
    malformed.map((id) => ({ id, durationS: null, unavailable: true }))
  );
  fetched += malformed.length;
  const valid = ids.filter((id) => YOUTUBE_VIDEO_ID.test(id));

  for (let at = 0; at < valid.length; at += VIDEO_DURATIONS_BATCH) {
    if (await quotaUsedUp(sql, userId)) return done("quota");
    const outcome = await fetchLengths(sql, userId, valid.slice(at, at + VIDEO_DURATIONS_BATCH));
    if (outcome.kind !== "ok") {
      if (outcome.kind === "quota") await spendUnit(sql, userId, true);
      return done(STOP_OF[outcome.kind]);
    }
    await store(sql, outcome.videos);
    await spendUnit(sql, userId, false);
    fetched += outcome.videos.length;
  }
  return done(null);
}
