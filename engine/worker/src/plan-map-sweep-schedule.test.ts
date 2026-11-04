import { describe, expect, it } from "vitest";
import { planMapSweepDue } from "./plan-map-sweep-schedule.js";

const timezone = "Australia/Sydney";
const localTime = "03:30";

describe("planMapSweepDue", () => {
  it("is not due before the local time", () => {
    // 2026-06-15T17:00Z + AEST (UTC+10) = 2026-06-16T03:00 local.
    expect(
      planMapSweepDue({ now: new Date("2026-06-15T17:00:00Z"), timezone, localTime, lastRunLocalDate: null })
    ).toEqual({ due: false, localDate: "2026-06-16" });
  });

  it("is due at or after the local time", () => {
    expect(
      planMapSweepDue({ now: new Date("2026-06-15T17:31:00Z"), timezone, localTime, lastRunLocalDate: null })
    ).toEqual({ due: true, localDate: "2026-06-16" });
  });

  it("is not due again once it ran on today's local date, and is due the next day", () => {
    const input = { timezone, localTime, lastRunLocalDate: "2026-06-16" };
    expect(planMapSweepDue({ now: new Date("2026-06-15T20:00:00Z"), ...input }).due).toBe(false);
    expect(planMapSweepDue({ now: new Date("2026-06-16T17:31:00Z"), ...input })).toEqual({
      due: true,
      localDate: "2026-06-17"
    });
  });
});
