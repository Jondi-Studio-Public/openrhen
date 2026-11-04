import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { clockParts, formatWhen, localiseInstant, minutesBetween, parseWhen } from "../src/when.js";
import { fixtureNow, fixtureTimeZone } from "./fixture-state.js";

describe("parseWhen", () => {
  it("parses an ISO date-time", () => {
    const parsed = parseWhen("2026-09-10T17:00:00+10:00", fixtureNow);
    expect(parsed.toISOString()).toBe(new Date("2026-09-10T17:00:00+10:00").toISOString());
  });

  it("parses an ISO date as midnight in the portal timezone, not UTC midnight", () => {
    // Was asserted as UTC midnight, which dropped the first hours of the named day in the portal zone (F7-01).
    expect(parseWhen("2026-09-10", fixtureNow, fixtureTimeZone).toISOString()).toBe("2026-09-09T14:00:00.000Z");
    expect(parseWhen("2026-11-05", fixtureNow, "America/New_York").toISOString()).toBe("2026-11-05T05:00:00.000Z");
  });

  it("uses the offset in force at midnight of a date-only value on a daylight-saving day", () => {
    // seed zone springs forward at 02:00 on 2026-10-04: that day's midnight is +10:00, the next day's +11:00.
    expect(parseWhen("2026-10-04", fixtureNow, fixtureTimeZone).toISOString()).toBe("2026-10-03T14:00:00.000Z");
    expect(parseWhen("2026-10-05", fixtureNow, fixtureTimeZone).toISOString()).toBe("2026-10-04T13:00:00.000Z");
  });

  it("reads an offset-less date-time as wall-clock time in the portal timezone", () => {
    expect(parseWhen("2026-09-10T09:00", fixtureNow, fixtureTimeZone).toISOString()).toBe("2026-09-09T23:00:00.000Z");
  });

  it("parses an ISO date with no timezone given as before (host zone)", () => {
    expect(parseWhen("2026-09-10", fixtureNow).toISOString()).toBe(new Date("2026-09-10").toISOString());
  });

  it("parses now as the given instant", () => {
    expect(parseWhen("now", fixtureNow).getTime()).toBe(fixtureNow.getTime());
  });

  it("parses today as local midnight of the given instant", () => {
    const parsed = parseWhen("today", fixtureNow);
    const expected = new Date(fixtureNow);
    expected.setHours(0, 0, 0, 0);
    expect(parsed.getTime()).toBe(expected.getTime());
  });

  it("parses tomorrow as one day after today's local midnight", () => {
    const today = parseWhen("today", fixtureNow);
    const tomorrow = parseWhen("tomorrow", fixtureNow);
    expect(tomorrow.getTime() - today.getTime()).toBe(86_400_000);
  });

  it("parses yesterday as one day before today's local midnight", () => {
    const today = parseWhen("today", fixtureNow);
    const yesterday = parseWhen("yesterday", fixtureNow);
    expect(today.getTime() - yesterday.getTime()).toBe(86_400_000);
  });

  describe("calendar words in a named timezone", () => {
    // fixtureNow is 09:30 on 2026-09-03 in the seed zone, which is still 2026-09-02 in UTC.
    it("resolves today, tomorrow and yesterday to midnight in that zone, whatever the host zone", () => {
      expect(parseWhen("today", fixtureNow, fixtureTimeZone).toISOString()).toBe("2026-09-02T14:00:00.000Z");
      expect(parseWhen("tomorrow", fixtureNow, fixtureTimeZone).toISOString()).toBe("2026-09-03T14:00:00.000Z");
      expect(parseWhen("yesterday", fixtureNow, fixtureTimeZone).toISOString()).toBe("2026-09-01T14:00:00.000Z");
    });

    it("uses the zone's offset on the target day across a daylight-saving change", () => {
      // seed-zone springs forward at 02:00 on 2026-10-04: midnight that day is +10:00, the next midnight +11:00.
      const now = new Date("2026-10-04T12:00:00+11:00");
      expect(parseWhen("today", now, fixtureTimeZone).toISOString()).toBe("2026-10-03T14:00:00.000Z");
      expect(parseWhen("tomorrow", now, fixtureTimeZone).toISOString()).toBe("2026-10-04T13:00:00.000Z");
      expect(parseWhen("yesterday", new Date("2026-10-05T12:00:00+11:00"), fixtureTimeZone).toISOString()).toBe(
        "2026-10-03T14:00:00.000Z"
      );
    });

    it("handles a zone west of UTC", () => {
      const now = new Date("2026-09-03T01:00:00Z"); // 21:00 on 09-02 in New York
      expect(parseWhen("today", now, "America/New_York").toISOString()).toBe("2026-09-02T04:00:00.000Z");
    });

    it("leaves ISO and relative values alone", () => {
      expect(parseWhen("+1d", fixtureNow, fixtureTimeZone).getTime()).toBe(fixtureNow.getTime() + 86_400_000);
      expect(parseWhen("2026-09-10T17:00:00+10:00", fixtureNow, fixtureTimeZone).toISOString()).toBe(
        "2026-09-10T07:00:00.000Z"
      );
    });
  });

  it("is case-insensitive on the calendar words", () => {
    expect(parseWhen("NOW", fixtureNow).getTime()).toBe(fixtureNow.getTime());
    expect(parseWhen("Today", fixtureNow).getTime()).toBe(parseWhen("today", fixtureNow).getTime());
  });

  const relativeCases: Array<[string, number]> = [
    ["+7d", 7 * 86_400_000],
    ["-2h", -2 * 3_600_000],
    ["+30m", 30 * 60_000],
    ["-1d", -86_400_000],
    ["+0m", 0]
  ];
  for (const [text, deltaMs] of relativeCases) {
    it(`parses relative offset ${text}`, () => {
      expect(parseWhen(text, fixtureNow).getTime()).toBe(fixtureNow.getTime() + deltaMs);
    });
  }

  it("throws a usage CliError for unparseable input", () => {
    try {
      parseWhen("sometime next week", fixtureNow);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(1);
      expect((error as CliError).message).toContain("sometime next week");
    }
  });

  it("throws a usage CliError for garbage that Date cannot parse", () => {
    expect(() => parseWhen("not-a-date-at-all", fixtureNow)).toThrow(CliError);
  });
});

describe("clockParts", () => {
  it("reads year/month/day/hour/minute/weekday in the given timezone", () => {
    const parts = clockParts(fixtureNow, fixtureTimeZone);
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(9);
    expect(parts.day).toBe(3);
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(30);
    expect(parts.weekday).toBe("Thu");
  });

  it("reads local midnight as hour 0, not 24", () => {
    expect(clockParts(new Date("2026-09-09T14:00:00Z"), "Australia/Sydney").hour).toBe(0);
  });
});

describe("formatWhen", () => {
  it("returns empty string for empty/null/undefined input", () => {
    expect(formatWhen("", fixtureTimeZone, fixtureNow)).toBe("");
    expect(formatWhen(null, fixtureTimeZone, fixtureNow)).toBe("");
    expect(formatWhen(undefined, fixtureTimeZone, fixtureNow)).toBe("");
  });

  it("returns the raw string for unparseable input", () => {
    expect(formatWhen("not a date", fixtureTimeZone, fixtureNow)).toBe("not a date");
  });

  it("renders same-day as just the time", () => {
    // 14:30 on the same seed-zone calendar day as fixtureNow (09:30 AEST).
    const sameDay = "2026-09-03T14:30:00+10:00";
    expect(formatWhen(sameDay, fixtureTimeZone, fixtureNow)).toBe("14:30");
  });

  it("renders +2 days as weekday plus time", () => {
    const in2Days = "2026-09-05T14:30:00+10:00";
    const result = formatWhen(in2Days, fixtureTimeZone, fixtureNow);
    const target = clockParts(new Date(in2Days), fixtureTimeZone);
    expect(result).toBe(`${target.weekday} 14:30`);
  });

  it("renders +10 days as the full date plus time", () => {
    const in10Days = "2026-09-13T14:30:00+10:00";
    expect(formatWhen(in10Days, fixtureTimeZone, fixtureNow)).toBe("2026-09-13 14:30");
  });

  it("renders a past date beyond 6 days with the full date too", () => {
    const past = "2026-08-01T14:30:00+10:00";
    expect(formatWhen(past, fixtureTimeZone, fixtureNow)).toBe("2026-08-01 14:30");
  });
});

describe("localiseInstant", () => {
  it("rewrites a UTC 'Z' instant to the zone's own offset", () => {
    expect(localiseInstant("2026-09-04T08:30:00.000Z", fixtureTimeZone)).toBe("2026-09-04T18:30:00+10:00");
  });

  it("is idempotent on an instant already expressed in that zone's offset", () => {
    expect(localiseInstant("2026-09-03T17:00:00+10:00", fixtureTimeZone)).toBe("2026-09-03T17:00:00+10:00");
  });

  it("rewrites an instant given in a third offset too, not just Z", () => {
    // 09:00 in UTC-05:00 is 14:00 UTC, which is 00:00 the next day in Australia/Sydney.
    expect(localiseInstant("2026-09-03T09:00:00-05:00", fixtureTimeZone)).toBe("2026-09-04T00:00:00+10:00");
  });

  it("keeps milliseconds only when the source instant carried them", () => {
    expect(localiseInstant("2026-09-04T08:30:00.250Z", fixtureTimeZone)).toBe("2026-09-04T18:30:00.250+10:00");
    expect(localiseInstant("2026-09-04T08:30:00Z", fixtureTimeZone)).toBe("2026-09-04T18:30:00+10:00");
  });

  it("returns unparseable input unchanged", () => {
    expect(localiseInstant("not-a-date", fixtureTimeZone)).toBe("not-a-date");
  });
});

describe("minutesBetween", () => {
  it("computes whole minutes between two instants", () => {
    expect(minutesBetween(new Date("2026-09-03T09:00:00Z"), new Date("2026-09-03T09:30:00Z"))).toBe(30);
  });

  it("rounds to the nearest minute", () => {
    expect(minutesBetween(new Date("2026-09-03T09:00:00.000Z"), new Date("2026-09-03T09:00:40.000Z"))).toBe(1);
    expect(minutesBetween(new Date("2026-09-03T09:00:00.000Z"), new Date("2026-09-03T09:00:20.000Z"))).toBe(0);
  });

  it("is negative when `to` precedes `from`", () => {
    expect(minutesBetween(new Date("2026-09-03T09:30:00Z"), new Date("2026-09-03T09:00:00Z"))).toBe(-30);
  });
});
