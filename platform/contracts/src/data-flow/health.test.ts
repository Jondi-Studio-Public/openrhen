import { describe, expect, it } from "vitest";
import { dataFlowRegistry } from "./data-flow.js";
import { withoutContractsExtensions } from "../core-only.js";
import { classifyFreshness, learnThreshold, thresholdFor } from "./health.js";
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

describe("learnThreshold boundaries", () => {
  const start = Date.UTC(2026, 0, 1);
  const every = (hours: number, count = 30) => Array.from({ length: count }, (_, i) => start + i * hours * HOUR);
  it("clamps at exactly 2 h and 14 d, and passes values just inside through", () => {
    expect(learnThreshold(every(1))).toMatchObject({ warnHours: 2, errorHours: 3 });
    expect(learnThreshold(every(4))).toMatchObject({ warnHours: 6, errorHours: 12 });
    expect(learnThreshold(every(224))).toMatchObject({ warnHours: 336, errorHours: 336 });
    expect(learnThreshold(every(300))).toMatchObject({ warnHours: 336, errorHours: 336 });
    expect(learnThreshold(every(200))).toMatchObject({ warnHours: 300, errorHours: 336 });
  });
  it("reports the days the arrivals span", () => {
    expect(learnThreshold(every(12, 30))).toMatchObject({ days: 14 });
    expect(learnThreshold(every(24, 30))).toMatchObject({ days: 29 });
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
  it("learns for a push source, then falls back to the entry's own cold-start numbers", () => {
    const push = entry({
      id: "push-feed",
      activitySource: "push-feed",
      coldStart: { warnAfterHours: 24, errorAfterHours: 72 },
      health: { kind: "activity", source: "push-feed" }
    });
    expect(thresholdFor(push, { learned: { warnHours: 7, errorHours: 14, days: 40 } })).toEqual({
      warnHours: 7,
      errorHours: 14,
      from: "learned",
      days: 40
    });
    expect(thresholdFor(push, {})).toEqual({ warnHours: 24, errorHours: 72, from: "default" });
  });
  it("has no cold-start numbers keyed by id or device in the logic, so an entry without its own gets none", () => {
    const bare = entry({ id: "device-feed", device: "phone", activitySource: "x" });
    expect(thresholdFor(bare, {})).toBeNull();
  });
  it("gives every core device and mail source a threshold", () => {
    const core = withoutContractsExtensions(() => dataFlowRegistry()).entries;
    for (const id of ["iphone-shortcuts", "iphone-health", "rhen-watch", "physiology", "gmail", "phone-location"]) {
      const found = core.find((candidate) => candidate.id === id)!;
      expect(thresholdFor(found, {}), id).not.toBeNull();
    }
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
  it("shows a failing attempt even when the source has no threshold", () => {
    expect(
      classifyFreshness({ now, lastSuccessAt: at(5), lastAttemptAt: at(1), lastAttemptOk: false, threshold: null })
    ).toBe("failing");
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

describe("thresholdFor for a source that reports coverage", () => {
  const mail = entry({ id: "msgs", activitySource: "msgs", method: "api-pull" });
  it("puts the owner's number first, then the collector's declared cadence, with late at T and stale at 2T", () => {
    expect(
      thresholdFor(mail, { coverage: { ownerExpectedEveryMinutes: 80, collector: { silentAfterMinutes: 90 } } })
    ).toEqual({ warnHours: 4, errorHours: 8, from: "owner", usualMinutes: 80, expectedEveryMinutes: 80 });
    expect(thresholdFor(mail, { coverage: { collector: { silentAfterMinutes: 90 } } })).toEqual({
      warnHours: 1.5,
      errorHours: 3,
      from: "collector"
    });
    expect(thresholdFor(mail, { coverage: { collector: { expectedEveryMinutes: 60 } } })).toEqual({
      warnHours: 3,
      errorHours: 6,
      from: "collector"
    });
  });
  it("ignores an owner value of null or zero and falls back", () => {
    expect(
      thresholdFor(mail, { coverage: { ownerExpectedEveryMinutes: null, collector: { silentAfterMinutes: 60 } } })
    ).toMatchObject({
      from: "collector"
    });
    expect(thresholdFor(mail, { coverage: { ownerExpectedEveryMinutes: 0 } })).toBeNull();
  });
  it("then uses the entry's own number; with nothing else there is no number at all", () => {
    expect(
      thresholdFor(entry({ ...mail, freshness: { warnAfterHours: 5, errorAfterHours: 9 } }), { coverage: {} })
    ).toMatchObject({ warnHours: 5, errorHours: 9 });
    expect(thresholdFor(mail, { coverage: {} })).toBeNull();
  });
  it("no longer uses the old learned arrivals, the entry's cold start or a 12 h / 24 h default for a coverage source", () => {
    expect(thresholdFor(mail, { coverage: {}, learned: { warnHours: 3, errorHours: 6, days: 12 } })).toBeNull();
    expect(
      thresholdFor(entry({ ...mail, coldStart: { warnAfterHours: 12, errorAfterHours: 48 } }), { coverage: {} })
    ).toBeNull();
  });
  it("changes nothing for a source that reports no coverage", () => {
    expect(thresholdFor(mail, {})).toBeNull();
  });
});
