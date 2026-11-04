import { describe, expect, it } from "vitest";
import { isSyncAttemptResult, normalizeLocalTime, zonedDateAndTime } from "./local-time.js";

describe("zonedDateAndTime", () => {
  it("reads the clock a person in the named timezone sees", () => {
    // 2026-06-15T19:31:00Z is 05:31 the next day in a UTC+10 zone with no DST in June.
    expect(zonedDateAndTime(new Date("2026-06-15T19:31:00Z"), "Australia/Sydney")).toEqual({
      date: "2026-06-16",
      time: "05:31"
    });
  });
});

describe("normalizeLocalTime", () => {
  it("pads H:MM and keeps HH:MM", () => {
    expect(normalizeLocalTime("5:30")).toBe("05:30");
    expect(normalizeLocalTime("05:30")).toBe("05:30");
    expect(normalizeLocalTime(" 23:59 ")).toBe("23:59");
  });

  it("rejects values that would never (or always) be due", () => {
    for (const bad of ["5.30", "0530", "24:00", "12:60", "", "noon", undefined]) {
      expect(normalizeLocalTime(bad)).toBeNull();
    }
  });

  it("makes a padded H:MM time compare correctly as text", () => {
    const localTime = normalizeLocalTime("5:30")!;
    const before = zonedDateAndTime(new Date("2026-06-15T19:00:00Z"), "Australia/Sydney").time;
    const after = zonedDateAndTime(new Date("2026-06-15T19:31:00Z"), "Australia/Sydney").time;
    expect([before >= localTime, after >= localTime]).toEqual([false, true]);
  });
});

describe("isSyncAttemptResult", () => {
  it("counts only parsed sync statuses as an attempt", () => {
    for (const status of ["synced", "needs_review", "failed", "not_configured"]) {
      expect(isSyncAttemptResult({ status })).toBe(true);
    }
    expect(isSyncAttemptResult(null)).toBe(false);
    expect(isSyncAttemptResult({ error: "The request failed." })).toBe(false);
    expect(isSyncAttemptResult({ status: "unknown" })).toBe(false);
  });
});
