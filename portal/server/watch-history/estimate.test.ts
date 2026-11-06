import { describe, expect, it } from "vitest";
import { estimateWatchTime, type EstimateEvent } from "./estimate";

const at = (iso: string, id: string, durationS?: number | null): EstimateEvent => ({
  id,
  watchedAt: new Date(iso),
  ...(durationS === undefined ? {} : { durationS })
});
const minutes = (start: string, ...offsets: number[]) =>
  offsets.map((offset, index) => at(new Date(Date.parse(start) + offset * 60_000).toISOString(), `e${index}`));

describe("estimateWatchTime", () => {
  it("is empty for no events", () => {
    expect(estimateWatchTime([])).toEqual({
      lowMin: 0,
      highMin: 0,
      midMin: 0,
      videos: 0,
      sessions: 0,
      unknownCount: 0
    });
  });

  it("counts a lone watch as one session whose length is unknown", () => {
    expect(estimateWatchTime(minutes("2026-11-01T10:00:00Z", 0))).toMatchObject({
      lowMin: 0,
      highMin: 0,
      videos: 1,
      sessions: 1,
      unknownCount: 1
    });
  });

  it("with no lengths, the low end is 0 and the high end is the sum of the gaps inside sessions", () => {
    const result = estimateWatchTime(minutes("2026-11-01T10:00:00Z", 0, 10, 25, 30));
    expect(result).toMatchObject({ lowMin: 0, highMin: 30, midMin: 15, videos: 4, sessions: 1, unknownCount: 1 });
  });

  it("splits sessions at a gap over 120 minutes and keeps a gap of exactly 120 in the session", () => {
    const exact = estimateWatchTime(minutes("2026-11-01T10:00:00Z", 0, 120, 125));
    expect(exact).toMatchObject({ sessions: 1, highMin: 125, unknownCount: 1 });
    const over = estimateWatchTime(minutes("2026-11-01T10:00:00Z", 0, 121, 126));
    expect(over).toMatchObject({ sessions: 2, highMin: 5, unknownCount: 2 });
  });

  it("orders by time then id, whatever order the events arrive in", () => {
    const a = estimateWatchTime(minutes("2026-11-01T10:00:00Z", 0, 10, 20));
    const b = estimateWatchTime([...minutes("2026-11-01T10:00:00Z", 0, 10, 20)].reverse());
    expect(b).toEqual(a);
  });

  it("gives ties a stable order and credits a zero gap nothing", () => {
    const tie = [at("2026-11-01T10:00:00Z", "b"), at("2026-11-01T10:00:00Z", "a"), at("2026-11-01T10:05:00Z", "c")];
    expect(estimateWatchTime(tie)).toMatchObject({ highMin: 5, videos: 3, sessions: 1, unknownCount: 1 });
    expect(estimateWatchTime(tie.slice().reverse())).toEqual(estimateWatchTime(tie));
  });

  it("credits min(gap, length) to both ends when a length is known", () => {
    const events = [
      at("2026-11-01T10:00:00Z", "a", 5 * 60),
      at("2026-11-01T10:20:00Z", "b", 60 * 60),
      at("2026-11-01T10:30:00Z", "c", 3 * 60)
    ];
    // a: min(20, 5) = 5; b: min(10, 60) = 10; c is last, length known: [0, 3].
    expect(estimateWatchTime(events)).toMatchObject({ lowMin: 15, highMin: 18, unknownCount: 0 });
  });

  it("caps a last video longer than the threshold at the threshold", () => {
    const events = [at("2026-11-01T10:00:00Z", "a", 5 * 3600)];
    expect(estimateWatchTime(events)).toMatchObject({ lowMin: 0, highMin: 120, unknownCount: 0 });
  });

  it("measures real elapsed time across a spring-forward day (23 hours) and a fall-back day (25 hours)", () => {
    // Hourly watches from local midnight to local midnight in New York: the day has 23 then 25 real hours.
    const run = (startUtc: string, hours: number) =>
      estimateWatchTime(
        Array.from({ length: hours + 1 }, (_, i) =>
          at(new Date(Date.parse(startUtc) + i * 3_600_000).toISOString(), `e${String(i).padStart(2, "0")}`)
        )
      );
    expect(run("2026-03-08T05:00:00Z", 23).highMin).toBe(23 * 60);
    expect(run("2026-11-01T04:00:00Z", 25).highMin).toBe(25 * 60);
  });

  it("bounds the last in-range watch by the first watch after the range", () => {
    const inRange = minutes("2026-11-01T10:00:00Z", 0, 10);
    const after = at("2026-11-01T10:25:00Z", "after");
    // Without context the last watch is session-last: [0, 10]. With the next watch 15 minutes on, its gap counts.
    expect(estimateWatchTime(inRange)).toMatchObject({ highMin: 10, unknownCount: 1, sessions: 1 });
    expect(estimateWatchTime(inRange, undefined, { after })).toMatchObject({
      highMin: 25,
      videos: 2,
      sessions: 1,
      unknownCount: 0
    });
    // The watch after is context only: never counted as a video, and a far-off one changes nothing.
    expect(estimateWatchTime(inRange, undefined, { after: at("2026-11-01T14:00:00Z", "later") })).toMatchObject({
      highMin: 10,
      videos: 2,
      unknownCount: 1
    });
  });
});
