import { describe, expect, it } from "vitest";
import { latestSafeStartText, type LatestSafeStartForecast } from "./latest-safe-start";

const TZ = "Australia/Sydney";
const NOW = new Date("2026-08-10T00:00:00.000Z");
const DETAILED_ENDS_AT = new Date("2026-08-25T14:00:00.000Z");

function forecast(overrides: Partial<LatestSafeStartForecast> = {}): LatestSafeStartForecast {
  return {
    latestSafeStarts: { a1: new Date("2026-08-19T22:00:00.000Z") },
    ...overrides
  };
}

describe("latestSafeStartText", () => {
  it("returns exact — a weekday and time — inside the detailed band", () => {
    const result = latestSafeStartText({
      forecast: forecast(),
      unitId: "a1",
      detailedEndsAt: DETAILED_ENDS_AT,
      timeZone: TZ
    });
    expect(result.kind).toBe("exact");
    expect(result.text).toBe("Thu 8:00 am");
  });

  it("returns around — a date only — at or after the detailed band's own end", () => {
    const atEnd = latestSafeStartText({
      forecast: forecast({ latestSafeStarts: { a1: DETAILED_ENDS_AT } }),
      unitId: "a1",
      detailedEndsAt: DETAILED_ENDS_AT,
      timeZone: TZ,
      now: NOW
    });
    expect(atEnd.kind).toBe("around");
    expect(atEnd.text).toBe("around Wed 26 Aug");

    const afterEnd = latestSafeStartText({
      forecast: forecast({ latestSafeStarts: { a1: new Date("2026-09-01T00:00:00.000Z") } }),
      unitId: "a1",
      detailedEndsAt: DETAILED_ENDS_AT,
      timeZone: TZ
    });
    expect(afterEnd.kind).toBe("around");
  });

  it("keeps the year for an around date beyond about six weeks", () => {
    const far = latestSafeStartText({
      forecast: forecast({ latestSafeStarts: { a1: new Date("2026-12-01T00:00:00.000Z") } }),
      unitId: "a1",
      detailedEndsAt: DETAILED_ENDS_AT,
      timeZone: TZ,
      now: NOW
    });
    expect(far.text).toBe("around Tue 1 Dec 2026");
  });

  it("returns unplaced when the unit is in the forecast's unplacedUnitIds", () => {
    const result = latestSafeStartText({
      forecast: forecast({ unplacedUnitIds: ["a1"] }),
      unitId: "a1",
      detailedEndsAt: DETAILED_ENDS_AT,
      timeZone: TZ
    });
    expect(result).toEqual({ kind: "unplaced", text: "can't be placed before the deadline" });
  });

  it("returns none when there is no latest safe start at all", () => {
    expect(
      latestSafeStartText({
        forecast: forecast({ latestSafeStarts: {} }),
        unitId: "a1",
        detailedEndsAt: null,
        timeZone: TZ
      })
    ).toEqual({ kind: "none", text: "" });
    expect(latestSafeStartText({ forecast: undefined, unitId: "a1", detailedEndsAt: null, timeZone: TZ })).toEqual({
      kind: "none",
      text: ""
    });
  });

  it("is exact when there is no detailed band to compare against", () => {
    const result = latestSafeStartText({ forecast: forecast(), unitId: "a1", detailedEndsAt: null, timeZone: TZ });
    expect(result.kind).toBe("exact");
  });
});
