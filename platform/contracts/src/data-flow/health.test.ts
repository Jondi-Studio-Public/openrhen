import { describe, expect, it } from "vitest";
import { classifyFreshness, COLD_START, learnThreshold, thresholdFor } from "./health.js";
import type { FlowEntry } from "./types.js";

const HOUR = 3_600_000;
const entry = (extra: Partial<FlowEntry>): FlowEntry => ({
  id: "e",
  name: "E",
  role: "source",
  category: "manual",
  method: "push",
  trigger: { kind: "none" },
  code: {},
  from: [],
  to: [],
  health: { kind: "none", reason: "fixture" },
  ...extra
});

describe("learnThreshold", () => {
  const start = Date.UTC(2026, 0, 1);
  it("needs at least 20 hourly buckets", () => {
    const few = Array.from({ length: 19 }, (_, i) => start + i * 6 * HOUR);
    expect(learnThreshold(few)).toBeNull();
  });
  it("warns at 1.5 x and errors at 3 x the p95 gap between buckets, clamped to 2 h and 14 d", () => {
    const steady = Array.from({ length: 30 }, (_, i) => start + i * 10 * HOUR);
    expect(learnThreshold(steady)).toMatchObject({ warnHours: 15, errorHours: 30 });
    const fast = Array.from({ length: 30 }, (_, i) => start + i * HOUR);
    expect(learnThreshold(fast)).toMatchObject({ warnHours: 2, errorHours: 3 });
    const slow = Array.from({ length: 30 }, (_, i) => start + i * 400 * HOUR);
    expect(learnThreshold(slow)).toMatchObject({ warnHours: 336, errorHours: 336 });
  });
  it("counts many arrivals in one hour as one bucket and reports the days of data", () => {
    const burst = [
      ...Array.from({ length: 50 }, (_, i) => start + i * 1000),
      ...Array.from({ length: 5 }, (_, i) => start + (i + 1) * 2 * HOUR)
    ];
    expect(learnThreshold(burst)).toBeNull();
    const steady = Array.from({ length: 31 }, (_, i) => start + i * 24 * HOUR);
    expect(learnThreshold(steady)?.days).toBe(30);
  });
});

describe("thresholdFor", () => {
  it("prefers the entry's own freshness, naming the overlay when an extension owns it", () => {
    const own = entry({ freshness: { warnAfterHours: 5, errorAfterHours: 9 } });
    expect(thresholdFor(own, {})).toEqual({ warnHours: 5, errorHours: 9, from: "default" });
    expect(thresholdFor({ ...own, owner: "data-flow-x" }, {})).toMatchObject({ from: "overlay" });
  });
  it("takes a pull source's cadence from the connection", () => {
    const pull = entry({ freshness: "from-connection", syncProvider: "p" });
    expect(thresholdFor(pull, { cadenceLateAfterMs: { p: 3 * HOUR } })).toEqual({
      warnHours: 3,
      errorHours: 6,
      from: "connection"
    });
    expect(thresholdFor(pull, { cadenceLateAfterMs: {} })).toBeNull();
  });
  it("learns for a push source, then falls back to the cold-start table", () => {
    const push = entry({
      id: "iphone-shortcuts",
      activitySource: "iphone-shortcuts",
      health: { kind: "activity", source: "iphone-shortcuts" }
    });
    expect(thresholdFor(push, { learned: { warnHours: 7, errorHours: 14, days: 40 } })).toEqual({
      warnHours: 7,
      errorHours: 14,
      from: "learned",
      days: 40
    });
    expect(thresholdFor(push, {})).toEqual({ ...COLD_START["iphone-shortcuts"]!, from: "default" });
    expect(COLD_START["iphone-shortcuts"]).toEqual({ warnHours: 24, errorHours: 72 });
    expect(COLD_START["iphone-health"]).toEqual({ warnHours: 36, errorHours: 72 });
    expect(COLD_START["rhen-watch"]).toEqual({ warnHours: 24, errorHours: 72 });
  });
  it("gives imports and manual sources no threshold", () => {
    expect(
      thresholdFor(entry({ method: "file-import", health: { kind: "activity", source: "x" }, activitySource: "x" }), {})
    ).toBeNull();
  });
});

describe("classifyFreshness", () => {
  const now = Date.UTC(2026, 5, 1);
  const th = { warnHours: 10, errorHours: 20 };
  const at = (hours: number) => now - hours * HOUR;
  it("is n/a without a threshold and never without a success", () => {
    expect(
      classifyFreshness({ now, lastSuccessAt: at(1), lastAttemptAt: at(1), lastAttemptOk: true, threshold: null })
    ).toBe("n/a");
    expect(
      classifyFreshness({ now, lastSuccessAt: null, lastAttemptAt: null, lastAttemptOk: null, threshold: th })
    ).toBe("never");
  });
  it("is fresh, late then stale by age", () => {
    const f = (h: number) =>
      classifyFreshness({ now, lastSuccessAt: at(h), lastAttemptAt: at(h), lastAttemptOk: true, threshold: th });
    expect([f(5), f(12), f(25)]).toEqual(["fresh", "late", "stale"]);
  });
  it("is failing when the newest attempt failed after the last success", () => {
    expect(
      classifyFreshness({ now, lastSuccessAt: at(5), lastAttemptAt: at(1), lastAttemptOk: false, threshold: th })
    ).toBe("failing");
    expect(
      classifyFreshness({ now, lastSuccessAt: at(1), lastAttemptAt: at(5), lastAttemptOk: false, threshold: th })
    ).toBe("fresh");
  });
});
