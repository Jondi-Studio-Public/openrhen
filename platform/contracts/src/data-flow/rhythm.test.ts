import { describe, expect, it } from "vitest";
import { classifyFreshness, thresholdFor, type CoverageThresholdContext } from "./health.js";
import { formatSpan, learnRhythm, type RhythmPost } from "./rhythm.js";
import type { FlowEntry } from "./types.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.parse("2026-01-05T00:00:00Z");

const mail: FlowEntry = {
  id: "msgs",
  name: "Msgs",
  role: "source",
  category: "communications",
  method: "api-pull",
  trigger: { kind: "none" },
  code: {},
  from: [],
  to: [],
  activitySource: "msgs",
  health: { kind: "none", reason: "fixture" }
};

/** Posts at START plus each cumulative gap; the first post is at START. */
const after = (gaps: readonly number[], first = START): number[] => {
  const out = [first];
  for (const gap of gaps) out.push(out[out.length - 1]! + gap);
  return out;
};
const every = (gap: number, count: number, first = START): number[] =>
  Array.from({ length: count }, (_, index) => first + index * gap);
const posts = (ends: readonly number[]): RhythmPost[] => ends.map((end) => ({ scope: null, end }));

/** What the health reader does for a source at `now`: learn the rhythm from posts up to then, pick a limit, classify the age. */
function judge(ends: readonly number[], now: number, extra: Partial<CoverageThresholdContext> = {}) {
  const seen = ends.filter((end) => end <= now);
  const last = seen[seen.length - 1]!;
  const rhythm = learnRhythm({ posts: posts(seen), now });
  const threshold = thresholdFor(mail, { coverage: { rhythm, ...extra } });
  const state = threshold
    ? classifyFreshness({ now, lastSuccessAt: last, lastAttemptAt: last, lastAttemptOk: true, threshold })
    : "n/a";
  return { rhythm, threshold, state };
}
const atAge = (ends: readonly number[], age: number, extra: Partial<CoverageThresholdContext> = {}) =>
  judge(ends, ends[ends.length - 1]! + age, extra);

describe("learnRhythm gaps", () => {
  it("takes the gaps between posts, newest last, and the median as the usual gap", () => {
    const rhythm = learnRhythm({ posts: posts(every(DAY, 10)), now: START + 9 * DAY });
    expect(rhythm).toMatchObject({ updates: 10, gaps: 9, usualMs: DAY, limitMs: 3 * DAY, lastGapMs: DAY });
  });

  it("counts a burst once: posts less than 60 seconds apart leave no gap", () => {
    const burst: number[] = [];
    for (let day = 0; day < 8; day += 1)
      for (let post = 0; post < 20; post += 1) burst.push(START + day * 3 * DAY + post * 10_000);
    const rhythm = learnRhythm({ posts: posts(burst), now: burst[burst.length - 1]! });
    expect(rhythm.gaps).toBe(7);
    expect(rhythm.usualMs).toBeGreaterThan(2.9 * DAY);
    expect(rhythm.usualMs).toBeLessThan(3 * DAY);
  });

  it("falls back to the raw gaps when collapsing bursts leaves fewer than 6 and the raw series has 6 or more", () => {
    const ends = every(30_000, 12);
    const rhythm = learnRhythm({ posts: posts(ends), now: ends[11]! });
    expect(rhythm.gaps).toBe(11);
    expect(rhythm.usualMs).toBe(30_000);
  });

  it("pools the gaps of each scope instead of mixing scopes into one series", () => {
    const work = every(DAY, 8).map((end): RhythmPost => ({ scope: "work", end }));
    const home = every(DAY, 8, START + 12 * HOUR).map((end): RhythmPost => ({ scope: "home", end }));
    const rhythm = learnRhythm({ posts: [...work, ...home], now: START + 8 * DAY });
    expect(rhythm.gaps).toBe(14);
    expect(rhythm.usualMs).toBe(DAY);
  });

  it("uses posts from the last 28 days, or the newest 61 posts when that leaves fewer", () => {
    const old = every(7 * DAY, 20); // weekly for 20 weeks, then hourly for 40 days
    const hourly = every(HOUR, 40 * 24, old[old.length - 1]! + HOUR);
    const now = hourly[hourly.length - 1]!;
    const recent = learnRhythm({ posts: posts([...old, ...hourly]), now });
    expect(recent.usualMs).toBe(HOUR);
    expect(recent.limitMs).toBe(3 * HOUR);
    const slow = learnRhythm({ posts: posts(old), now: old[old.length - 1]! });
    expect(slow.gaps).toBe(19);
  });
});

describe("the limit T = max(3 x median, 1.5 x second-largest gap), at least 5 minutes", () => {
  it("is 3 x the median for a steady source", () => {
    expect(atAge(every(2 * HOUR, 30), 0).rhythm.limitMs).toBe(6 * HOUR);
  });
  it("ignores one isolated outage (the largest gap) and widens for two", () => {
    const steady = Array.from({ length: 12 }, () => DAY);
    const one = after([...steady, 20 * DAY, ...steady]);
    expect(learnRhythm({ posts: posts(one), now: one[one.length - 1]! }).limitMs).toBe(3 * DAY);
    const two = after([...steady, 20 * DAY, ...steady, 20 * DAY, ...steady]);
    expect(learnRhythm({ posts: posts(two), now: two[two.length - 1]! }).limitMs).toBe(30 * DAY);
  });
  it("uses the largest gap while there are fewer than 6 gaps", () => {
    const ends = after([DAY, DAY, 5 * DAY]);
    expect(learnRhythm({ posts: posts(ends), now: ends[3]! }).limitMs).toBe(7.5 * DAY);
  });
  it("never goes below 5 minutes", () => {
    const rhythm = learnRhythm({ posts: posts(every(10_000, 400)), now: START + 400 * 10_000 });
    expect(rhythm.limitMs).toBe(5 * MIN);
  });
  it("has no limit under 2 gaps", () => {
    for (const count of [1, 2]) {
      const ends = every(DAY, count);
      expect(learnRhythm({ posts: posts(ends), now: ends[count - 1]! }).limitMs).toBeNull();
    }
    expect(learnRhythm({ posts: posts(every(DAY, 3)), now: START + 2 * DAY }).limitMs).toBe(3 * DAY);
  });
});

describe("a limit is real only with 6 gaps and a history of max(24 h, 4T)", () => {
  it("is provisional with 2 to 5 gaps and says how many more updates it needs", () => {
    const { rhythm, threshold } = atAge(every(DAY, 4), 0);
    expect(rhythm).toMatchObject({ gaps: 3, real: false, moreGaps: 3 });
    expect(threshold).toMatchObject({ from: "provisional", warnHours: 72, errorHours: 144, gaps: 3 });
    expect(threshold?.provisional).toMatchObject({ moreUpdates: 3 });
  });
  it("stays provisional until the history is 4T long even with 6 gaps", () => {
    const { rhythm, threshold } = atAge(every(30 * MIN, 8), 0);
    expect(rhythm).toMatchObject({ gaps: 7, real: false });
    expect(threshold?.from).toBe("provisional");
    expect(threshold?.provisional?.moreUpdates).toBe(0);
    expect(threshold?.provisional?.moreHours).toBeGreaterThan(20);
  });
  it("becomes real once both hold", () => {
    expect(atAge(every(DAY, 14), 0).threshold).toMatchObject({ from: "learned", gaps: 13, usualMinutes: 1440 });
  });
});

describe("posts that reach the server late", () => {
  const withLag = (ends: readonly number[], lag: number): RhythmPost[] =>
    ends.map((end) => ({ scope: null, end, postedAt: end + lag }));

  it("keeps the posts of a live collector whose covered-up-to always lags by more than a day", () => {
    const ends = every(7 * DAY, 13);
    for (const lag of [30 * HOUR, 3 * DAY, 10 * DAY]) {
      const rhythm = learnRhythm({ posts: withLag(ends, lag), now: ends[12]! + lag });
      expect(rhythm).toMatchObject({ updates: 13, gaps: 12, limitMs: 21 * DAY, real: true });
    }
  });

  it("leaves out backfilled windows: old ends posted all at once next to a live collector", () => {
    const live = every(HOUR, 30, START + 400 * DAY);
    const newest = live[29]!;
    const backfill = Array.from({ length: 200 }, (_, index) => START + index * DAY).map((end) => ({
      scope: null,
      end,
      postedAt: newest
    }));
    const rhythm = learnRhythm({ posts: [...backfill, ...withLag(live, 0)], now: newest });
    expect(rhythm).toMatchObject({ updates: 30, usualMs: HOUR, limitMs: 3 * HOUR });
  });
});

describe("no cadence known yet", () => {
  it("is a starting point with no number, nothing late, and a provisional limit from 3 posts", () => {
    for (const count of [1, 2]) {
      const { threshold, rhythm, state } = atAge(every(DAY, count), 30 * DAY);
      expect(threshold).toBeNull();
      expect(state).toBe("n/a");
      expect(rhythm.updates).toBe(count);
    }
    expect(atAge(every(DAY, 3), 0).threshold?.from).toBe("provisional");
  });
});

describe("replayed against the hard cases", () => {
  it("a weekly roster: 13 weekly posts give T = 21 d; fresh at 9 d, late at 22 d, stale at 43 d", () => {
    const ends = every(7 * DAY, 13);
    expect(atAge(ends, 0).threshold).toMatchObject({ from: "learned", warnHours: 504, errorHours: 1008 });
    expect([9, 22, 43].map((days) => atAge(ends, days * DAY).state)).toEqual(["fresh", "late", "stale"]);
  });
  it("a weekly roster with only 7 posts is provisional, so degrading only", () => {
    const ends = every(7 * DAY, 7);
    const { threshold, state } = atAge(ends, 22 * DAY);
    expect(threshold?.from).toBe("provisional");
    expect(state).toBe("late");
  });
  it("a pinger every minute: T is the 5-minute floor, late after 6 minutes and stale after 11", () => {
    const ends = every(MIN, 25 * 60 + 1);
    expect(atAge(ends, 0).threshold).toMatchObject({ from: "learned", warnHours: 5 / 60, errorHours: 10 / 60 });
    expect([4, 6, 11].map((minutes) => atAge(ends, minutes * MIN).state)).toEqual(["fresh", "late", "stale"]);
  });
  it("a pinger every 10 minutes: T is 30 minutes", () => {
    const ends = every(10 * MIN, 24 * 6 + 2);
    expect(atAge(ends, 0).threshold).toMatchObject({ warnHours: 0.5, errorHours: 1 });
  });
  it("a laptop closed 8 h every night and 2 days at weekends is never late once it has seen two weekends", () => {
    const awake: number[] = [];
    for (let day = 0; day < 21; day += 1) {
      if (day % 7 >= 5) continue;
      for (let slot = 16; slot < 48; slot += 1) awake.push(START + day * DAY + slot * 30 * MIN);
    }
    const states = new Set<string>();
    for (let now = START + 14 * DAY + 8 * HOUR; now <= START + 21 * DAY; now += 15 * MIN)
      states.add(judge(awake, now).state);
    expect([...states]).toEqual(["fresh"]);
  });
  it("a source with 25% long gaps is not late on the long days", () => {
    const cycle = [...Array.from({ length: 9 }, () => DAY), 10 * DAY, 10 * DAY, 10 * DAY];
    const ends = after([...cycle, ...cycle, ...cycle]);
    expect(atAge(ends, 0).rhythm.limitMs).toBe(15 * DAY);
    expect([2, 9, 14].map((days) => atAge(ends, days * DAY).state)).toEqual(["fresh", "fresh", "fresh"]);
    expect(atAge(ends, 16 * DAY).state).toBe("late");
  });
  it("daily to weekly: one degrading episode on the first long gap, then adopted, with the change flagged", () => {
    const daily = every(DAY, 30);
    const first = [...daily, daily[29]! + 7 * DAY];
    const resumed = atAge(first, 4 * DAY);
    expect(resumed.rhythm.changed).toBe(true);
    expect(resumed.threshold).toMatchObject({ warnHours: 72, rhythmChanged: { lastGapHours: 168 } });
    expect(resumed.state).toBe("late");
    const second = [...first, first[first.length - 1]! + 7 * DAY];
    const adopted = atAge(second, 6.5 * DAY);
    expect(adopted.rhythm.changed).toBe(false);
    expect(adopted.threshold?.warnHours).toBe(252);
    expect(adopted.state).toBe("fresh");
  });
  it("daily to monthly: flagged after the first long gap, adopted after the second", () => {
    const daily = every(DAY, 30);
    const first = [...daily, daily[29]! + 30 * DAY];
    expect(atAge(first, 0).rhythm.changed).toBe(true);
    const second = [...first, first[first.length - 1]! + 30 * DAY];
    const adopted = atAge(second, 40 * DAY);
    expect(adopted.rhythm.changed).toBe(false);
    expect(adopted.threshold?.warnHours).toBe(45 * 24);
    expect(adopted.state).toBe("fresh");
  });
  it("weekly to daily: no false late on the way, and the limit shrinks once the weekly gaps leave the sample", () => {
    const weekly = every(7 * DAY, 12);
    const daily = every(DAY, 80, weekly[11]! + DAY);
    const ends = [...weekly, ...daily];
    for (const post of daily) expect(judge(ends, post + 12 * HOUR).state).toBe("fresh");
    const settled = atAge(ends, 0);
    expect(settled.threshold?.warnHours).toBe(72);
    expect(atAge(ends, 4 * DAY).state).toBe("late");
  });
  it("20 daily posts then silence: late at day 3, stale at day 6", () => {
    const ends = every(DAY, 20);
    expect([2, 3.5, 7].map((days) => atAge(ends, days * DAY).state)).toEqual(["fresh", "late", "stale"]);
  });
});

describe("a collector's declared cadence", () => {
  it("holds a degraded collector to 4 x the declared limit and shows what was observed", () => {
    // Declared hourly (T = 3 h) but now posting every 2 days: the learned T is 6 days.
    const ends = every(2 * DAY, 20);
    const { threshold, state } = atAge(ends, 30 * HOUR, { collector: { expectedEveryMinutes: 60 } });
    expect(threshold).toMatchObject({ from: "collector", warnHours: 12, errorHours: 24, observedWarnHours: 144 });
    expect(state).toBe("stale");
  });
  it("uses a real learned limit below the cap, and the declared limit while the learned one is provisional", () => {
    const real = atAge(every(2 * HOUR, 40), 0, { collector: { expectedEveryMinutes: 60 } });
    expect(real.threshold).toMatchObject({ from: "learned", warnHours: 6 });
    const young = atAge(every(2 * HOUR, 4), 0, { collector: { expectedEveryMinutes: 60 } });
    expect(young.threshold).toMatchObject({ from: "collector", warnHours: 3 });
  });
});

describe("the owner's expectation", () => {
  it("sets T to 3 x N from day one and beats a learned limit", () => {
    const daily = every(DAY, 30);
    const owner = atAge(daily, 0, { ownerExpectedEveryMinutes: 10_080 });
    expect(owner.threshold).toMatchObject({
      from: "owner",
      warnHours: 21 * 24,
      errorHours: 42 * 24,
      expectedEveryMinutes: 10_080
    });
    expect(atAge(every(DAY, 1), 5 * DAY, { ownerExpectedEveryMinutes: 1440 }).state).toBe("late");
  });
  it("returns to learning when it is cleared", () => {
    expect(atAge(every(DAY, 30), 0, { ownerExpectedEveryMinutes: null }).threshold?.from).toBe("learned");
  });
});

describe("formatSpan", () => {
  it.each([
    [5 * MIN, "5 min"],
    [90 * MIN, "90 min"],
    [3 * HOUR, "3 h"],
    [36 * HOUR, "36 h"],
    [3 * DAY, "3 d"],
    [21 * DAY, "21 d"],
    [DAY * 1.5 + 2 * HOUR, "38 h"]
  ])("%d ms is %s", (ms, text) => expect(formatSpan(ms)).toBe(text));
});
