import { describe, expect, it } from "vitest";
import { isCadenceStepEligibleToday, type CadenceGateRule } from "./cadence-step-gate.js";

/**
 * Pure-function coverage for the-aware "is it due" subset this module deliberately duplicates
 * from `engine/core/src/recurrence/cadence.ts` (`cadenceEligibleFrom`/`cadencePeriodStatus`) — see the
 * header comment in `cadence-step-gate.ts` for why it cannot just import that function. Every case
 * here mirrors a case already covered on the engine side
 * (`engine/core/test/recommendation/cadence.test.ts`), by hand rather than by import, since
 * `platform/`'s structure check forbids reaching `@openrhen/engine-core` even from a test file.
 */

const timezone = "Australia/Sydney";

function rule(overrides: Partial<CadenceGateRule> = {}): CadenceGateRule {
  return { intervalDays: 1, timezone, startDate: "2026-07-01", ...overrides };
}

describe("isCadenceStepEligibleToday — plain interval", () => {
  it("is eligible on its due day (the day after it was last done)", () => {
    // 2026-08-07 in the seed zone (UTC+10 in August) — well after midnight local.
    const now = new Date("2026-08-07T01:00:00.000Z");
    expect(isCadenceStepEligibleToday(rule({ intervalDays: 3, lastCompletedLocalDate: "2026-08-04" }), now)).toBe(true);
  });

  it(
    "is eligible the very next local day after a completion, whatever the configured interval — mirrors " +
      "cadenceEligibleFrom's own 'not again today' rule rather than the fuller cadenceDueLocalDate interval",
    () => {
      const now = new Date("2026-08-07T01:00:00.000Z"); // local 2026-08-07, one day after 08-06
      expect(isCadenceStepEligibleToday(rule({ intervalDays: 5, lastCompletedLocalDate: "2026-08-06" }), now)).toBe(
        true
      );
    }
  );

  it("is eligible the moment its series starts, when never done", () => {
    const now = new Date("2026-07-01T01:00:00.000Z");
    expect(isCadenceStepEligibleToday(rule({ intervalDays: 5, startDate: "2026-07-01" }), now)).toBe(true);
  });

  it("is not eligible before the series has started", () => {
    const now = new Date("2026-06-30T01:00:00.000Z");
    expect(isCadenceStepEligibleToday(rule({ startDate: "2026-07-01" }), now)).toBe(false);
  });

  it("is not eligible again the same local day it was completed", () => {
    const now = new Date("2026-08-07T01:00:00.000Z"); // 2026-08-07 local in the seed zone
    expect(isCadenceStepEligibleToday(rule({ intervalDays: 1, lastCompletedLocalDate: "2026-08-07" }), now)).toBe(
      false
    );
  });
});

describe("isCadenceStepEligibleToday — minSpacingDays", () => {
  it("holds off until the spacing floor even once the plain interval would already be due", () => {
    const now = new Date("2026-08-07T01:00:00.000Z"); // local 2026-08-07
    expect(
      isCadenceStepEligibleToday(
        rule({ intervalDays: 1, lastCompletedLocalDate: "2026-08-06", minSpacingDays: 4 }),
        now
      )
    ).toBe(false);
  });

  it("is eligible again once the spacing floor has passed", () => {
    const now = new Date("2026-08-10T01:00:00.000Z"); // local 2026-08-10, 4 days after 08-06
    expect(
      isCadenceStepEligibleToday(
        rule({ intervalDays: 1, lastCompletedLocalDate: "2026-08-06", minSpacingDays: 4 }),
        now
      )
    ).toBe(true);
  });
});

describe("isCadenceStepEligibleToday — eligibleWeekdays", () => {
  // eligibleWeekdays only delays the *onset* of eligibility to the next allowed weekday from the
  // series start (or the day after a completion) — it does not re-impose the restriction on every
  // later day, so these cases stay close to that onset to actually exercise the gate (mirrors
  // cadenceEligibleFrom: once the eligible instant has passed, later days stay eligible regardless of
  // their own weekday).
  it("is not eligible before the next allowed weekday from the series start", () => {
    // 2026-07-01 (series start) is a Wednesday; the next Monday is 2026-07-06.
    const now = new Date("2026-07-03T01:00:00.000Z"); // local 2026-07-03, a Friday, still before Monday
    expect(isCadenceStepEligibleToday(rule({ eligibleWeekdays: [1] }), now)).toBe(false);
  });

  it("is eligible once the next allowed weekday has arrived", () => {
    const now = new Date("2026-07-06T01:00:00.000Z"); // local 2026-07-06, the Monday itself
    expect(isCadenceStepEligibleToday(rule({ eligibleWeekdays: [1] }), now)).toBe(true);
  });

  it("is eligible immediately when today already matches an allowed weekday", () => {
    const now = new Date("2026-08-07T01:00:00.000Z"); // Friday, well past series start
    expect(isCadenceStepEligibleToday(rule({ eligibleWeekdays: [5] }), now)).toBe(true);
  });
});

describe("isCadenceStepEligibleToday — period rule", () => {
  it("is eligible while the period's target is still short", () => {
    const now = new Date("2026-08-07T01:00:00.000Z"); // Friday, local 2026-08-07
    expect(
      isCadenceStepEligibleToday(
        rule({
          period: { unit: "days", length: 7 },
          targetOccurrences: 2,
          startDate: "2026-08-03", // Monday — block runs 08-03..08-09
          completionLocalDates: ["2026-08-04"]
        }),
        now
      )
    ).toBe(true);
  });

  it("is not eligible once the period's target is already met, however many days remain", () => {
    const now = new Date("2026-08-07T01:00:00.000Z");
    expect(
      isCadenceStepEligibleToday(
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

  it("becomes eligible again from the first day of the next block once the current one ends", () => {
    // Block 1 is 08-03..08-09 (met), block 2 starts 08-10.
    const now = new Date("2026-08-10T01:00:00.000Z");
    expect(
      isCadenceStepEligibleToday(
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
      isCadenceStepEligibleToday(
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

describe("isCadenceStepEligibleToday — never done", () => {
  it("is eligible from the series start when nothing has ever been completed", () => {
    const now = new Date("2026-09-04T01:00:00.000Z");
    expect(isCadenceStepEligibleToday(rule({ intervalDays: 7, startDate: "2026-01-01" }), now)).toBe(true);
  });
});
