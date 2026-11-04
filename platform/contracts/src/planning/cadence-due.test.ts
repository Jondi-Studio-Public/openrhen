import { describe, expect, it } from "vitest";
import { isCadenceDueToday, type CadenceDueRule } from "./cadence-due.js";

/**
 * this is the one implementation of the day-granular "is it due" check now — the engine's
 * `cadenceStepDueToday` (`engine/core/src/recurrence/cadence.ts`) and platform's
 * `isCadenceStepEligibleToday` (`platform/database/src/planning/cadence-step-gate.ts`) both delegate to
 * `isCadenceDueToday` in one line each, so there is nothing left for the two to drift apart on. Every
 * case here is also pinned, independently, on both callers: `engine/core/test/recommendation/
 * cadence.test.ts` covers `cadenceStepDueToday` and `platform/database/src/planning/
 * cadence-step-gate.test.ts` covers `isCadenceStepEligibleToday` — a structural cross-import between
 * the two packages remains impossible (`platform/` may not import `@openrhen/engine-*`, enforced by
 * `pnpm structure:check` with no test exemption), so this file, not a single cross-package test, is
 * the parity guarantee: one function, exercised here, wrapped identically by both.
 */

const timezone = "Australia/Sydney";

function rule(overrides: Partial<CadenceDueRule> = {}): CadenceDueRule {
  return { intervalDays: 1, timezone, startDate: "2026-07-01", ...overrides };
}

describe("isCadenceDueToday — plain interval", () => {
  it("is due on its due day (the day after it was last done)", () => {
    const now = new Date("2026-08-07T01:00:00.000Z"); // local 2026-08-07 in the seed zone
    expect(isCadenceDueToday(rule({ intervalDays: 3, lastCompletedLocalDate: "2026-08-04" }), now)).toBe(true);
  });

  it("is due the very next local day after a completion, whatever the configured interval", () => {
    const now = new Date("2026-08-07T01:00:00.000Z");
    expect(isCadenceDueToday(rule({ intervalDays: 5, lastCompletedLocalDate: "2026-08-06" }), now)).toBe(true);
  });

  it("is due the moment its series starts, when never done", () => {
    const now = new Date("2026-07-01T01:00:00.000Z");
    expect(isCadenceDueToday(rule({ intervalDays: 5, startDate: "2026-07-01" }), now)).toBe(true);
  });

  it("is not due before the series has started", () => {
    const now = new Date("2026-06-30T01:00:00.000Z");
    expect(isCadenceDueToday(rule({ startDate: "2026-07-01" }), now)).toBe(false);
  });

  it("is not due again the same local day it was completed", () => {
    const now = new Date("2026-08-07T01:00:00.000Z");
    expect(isCadenceDueToday(rule({ intervalDays: 1, lastCompletedLocalDate: "2026-08-07" }), now)).toBe(false);
  });
});

describe("isCadenceDueToday — minSpacingDays", () => {
  it("holds off until the spacing floor even once the plain interval would already be due", () => {
    const now = new Date("2026-08-07T01:00:00.000Z");
    expect(
      isCadenceDueToday(rule({ intervalDays: 1, lastCompletedLocalDate: "2026-08-06", minSpacingDays: 4 }), now)
    ).toBe(false);
  });

  it("is due again once the spacing floor has passed", () => {
    const now = new Date("2026-08-10T01:00:00.000Z");
    expect(
      isCadenceDueToday(rule({ intervalDays: 1, lastCompletedLocalDate: "2026-08-06", minSpacingDays: 4 }), now)
    ).toBe(true);
  });
});

describe("isCadenceDueToday — eligibleWeekdays", () => {
  it("is not due before the next allowed weekday from the series start", () => {
    // 2026-07-01 (series start) is a Wednesday; the next Monday is 2026-07-06.
    const now = new Date("2026-07-03T01:00:00.000Z");
    expect(isCadenceDueToday(rule({ eligibleWeekdays: [1] }), now)).toBe(false);
  });

  it("is due once the next allowed weekday has arrived", () => {
    const now = new Date("2026-07-06T01:00:00.000Z");
    expect(isCadenceDueToday(rule({ eligibleWeekdays: [1] }), now)).toBe(true);
  });

  it("is due immediately when today already matches an allowed weekday", () => {
    const now = new Date("2026-08-07T01:00:00.000Z"); // Friday
    expect(isCadenceDueToday(rule({ eligibleWeekdays: [5] }), now)).toBe(true);
  });
});

describe("isCadenceDueToday — period rule", () => {
  it("is due while the period's target is still short", () => {
    const now = new Date("2026-08-07T01:00:00.000Z");
    expect(
      isCadenceDueToday(
        rule({
          period: { unit: "days", length: 7 },
          targetOccurrences: 2,
          startDate: "2026-08-03",
          completionLocalDates: ["2026-08-04"]
        }),
        now
      )
    ).toBe(true);
  });

  it("is not due once the period's target is already met, however many days remain", () => {
    const now = new Date("2026-08-07T01:00:00.000Z");
    expect(
      isCadenceDueToday(
        rule({
          period: { unit: "days", length: 7 },
          targetOccurrences: 2,
          startDate: "2026-08-03",
          completionLocalDates: ["2026-08-04", "2026-08-06"]
        }),
        now
      )
    ).toBe(false);
  });

  it("becomes due again from the first day of the next block once the current one ends", () => {
    const now = new Date("2026-08-10T01:00:00.000Z");
    expect(
      isCadenceDueToday(
        rule({
          period: { unit: "days", length: 7 },
          targetOccurrences: 1,
          startDate: "2026-08-03",
          completionLocalDates: ["2026-08-04"]
        }),
        now
      )
    ).toBe(true);
  });

  it("counts a calendar-month period against that month's own completions", () => {
    const now = new Date("2026-08-15T01:00:00.000Z");
    expect(
      isCadenceDueToday(
        rule({
          period: { unit: "month" },
          targetOccurrences: 1,
          startDate: "2026-01-01",
          completionLocalDates: ["2026-08-02"]
        }),
        now
      )
    ).toBe(false);
  });
});

describe("isCadenceDueToday — never done", () => {
  it("is due from the series start when nothing has ever been completed", () => {
    const now = new Date("2026-09-04T01:00:00.000Z");
    expect(isCadenceDueToday(rule({ intervalDays: 7, startDate: "2026-01-01" }), now)).toBe(true);
  });
});
