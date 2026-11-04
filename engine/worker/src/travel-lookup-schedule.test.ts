import { describe, expect, it } from "vitest";
import { travelLookupTickDue } from "./travel-lookup-schedule.js";

const intervalMs = 300_000; // 5 minutes

describe("travelLookupTickDue", () => {
  it("is not due before the interval elapses", () => {
    const now = new Date("2026-09-07T10:00:00Z");
    const lastRanAt = new Date("2026-09-07T09:56:00Z").getTime(); // 4 minutes ago
    expect(travelLookupTickDue({ now, lastRanAt, intervalMs })).toBe(false);
  });

  it("is due once the interval elapses exactly", () => {
    const now = new Date("2026-09-07T10:05:00Z");
    const lastRanAt = new Date("2026-09-07T10:00:00Z").getTime(); // 5 minutes ago
    expect(travelLookupTickDue({ now, lastRanAt, intervalMs })).toBe(true);
  });

  it("is due when the interval is exceeded", () => {
    const now = new Date("2026-09-07T10:06:00Z");
    const lastRanAt = new Date("2026-09-07T10:00:00Z").getTime(); // 6 minutes ago
    expect(travelLookupTickDue({ now, lastRanAt, intervalMs })).toBe(true);
  });

  it("is due on the first run when lastRanAt is 0 (never run)", () => {
    const now = new Date("2026-09-07T10:00:00Z");
    expect(travelLookupTickDue({ now, lastRanAt: 0, intervalMs })).toBe(true);
  });
});
