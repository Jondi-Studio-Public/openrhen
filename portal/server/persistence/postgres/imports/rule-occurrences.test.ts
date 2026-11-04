import { describe, expect, it } from "vitest";
import { expandRuleOccurrences, type RuleForMatching } from "./source-match-records";

/**
 * the design notes: the repeating commitment's occurrences a remote series is matched
 * against. Pure fixtures, no database and no diff profile; the series-link rows themselves are tested with the profile
 * that produces them.
 */

const timezone = "Australia/Adelaide";
// 10:00-15:00 Adelaide (ACST, UTC+9:30).
const at = (day: string, time: "start" | "end") => `${day}T${time === "start" ? "00:30" : "05:30"}:00.000Z`;

const college: RuleForMatching = {
  id: "rule-college",
  title: "College",
  version: 5,
  timezone,
  startDate: "2026-07-07",
  endDate: null,
  repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [2] },
  localStartTime: "10:00",
  localEndTime: "15:00",
  linkedProviders: []
};

describe("expandRuleOccurrences", () => {
  it("places the rule's time on each date it falls on, and adds a materialised occurrence moved elsewhere", () => {
    const moved = {
      ruleId: "rule-college",
      localDate: "2026-08-11",
      startsAt: "2026-08-11T03:30:00.000Z",
      endsAt: "2026-08-11T06:30:00.000Z",
      status: "confirmed"
    };
    const rule = expandRuleOccurrences(college, [moved], "2026-08-01", "2026-08-14");
    expect(rule.occurrences.map((item) => [item.localDate, item.startsAt])).toEqual([
      ["2026-08-04", at("2026-08-04", "start")],
      ["2026-08-11", at("2026-08-11", "start")],
      ["2026-08-11", "2026-08-11T03:30:00.000Z"]
    ]);
  });

  it("keeps the rule's time on a date whose occurrence was cancelled, and stops at the end date", () => {
    const cancelled = {
      ruleId: "rule-college",
      localDate: "2026-08-04",
      startsAt: at("2026-08-04", "start"),
      endsAt: at("2026-08-04", "end"),
      status: "cancelled"
    };
    const rule = expandRuleOccurrences({ ...college, endDate: "2026-08-05" }, [cancelled], "2026-08-01", "2026-08-31");
    expect(rule.occurrences.map((item) => item.localDate)).toEqual(["2026-08-04"]);
  });
});
