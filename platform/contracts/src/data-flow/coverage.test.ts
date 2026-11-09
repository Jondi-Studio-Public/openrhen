import { describe, expect, it } from "vitest";
import { END_STATES } from "../planning/replay/replay-case.js";
import {
  COVERAGE_DEFAULT_WARN_HOURS,
  MESSAGE_END_STATES,
  coverageNote,
  countHoles,
  mergeScopes,
  parseProcessingRun,
  processingLine,
  scopeCoverage,
  summarizeProcessing,
  unionWindows,
  type NodeCoverage
} from "./coverage.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const at = (hoursAgo: number) => NOW - hoursAgo * HOUR;
const win = (fromHoursAgo: number, toHoursAgo: number) => ({ start: at(fromHoursAgo), end: at(toHoursAgo) });

describe("unionWindows and countHoles", () => {
  it("merges overlapping and touching windows and keeps a real gap apart", () => {
    expect(unionWindows([win(10, 6), win(8, 4), win(4, 2), win(1, 0)])).toEqual([win(10, 2), win(1, 0)]);
  });
  it("counts one hole for one unclaimed gap and none for contiguous or restated windows", () => {
    expect(countHoles([win(10, 6), win(5, 0)], NOW)).toBe(1);
    expect(countHoles([win(10, 6), win(6, 0), win(7, 3)], NOW)).toBe(0);
  });
  it("ignores windows that ended before the last 14 days and the time after the high-water mark", () => {
    const old = { start: at(24 * 40), end: at(24 * 39) };
    expect(countHoles([old, win(5, 4)], NOW)).toBe(0);
    expect(countHoles([win(10, 9)], NOW)).toBe(0);
  });
  it("drops empty or inverted windows", () => {
    expect(
      unionWindows([
        { start: 5, end: 5 },
        { start: 9, end: 3 }
      ])
    ).toEqual([]);
  });
});

describe("scopeCoverage and mergeScopes", () => {
  it("takes the high-water mark from the latest end, even when a window outside the detail range is the latest", () => {
    const scope = scopeCoverage("inbox", [win(10, 6)], at(2), NOW)!;
    expect(scope).toMatchObject({ scope: "inbox", coveredTo: new Date(at(2)).toISOString(), holes14d: 0 });
    expect(scopeCoverage("x", [], null, NOW)).toBeNull();
  });
  it("reads a source only as far as its slowest live scope", () => {
    const a = scopeCoverage("a", [win(3, 1)], null, NOW)!;
    const b = scopeCoverage("b", [win(30, 20)], null, NOW)!;
    const merged = mergeScopes([a, b]);
    expect(merged.coveredTo).toBe(b.coveredTo);
    expect(merged.scopes.map((s) => s.scope)).toEqual(["a", "b"]);
  });
  it("marks a scope that stopped long before the newest as retired so it no longer holds the source back", () => {
    const fresh = scopeCoverage("new", [win(3, 1)], null, NOW)!;
    const dead = scopeCoverage("old", [{ start: at(24 * 60), end: at(24 * 59) }], null, NOW)!;
    const merged = mergeScopes([fresh, dead]);
    expect(merged.coveredTo).toBe(fresh.coveredTo);
    expect(merged.scopes.find((s) => s.scope === "old")?.retired).toBe(true);
    expect(merged.scopes.find((s) => s.scope === "new")?.retired).toBeUndefined();
  });
  it("is empty with no scopes", () => {
    expect(mergeScopes([])).toEqual({ coveredTo: null, scopes: [] });
  });
});

describe("coverageNote", () => {
  const base: NodeCoverage = { coveredTo: "2026-11-09T01:00:00.000Z", scopes: [], holes14d: 0, heartbeat: null };
  it("says alive but not reading when the heartbeat is ok and the source is behind", () => {
    const note = coverageNote({ ...base, heartbeat: { at: "2026-11-09T11:00:00.000Z", status: "ok" } }, "late");
    expect(note).toContain("alive");
    expect(note).toContain("not reading");
  });
  it("names the collector's error when failing", () => {
    const note = coverageNote({ ...base, heartbeat: { at: "x", status: "error", error: "login expired" } }, "failing");
    expect(note).toContain("login expired");
  });
  it("says the collector is alive but has read nothing when there is a heartbeat and no window", () => {
    expect(coverageNote({ ...base, coveredTo: null, heartbeat: { at: "x", status: "ok" } }, "never")).toContain(
      "has not reported reading"
    );
  });
  it("is plain when fresh", () => {
    expect(coverageNote(base, "fresh")).toBe("covered up to 2026-11-09T01:00:00.000Z");
  });
});

describe("processing end states", () => {
  const run = (over: Record<string, number> = {}, extra: Record<string, unknown> = {}) => ({
    endStates: { applied: 0, duplicate: 0, asked: 0, no_effect: 0, unresolved: 0, ...over },
    ...extra
  });
  it("uses the replay harness's five end states", () => {
    expect(MESSAGE_END_STATES).toEqual(END_STATES);
  });
  it("reads a run summary and fills the message total", () => {
    expect(parseProcessingRun(run({ applied: 2, no_effect: 3 }, { noEffectReasons: { newsletter: 3 } }))).toMatchObject(
      {
        messages: 5,
        noEffectReasons: { newsletter: 3 }
      }
    );
  });
  it("refuses a summary that is not one: wrong shape, unknown state, negative or fractional count, a total that disagrees", () => {
    expect(parseProcessingRun(null)).toBeNull();
    expect(parseProcessingRun({})).toBeNull();
    expect(parseProcessingRun({ endStates: { applied: -1 } })).toBeNull();
    expect(parseProcessingRun({ endStates: { applied: 1.5 } })).toBeNull();
    expect(parseProcessingRun({ endStates: { done: 1 } })).toBeNull();
    expect(parseProcessingRun({ ...run({ applied: 2 }), messages: 3 })).toBeNull();
  });
  it("caps reasons and unresolved keys", () => {
    const reasons = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`r${i}`, 1]));
    const keys = Array.from({ length: 30 }, (_, i) => `k${i}`);
    const parsed = parseProcessingRun(
      run({ no_effect: 30, unresolved: 30 }, { noEffectReasons: reasons, unresolvedKeys: keys })
    )!;
    expect(Object.keys(parsed.noEffectReasons!)).toHaveLength(20);
    expect(parsed.unresolvedKeys).toHaveLength(20);
  });
  it("reports the gap between messages collected and messages that reached an end state", () => {
    const report = summarizeProcessing({
      source: "demo-inbox",
      name: "Demo inbox",
      windowDays: 30,
      collected: 234,
      runs: [
        {
          at: "2026-11-09T10:00:00.000Z",
          summary: run({ applied: 10, no_effect: 20 }, { noEffectReasons: { newsletter: 15, "no date": 5 } })
        },
        { at: "2026-11-08T10:00:00.000Z", summary: run({ asked: 4, unresolved: 2 }, { unresolvedKeys: ["mid:a"] }) },
        { at: "2026-11-07T10:00:00.000Z", summary: { oops: true } }
      ]
    });
    expect(report).toMatchObject({
      collected: 234,
      runs: 3,
      unreadableRuns: 1,
      processed: 36,
      gap: 198,
      lastRunAt: "2026-11-09T10:00:00.000Z",
      byEndState: { applied: 10, no_effect: 20, asked: 4, unresolved: 2, duplicate: 0 },
      noEffectReasons: [
        { reason: "newsletter", count: 15 },
        { reason: "no date", count: 5 }
      ],
      unresolvedKeys: ["mid:a"]
    });
    expect(processingLine(report)).toBe(
      "Demo inbox: 234 messages collected in 30 days, 36 decided (applied 10, asked 4, no effect 20, unresolved 2), 198 not yet decided."
    );
  });
  it("never reports a negative gap and says so when no run is recorded", () => {
    const report = summarizeProcessing({ source: "s", name: "S", windowDays: 30, collected: 2, runs: [] });
    expect(report.gap).toBe(2);
    expect(processingLine(report)).toContain("no processing run is recorded");
    const over = summarizeProcessing({
      source: "s",
      name: "S",
      windowDays: 30,
      collected: 1,
      runs: [{ at: "2026-11-09T00:00:00.000Z", summary: run({ applied: 3 }) }]
    });
    expect(over.gap).toBe(0);
    expect(processingLine({ ...report, collected: 0 })).toBeNull();
  });
  it("keeps 12 h as the default T", () => {
    expect(COVERAGE_DEFAULT_WARN_HOURS).toBe(12);
  });
});
