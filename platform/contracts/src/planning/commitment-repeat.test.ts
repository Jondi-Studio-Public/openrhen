import { describe, expect, it } from "vitest";
import { addLocalDays, dateOrdinal } from "./cadence-due.js";
import {
  commitmentRepeatFallsOn,
  commitmentRepeatSchema,
  normalizeRepeatWeekdays,
  type CommitmentRepeat
} from "./commitment-repeat.js";

const days = (intervalDays: number): CommitmentRepeat => ({ unit: "days", intervalDays });

describe("commitmentRepeatFallsOn — days unit", () => {
  it("is the same modulo arithmetic the engine and week grid used before this predicate existed", () => {
    // Differential test against the literal expression `recurrence.ts`/`week-plan.ts` each ran
    // independently (invariant 4: every pre-existing rule expands identically after the migration).
    const starts = ["2026-01-01", "2026-02-15", "2026-06-30", "2025-12-31"];
    const intervals = [1, 2, 7, 14, 30];
    for (const start of starts) {
      for (const intervalDays of intervals) {
        const seriesStart = dateOrdinal(start);
        for (let offset = 0; offset < 400; offset += 1) {
          const cursor = addLocalDays(start, offset);
          const expected = (dateOrdinal(cursor) - seriesStart) % Math.max(1, intervalDays) === 0;
          expect(commitmentRepeatFallsOn(days(intervalDays), start, cursor)).toBe(expected);
        }
      }
    }
  });

  it("always falls on its own start date", () => {
    expect(commitmentRepeatFallsOn(days(7), "2026-03-04", "2026-03-04")).toBe(true);
  });
});

describe("commitmentRepeatFallsOn — months unit", () => {
  it("day_of_month: skips February rather than clamping the 31st", () => {
    const repeat: CommitmentRepeat = { unit: "months", intervalMonths: 1, anchor: "day_of_month" };
    const start = "2026-01-31";
    expect(commitmentRepeatFallsOn(repeat, start, "2026-01-31")).toBe(true);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-02-28")).toBe(false);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-03-31")).toBe(true);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-04-30")).toBe(false);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-05-31")).toBe(true);
  });

  it("last_day: lands on the month's own final day regardless of the start date's day number", () => {
    const repeat: CommitmentRepeat = { unit: "months", intervalMonths: 1, anchor: "last_day" };
    const start = "2026-01-31";
    expect(commitmentRepeatFallsOn(repeat, start, "2026-01-31")).toBe(true);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-02-28")).toBe(true);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-03-31")).toBe(true);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-04-30")).toBe(true);
    // Any other day of a covered month is not the last day.
    expect(commitmentRepeatFallsOn(repeat, start, "2026-02-27")).toBe(false);
  });

  it("nth_weekday and last_weekday agree in February (4th Sunday) and diverge in March", () => {
    // 2026-02-22 is a Sunday, and Feb 2026 has only four of them, so it is both the 4th and the last —
    // the exact case the anchor split exists for (Decisions table).
    const start = "2026-02-22";
    const nth: CommitmentRepeat = { unit: "months", intervalMonths: 1, anchor: "nth_weekday" };
    const last: CommitmentRepeat = { unit: "months", intervalMonths: 1, anchor: "last_weekday" };
    expect(commitmentRepeatFallsOn(nth, start, "2026-02-22")).toBe(true);
    expect(commitmentRepeatFallsOn(last, start, "2026-02-22")).toBe(true);
    // March 2026 has five Sundays (1, 8, 15, 22, 29): the 4th is the 22nd, the last is the 29th.
    expect(commitmentRepeatFallsOn(nth, start, "2026-03-22")).toBe(true);
    expect(commitmentRepeatFallsOn(nth, start, "2026-03-29")).toBe(false);
    expect(commitmentRepeatFallsOn(last, start, "2026-03-29")).toBe(true);
    expect(commitmentRepeatFallsOn(last, start, "2026-03-22")).toBe(false);
  });

  it("nth_weekday rejects a start date that is the 5th occurrence of its weekday, start date included", () => {
    // 2026-01-31 is a Saturday, and the 5th one in January — never offered as nth_weekday (Decisions).
    const repeat: CommitmentRepeat = { unit: "months", intervalMonths: 1, anchor: "nth_weekday" };
    expect(commitmentRepeatFallsOn(repeat, "2026-01-31", "2026-01-31")).toBe(false);
    // Never rescued into a later month either.
    expect(commitmentRepeatFallsOn(repeat, "2026-01-31", "2026-02-28")).toBe(false);
  });

  it("last_weekday rejects a start date that is not itself the last occurrence of its weekday", () => {
    // 2026-03-01 is a Sunday but not the last Sunday of March (the 29th is).
    const repeat: CommitmentRepeat = { unit: "months", intervalMonths: 1, anchor: "last_weekday" };
    expect(commitmentRepeatFallsOn(repeat, "2026-03-01", "2026-03-01")).toBe(false);
  });

  it("day_of_month rejects a start date it cannot itself repeat from only when the day is impossible", () => {
    // day_of_month always matches its own start date by construction (the day it reads is the start
    // date's own day number), so it is never rejected here — only last_day/nth_weekday/last_weekday can be.
    const repeat: CommitmentRepeat = { unit: "months", intervalMonths: 1, anchor: "day_of_month" };
    expect(commitmentRepeatFallsOn(repeat, "2026-01-15", "2026-01-15")).toBe(true);
  });

  it("respects intervalMonths = 3 (quarterly)", () => {
    const repeat: CommitmentRepeat = { unit: "months", intervalMonths: 3, anchor: "day_of_month" };
    const start = "2026-01-15";
    expect(commitmentRepeatFallsOn(repeat, start, "2026-01-15")).toBe(true);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-02-15")).toBe(false);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-03-15")).toBe(false);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-04-15")).toBe(true);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-07-15")).toBe(true);
  });

  it("never falls before the start date", () => {
    const repeat: CommitmentRepeat = { unit: "months", intervalMonths: 1, anchor: "day_of_month" };
    expect(commitmentRepeatFallsOn(repeat, "2026-03-15", "2026-02-15")).toBe(false);
  });
});

describe("commitmentRepeatSchema", () => {
  it("accepts a days rule and a months rule, and rejects a mixed shape", () => {
    expect(commitmentRepeatSchema.safeParse({ unit: "days", intervalDays: 7 }).success).toBe(true);
    expect(commitmentRepeatSchema.safeParse({ unit: "months", intervalMonths: 1, anchor: "last_day" }).success).toBe(
      true
    );
    expect(commitmentRepeatSchema.safeParse({ unit: "days", intervalMonths: 1 }).success).toBe(false);
    expect(commitmentRepeatSchema.safeParse({ unit: "months", intervalDays: 7 }).success).toBe(false);
  });
});

describe("commitmentRepeatFallsOn — weeks unit", () => {
  const weeks = (intervalWeeks: number, weekdays: number[]): CommitmentRepeat => ({
    unit: "weeks",
    intervalWeeks,
    weekdays
  });

  it("falls on every listed weekday each week, and on nothing else", () => {
    // 2026-09-29 is a Tuesday: Tuesdays and Thursdays from there.
    const repeat = weeks(1, [2, 4]);
    const start = "2026-09-29";
    const hits: string[] = [];
    for (let offset = 0; offset < 14; offset += 1) {
      const cursor = addLocalDays(start, offset);
      if (commitmentRepeatFallsOn(repeat, start, cursor)) hits.push(cursor);
    }
    expect(hits).toEqual(["2026-09-29", "2026-10-01", "2026-10-06", "2026-10-08"]);
  });

  it("never falls before its start date, even on a listed weekday of the start week", () => {
    // Start Thursday 2026-10-01 with Tuesday listed: Tuesday 29 Sep is in the start week but before it.
    const repeat = weeks(1, [2, 4]);
    expect(commitmentRepeatFallsOn(repeat, "2026-10-01", "2026-09-29")).toBe(false);
    expect(commitmentRepeatFallsOn(repeat, "2026-10-01", "2026-10-01")).toBe(true);
    expect(commitmentRepeatFallsOn(repeat, "2026-10-01", "2026-10-06")).toBe(true);
  });

  it("counts on-weeks as Monday-to-Sunday calendar weeks from the start date's week", () => {
    // Fortnightly Tuesdays and Thursdays starting Thursday 2026-10-01: the rest of that week is on,
    // the next calendar week (5-11 Oct) is off, the one after (12-18 Oct) is on.
    const repeat = weeks(2, [2, 4]);
    const start = "2026-10-01";
    expect(commitmentRepeatFallsOn(repeat, start, "2026-10-06")).toBe(false);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-10-08")).toBe(false);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-10-13")).toBe(true);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-10-15")).toBe(true);
  });

  it("treats Sunday as the end of its week, not the start of the next", () => {
    // Fortnightly Mondays and Sundays from Monday 2026-09-28: Sunday 4 Oct closes the on week.
    const repeat = weeks(2, [0, 1]);
    const start = "2026-09-28";
    expect(commitmentRepeatFallsOn(repeat, start, "2026-10-04")).toBe(true);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-10-05")).toBe(false);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-10-11")).toBe(false);
    expect(commitmentRepeatFallsOn(repeat, start, "2026-10-12")).toBe(true);
  });

  it("a single weekday every week is the same as every 7 days", () => {
    const start = "2026-09-30";
    for (let offset = 0; offset < 120; offset += 1) {
      const cursor = addLocalDays(start, offset);
      expect(commitmentRepeatFallsOn(weeks(1, [3]), start, cursor)).toBe(
        commitmentRepeatFallsOn({ unit: "days", intervalDays: 7 }, start, cursor)
      );
    }
  });

  it("does not fall on its own start date when the start's weekday is not listed", () => {
    expect(commitmentRepeatFallsOn(weeks(1, [2, 4]), "2026-09-30", "2026-09-30")).toBe(false);
  });

  it("the schema accepts one ascending spelling of the weekday set only", () => {
    expect(commitmentRepeatSchema.safeParse(weeks(1, [2, 4])).success).toBe(true);
    expect(commitmentRepeatSchema.safeParse(weeks(1, [4, 2])).success).toBe(false);
    expect(commitmentRepeatSchema.safeParse(weeks(1, [2, 2])).success).toBe(false);
    expect(commitmentRepeatSchema.safeParse(weeks(1, [])).success).toBe(false);
    expect(commitmentRepeatSchema.safeParse(weeks(1, [7])).success).toBe(false);
    expect(normalizeRepeatWeekdays([4, 2, 4])).toEqual([2, 4]);
  });
});
