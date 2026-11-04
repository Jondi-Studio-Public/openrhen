import { describe, expect, it } from "vitest";
import { expectedOccurrences } from "./expected-occurrences";

const rule = (overrides: { startDate: string; endDate?: string; intervalDays: number; windowCount: number }) => ({
  id: "rule",
  actionId: "action",
  timezone: "UTC",
  startDate: overrides.startDate,
  ...(overrides.endDate ? { endDate: overrides.endDate } : {}),
  intervalDays: overrides.intervalDays,
  windows: Array.from({ length: overrides.windowCount }, (_, index) => ({
    id: `window-${index}`,
    name: `Window ${index}`,
    anchor: "local_time" as const,
    localStartTime: "09:00",
    localEndTime: "10:00"
  })),
  completionMode: "end_date" as const,
  accumulatedMinutes: 0
});

describe("expectedOccurrences", () => {
  it("returns 0 for a rule with no end date", () => {
    expect(
      expectedOccurrences(rule({ startDate: "2026-06-01", intervalDays: 7, windowCount: 1 }), new Date(), "UTC")
    ).toBe(0);
  });

  it("bounds a series far older than the history window to the window, not the rule's whole span", () => {
    // A weekly series that started 90 days ago and ended 5 days ago. The unbounded formula (the whole
    // startDate…endDate span) counts 13 expected occurrences; only the last ~30 days have any evidence
    // the bounded read could possibly show, which comes out to 4.
    const now = new Date("2026-09-02T12:00:00.000Z");
    const oldRule = rule({ startDate: "2026-06-04", endDate: "2026-08-28", intervalDays: 7, windowCount: 1 });
    expect(expectedOccurrences(oldRule, now, "UTC")).toBe(4);
  });

  it("is unaffected when the whole rule already sits inside the history window", () => {
    const now = new Date("2026-08-30T00:00:00.000Z");
    const recentRule = rule({ startDate: "2026-08-01", endDate: "2026-08-20", intervalDays: 1, windowCount: 1 });
    // Both bounds fall inside the last 30 days, so windowing changes nothing: 20 days apart, daily,
    // one window — 20 occurrences either way.
    expect(expectedOccurrences(recentRule, now, "UTC")).toBe(20);
  });

  it("returns 0 once the rule's own span ends before the history window begins", () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    const ancientRule = rule({ startDate: "2025-01-01", endDate: "2025-01-31", intervalDays: 7, windowCount: 1 });
    expect(expectedOccurrences(ancientRule, now, "UTC")).toBe(0);
  });

  it("multiplies by the number of windows in the rule", () => {
    const now = new Date("2026-08-30T00:00:00.000Z");
    const twoWindowRule = rule({ startDate: "2026-08-01", endDate: "2026-08-08", intervalDays: 1, windowCount: 2 });
    expect(expectedOccurrences(twoWindowRule, now, "UTC")).toBe(16);
  });
});
