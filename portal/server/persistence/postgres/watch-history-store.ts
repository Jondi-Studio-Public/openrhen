import {
  WATCH_IMPORT_BATCH_ROWS,
  WATCH_REVIEW_DEFAULT_DAYS,
  WATCH_REVIEW_MAX_DAYS,
  resolveTimezone,
  type WatchHistoryReview,
  type WatchImportResult
} from "@openrhen/contracts";
import { estimateWatchTime } from "@/server/watch-history/estimate";
import type { ParsedWatchHistory } from "@/server/imports/watch-history-parser";
import type { PoolSql, Sql } from "./sql-pool";
import { ensureUser } from "./ensure-user";

/**
 * Watch history: the person's Takeout viewing record. Raw events only, in tables outside the planning inputs, so
 * the engine never sees them and writing them queues no recalculation. Minutes are worked out at read time.
 */

export class WatchHistoryInputError extends Error {}

const DAY_MS = 86_400_000;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Adds days to a plain `YYYY-MM-DD` date in UTC, so no time zone can shift it. */
export function addLocalDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function validDate(value: string): boolean {
  return LOCAL_DATE.test(value) && addLocalDays(value, 0) === value;
}

/** A zone name Postgres and Intl both know; anything else reads as UTC rather than failing the panel. */
function usableZone(stored: string | null | undefined): string {
  const zone = resolveTimezone(stored);
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

export async function importWatchHistory(
  sql: PoolSql,
  filename: string,
  parsed: ParsedWatchHistory
): Promise<WatchImportResult> {
  const userId = await ensureUser(sql);
  const events = parsed.events;
  const counts = { watches: 0, ads: 0, posts: 0, music: 0 };
  let added = 0;
  let importId: string | null = null;
  await sql.begin(async (tx) => {
    const [created] = await tx<{ id: string }[]>`
      INSERT INTO watch_imports (user_id, filename, event_count)
      VALUES (${userId}, ${filename}, 0) RETURNING id
    `;
    const id = created!.id;
    for (let at = 0; at < events.length; at += WATCH_IMPORT_BATCH_ROWS) {
      const batch = events.slice(at, at + WATCH_IMPORT_BATCH_ROWS).map((event) => ({
        user_id: userId,
        import_id: id,
        source: event.source,
        kind: event.kind,
        video_id: event.videoId,
        watched_at: event.watchedAt,
        dup_index: event.dupIndex,
        title: event.title,
        channel: event.channel
      }));
      const inserted = await tx<{ source: string; kind: string }[]>`
        INSERT INTO watch_events ${tx(batch)}
        ON CONFLICT (user_id, source, video_id, watched_at, dup_index) DO NOTHING
        RETURNING source, kind
      `;
      added += inserted.length;
      for (const row of inserted) {
        if (row.source === "youtube_music_takeout") counts.music += 1;
        else if (row.kind === "watch") counts.watches += 1;
        else if (row.kind === "ad") counts.ads += 1;
        else counts.posts += 1;
      }
    }
    if (added === 0) {
      // Nothing new: do not leave an empty import in the list.
      await tx`DELETE FROM watch_imports WHERE id = ${id}`;
    } else {
      await tx`UPDATE watch_imports SET event_count = ${added} WHERE id = ${id}`;
      importId = id;
    }
  });
  return {
    importId,
    read: events.length,
    added,
    alreadyHeld: events.length - added,
    skipped: parsed.skipped,
    ...counts
  };
}

/** Removes one import and every event it added. False when the id is not the person's. */
export async function deleteWatchImport(sql: PoolSql, importId: string): Promise<boolean> {
  const userId = await ensureUser(sql);
  const rows = await sql`DELETE FROM watch_imports WHERE id = ${importId} AND user_id = ${userId} RETURNING id`;
  return rows.length > 0;
}

export interface WatchReviewRange {
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * Counts by local day and local hour, and the time estimate, for a span of local dates (default: the last 30 days
 * ending today in the person's zone). Bucketing is done in SQL with `AT TIME ZONE`, so a day that is 23 or 25
 * hours long on a clock change counts the watches inside it and no others. Only YouTube watches count: ads, posts
 * and YouTube Music are reported under `excluded`.
 */
export async function readWatchHistoryReview(
  sql: Sql,
  userId: string,
  range: WatchReviewRange = {},
  now: Date = new Date()
): Promise<WatchHistoryReview> {
  const [user] = await sql<{ timezone: string | null }[]>`SELECT timezone FROM users WHERE id = ${userId}`;
  const timezone = usableZone(user?.timezone);
  if (range.from !== undefined && !validDate(range.from))
    throw new WatchHistoryInputError("from must be a date as YYYY-MM-DD.");
  if (range.to !== undefined && !validDate(range.to))
    throw new WatchHistoryInputError("to must be a date as YYYY-MM-DD.");
  const [today] = await sql<
    { day: string }[]
  >`SELECT to_char((${now}::timestamptz AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS day`;
  const to = range.to ?? today!.day;
  const from = range.from ?? addLocalDays(to, -(WATCH_REVIEW_DEFAULT_DAYS - 1));
  if (from > to) throw new WatchHistoryInputError("from must not be after to.");
  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  if (spanDays > WATCH_REVIEW_MAX_DAYS)
    throw new WatchHistoryInputError(`Ask for at most ${WATCH_REVIEW_MAX_DAYS} days at a time.`);
  const toExclusive = addLocalDays(to, 1);

  // The range as instants: local midnight of `from` up to local midnight after `to`.
  const rows = await sql<{ id: string; watched_at: Date; day: string; hour: number }[]>`
    SELECT id, watched_at,
      to_char((watched_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS day,
      EXTRACT(HOUR FROM watched_at AT TIME ZONE ${timezone})::int AS hour
    FROM watch_events
    WHERE user_id = ${userId} AND source = 'youtube_takeout' AND kind = 'watch'
      AND watched_at >= (${from}::date)::timestamp AT TIME ZONE ${timezone}
      AND watched_at < (${toExclusive}::date)::timestamp AT TIME ZONE ${timezone}
    ORDER BY watched_at, id
  `;
  const perDay = new Map<string, number>();
  const hours = Array.from({ length: 24 }, () => 0);
  for (const row of rows) {
    perDay.set(row.day, (perDay.get(row.day) ?? 0) + 1);
    hours[row.hour] = (hours[row.hour] ?? 0) + 1;
  }
  const days: { date: string; count: number }[] = [];
  for (let date = from; date <= to; date = addLocalDays(date, 1)) days.push({ date, count: perDay.get(date) ?? 0 });

  const [held] = await sql<{ watches: number; ads: number; posts: number; music: number }[]>`
    SELECT
      count(*) FILTER (WHERE source = 'youtube_takeout' AND kind = 'watch')::int AS watches,
      count(*) FILTER (WHERE source = 'youtube_takeout' AND kind = 'ad')::int AS ads,
      count(*) FILTER (WHERE source = 'youtube_takeout' AND kind = 'post')::int AS posts,
      count(*) FILTER (WHERE source = 'youtube_music_takeout')::int AS music
    FROM watch_events WHERE user_id = ${userId}
  `;
  const imports = await sql<{ id: string; filename: string; event_count: number; imported_at: Date }[]>`
    SELECT id, filename, event_count, imported_at FROM watch_imports
    WHERE user_id = ${userId} ORDER BY imported_at DESC, id LIMIT 50
  `;
  return {
    timezone,
    from,
    to,
    hasData: (held?.watches ?? 0) + (held?.ads ?? 0) + (held?.posts ?? 0) + (held?.music ?? 0) > 0,
    days,
    hours,
    total: rows.length,
    estimate: estimateWatchTime(rows.map((row) => ({ id: row.id, watchedAt: row.watched_at }))),
    excluded: { ads: held?.ads ?? 0, posts: held?.posts ?? 0, music: held?.music ?? 0 },
    imports: imports.map((row) => ({
      id: row.id,
      filename: row.filename,
      eventCount: row.event_count,
      importedAt: row.imported_at.toISOString()
    }))
  };
}
