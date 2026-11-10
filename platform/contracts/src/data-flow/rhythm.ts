/**
 * A source's own rhythm: how often it posts, learned from the coverage rows it sent, and the limit that follows. Pure:
 * no database and no clock of its own. The health reader feeds the posts; `thresholdFor` turns the answer into late and
 * stale; the doctor words it. See docs/architecture/activity-store.md, "Coverage", "A source's own rhythm".
 *
 * A post is the `ts_end` of a coverage row, per scope. Age and gaps both use that field, so a collector whose clock is
 * offset is offset in both and the offset cancels. The reader leaves out rows from an import. A collector that always
 * reports a day behind (a nightly or weekly export) still posts live: what marks a backfill is a window that reached the
 * server much later than the newest window did, so every post is compared with the usual delay of the newest few.
 */
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A post less than this after the previous one is part of the same burst: it leaves no gap. */
export const RHYTHM_BURST_MS = 60_000;
/** T is never below this, so a source that posts every few seconds is not late after a minute. */
export const RHYTHM_FLOOR_MS = 5 * MIN_MS;
/** Late at T, stale at this many times T. */
export const RHYTHM_STALE_FACTOR = 2;
/** Gaps needed for a limit at all (a provisional one), and before it may block. */
export const RHYTHM_MIN_GAPS = 2;
export const RHYTHM_MIN_GAPS_REAL = 6;
/** A limit may block only when the history it rests on is at least this long, or 4T when that is longer. */
export const RHYTHM_MIN_SPAN_MS = DAY_MS;
export const RHYTHM_MIN_SPAN_FACTOR = 4;
/** The sample is the posts of this many days; a slower source is given its newest posts instead. */
export const RHYTHM_SAMPLE_DAYS = 28;
export const RHYTHM_SAMPLE_MIN_POSTS = 61;
/** The most posts per source the reader hands over. */
export const RHYTHM_SAMPLE_MAX_POSTS = 2000;
/** The reader looks this far back, so a slow source can reach its minimum history. */
export const RHYTHM_HISTORY_DAYS = 180;
/** Blocking waits until the age is this many times the last long gap, when a source has just resumed after one. */
export const RHYTHM_CHANGED_FACTOR = 1.5;
/** A source more than this many times its stale limit behind has probably been retired and stops blocking... */
export const RHYTHM_ABANDONED_FACTOR = 3;
/**
 * ...but never sooner than this. This is the abandonment floor, NOT a staleness limit: it decides only when a silent source
 * stops being called blocking and is named as probably retired, and no source is ever late or stale against it. Without it
 * an hourly source (stale at 6 h) would be written off after 18 h, a night away from a laptop. A week is longer than any
 * weekend, holiday long weekend or short trip, and short enough that a retired source does not hold the plan for months.
 */
export const RHYTHM_ABANDONED_FLOOR_MS = 7 * DAY_MS;
/** The delay a live collector has is the median over this many of its newest posts. */
export const RHYTHM_DELAY_POSTS = 5;
/** A post whose window reached the server more than this after the usual delay is a backfill, not a live post. */
export const RHYTHM_BACKFILL_SLACK_MS = DAY_MS;
/** A learned limit above this many times the declared one is not used for blocking. */
export const RHYTHM_DECLARED_CAP_FACTOR = 4;
/** The owner's `expectedEveryMinutes` range; T is three times the owner's value. */
export const OWNER_EXPECTED_MIN_MINUTES = 5;
export const OWNER_EXPECTED_MAX_MINUTES = 129_600;

export interface RhythmPost {
  scope: string | null;
  /** Epoch milliseconds of the coverage row's `ts_end`. */
  end: number;
  /** When the row reached the server (`ingested_at`); absent means it arrived as it ended. */
  postedAt?: number;
}

export interface Rhythm {
  /** Posts in the sample. */
  updates: number;
  gaps: number;
  /** The median gap, shown as the usual gap. Null under one gap. */
  usualMs: number | null;
  /** T: the larger of 3 x the median and 1.5 x the second-largest gap, at least 5 minutes. Null under 2 gaps. */
  limitMs: number | null;
  /** From the first post ever seen to the newest. */
  spanMs: number;
  /** 6 or more gaps and a history of at least max(24 h, 4T). Only a real limit may block. */
  real: boolean;
  /** Gaps still needed before the limit is real. */
  moreGaps: number;
  /** History still needed before the limit is real. */
  moreMs: number;
  /** The newest gap. */
  lastGapMs: number | null;
  /** The source just resumed after a gap longer than twice its limit: its next gap is judged with tolerance. */
  changed: boolean;
}

interface Gap {
  ms: number;
  /** When the later post of the gap happened. */
  at: number;
}

function gapsOf(ends: readonly number[]): Gap[] {
  const sorted = [...new Set(ends)].sort((a, b) => a - b);
  const out: Gap[] = [];
  for (let index = 1; index < sorted.length; index += 1)
    out.push({ ms: sorted[index]! - sorted[index - 1]!, at: sorted[index]! });
  return out;
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * Learns a source's rhythm from the newest posts it sent. Gaps are taken per scope and pooled; a burst counts once
 * (a post under 60 s after the last leaves no gap) unless that leaves fewer than 6 gaps and the raw series has 6 or more,
 * so a steady one-minute pinger is data. The sample is the last 28 days, or the newest 61 posts when that is fewer.
 */
export function learnRhythm(input: { posts: readonly RhythmPost[]; now: number }): Rhythm {
  const byEnd = [...input.posts].sort((a, b) => b.end - a.end);
  // The usual delay of a live collector is the median over its newest few posts, so one fresh post (a manual run that
  // reports up to now) cannot turn the whole lagged history into backfill; a window that arrived far later than that
  // delay was backfilled.
  const delay = (post: RhythmPost) => (post.postedAt === undefined ? 0 : post.postedAt - post.end);
  // That median counts only when at least 3 of those posts agree with it to within a day; windows that all arrived at
  // different, large delays (a backfill) have no usual delay, so the newest post's own delay stands.
  const newestDelays = byEnd.slice(0, RHYTHM_DELAY_POSTS).map(delay);
  const usualDelay = newestDelays.length > 0 ? median(newestDelays) : 0;
  const agreeing = newestDelays.filter((value) => Math.abs(value - usualDelay) <= RHYTHM_BACKFILL_SLACK_MS).length;
  const liveDelay = newestDelays.length > 0 ? Math.max(0, agreeing >= 3 ? usualDelay : newestDelays[0]!) : 0;
  const newestFirst = byEnd.filter((post) => delay(post) <= liveDelay + RHYTHM_BACKFILL_SLACK_MS);
  const recent = newestFirst.filter((post) => post.end >= input.now - RHYTHM_SAMPLE_DAYS * DAY_MS);
  const sample = recent.length >= RHYTHM_SAMPLE_MIN_POSTS ? recent : newestFirst.slice(0, RHYTHM_SAMPLE_MIN_POSTS);
  const byScope = new Map<string | null, number[]>();
  for (const post of sample) byScope.set(post.scope, [...(byScope.get(post.scope) ?? []), post.end]);
  const raw: Gap[] = [];
  for (const ends of byScope.values()) raw.push(...gapsOf(ends));
  const collapsed = raw.filter((gap) => gap.ms >= RHYTHM_BURST_MS);
  const gaps = (collapsed.length < RHYTHM_MIN_GAPS_REAL && raw.length >= RHYTHM_MIN_GAPS_REAL ? raw : collapsed).sort(
    (a, b) => a.at - b.at
  );

  const newest = sample.length > 0 ? sample[0]!.end : null;
  // The history is every live post handed over, not only the sample, so a source with a long limit can still reach 4T.
  // The reader hands over at most RHYTHM_SAMPLE_MAX_POSTS posts, so a source that posts more than that inside a day
  // under-reports its span and stays provisional (never blocking) until its posts spread wider; docs/architecture/activity-store.md says so.
  const spanMs = newest === null ? 0 : Math.max(0, newest - newestFirst[newestFirst.length - 1]!.end);
  const lastGapMs = gaps.length > 0 ? gaps[gaps.length - 1]!.ms : null;

  if (gaps.length < RHYTHM_MIN_GAPS)
    return {
      updates: sample.length,
      gaps: gaps.length,
      usualMs: gaps.length > 0 ? median(gaps.map((gap) => gap.ms)) : null,
      limitMs: null,
      spanMs,
      real: false,
      moreGaps: RHYTHM_MIN_GAPS_REAL - gaps.length,
      moreMs: Math.max(0, RHYTHM_MIN_SPAN_MS - spanMs),
      lastGapMs,
      changed: false
    };

  const sizes = gaps.map((gap) => gap.ms).sort((a, b) => b - a);
  const usualMs = median(sizes);
  // One isolated long gap is an outage and is skipped; with fewer than 6 gaps there is not enough to tell, so the largest counts.
  const long = gaps.length >= RHYTHM_MIN_GAPS_REAL ? sizes[1]! : sizes[0]!;
  const limitMs = Math.max(3 * usualMs, 1.5 * long, RHYTHM_FLOOR_MS);
  const needSpan = Math.max(RHYTHM_MIN_SPAN_MS, RHYTHM_MIN_SPAN_FACTOR * limitMs);
  return {
    updates: sample.length,
    gaps: gaps.length,
    usualMs,
    limitMs,
    spanMs,
    real: gaps.length >= RHYTHM_MIN_GAPS_REAL && spanMs >= needSpan,
    moreGaps: Math.max(0, RHYTHM_MIN_GAPS_REAL - gaps.length),
    moreMs: Math.max(0, needSpan - spanMs),
    lastGapMs,
    changed: lastGapMs !== null && lastGapMs > RHYTHM_STALE_FACTOR * limitMs
  };
}

/** A span for people: whole days as days, whole hours under 2 days as hours, else minutes under 2 h, hours under 2 days, otherwise days. */
export function formatSpan(ms: number): string {
  if (ms >= DAY_MS && ms % DAY_MS === 0) return `${ms / DAY_MS} d`;
  if (ms >= HOUR_MS && ms < 2 * DAY_MS && ms % HOUR_MS === 0) return `${ms / HOUR_MS} h`;
  if (ms < 2 * HOUR_MS) return `${Math.round(ms / MIN_MS)} min`;
  if (ms < 2 * DAY_MS) return `${Math.round(ms / HOUR_MS)} h`;
  return `${Math.round(ms / DAY_MS)} d`;
}
