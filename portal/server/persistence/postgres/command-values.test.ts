import { describe, expect, it } from "vitest";
import { InvalidCommandError } from "./command-errors";
import {
  optionalDate,
  planCodePatternValue,
  requiredDate,
  requiredLocalDate,
  requiredLocale,
  requiredTimeZone
} from "./command-values";

describe("optionalDate", () => {
  it("reads an instant with an explicit offset, whichever form it takes", () => {
    expect(optionalDate("2026-10-02T09:00:00Z")?.toISOString()).toBe("2026-10-02T09:00:00.000Z");
    expect(optionalDate("2026-10-02T19:00:00+10:00")?.toISOString()).toBe("2026-10-02T09:00:00.000Z");
    expect(optionalDate("2026-10-02T19:00+1000")?.toISOString()).toBe("2026-10-02T09:00:00.000Z");
    expect(optionalDate("2026-10-02T09:00:00.123Z")?.toISOString()).toBe("2026-10-02T09:00:00.123Z");
  });

  it("treats missing and empty values as no date", () => {
    expect(optionalDate(undefined)).toBeNull();
    expect(optionalDate(null)).toBeNull();
    expect(optionalDate("")).toBeNull();
  });

  it("rejects strings with no offset, which the server's own zone would otherwise decide", () => {
    for (const value of ["2026-10-02T09:00", "2026-10-02T09:00:00", "2026-10-02"]) {
      expect(() => optionalDate(value), value).toThrow(InvalidCommandError);
    }
  });

  it("rejects unparseable dates", () => {
    expect(() => optionalDate("2026-13-45T09:00:00Z")).toThrow(InvalidCommandError);
    expect(() => optionalDate("tomorrow")).toThrow(InvalidCommandError);
  });

  it("requiredDate refuses an offset-less value as well as a missing one", () => {
    expect(() => requiredDate("2026-10-02T09:00", "Start")).toThrow(InvalidCommandError);
    expect(() => requiredDate(undefined, "Start")).toThrow(/Start is required/);
  });
});

describe("date refusals name the field and teach no fixed offset (F3-04)", () => {
  const message = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  };

  it("names the field that failed, so startsAt is told apart from endsAt", () => {
    expect(message(() => optionalDate("2026-11-05T10:00:00", "startsAt"))).toContain("startsAt");
    expect(message(() => optionalDate("2026-13-45T09:00:00Z", "endsAt"))).toContain("endsAt");
  });

  it("says to use the owner's offset from status.timezone, and shows an offset-neutral example", () => {
    for (const run of [
      () => optionalDate("2026-11-05T10:00:00", "startsAt"),
      () => optionalDate("2026-13-45T09:00:00Z", "startsAt"),
      () => requiredDate(undefined, "Start")
    ]) {
      const text = message(run);
      expect(text).toContain("status.timezone");
      expect(text).not.toContain("+10:00");
    }
  });
});

describe("requiredTimeZone", () => {
  it("accepts IANA zones, including aliases that supportedValuesOf omits", () => {
    for (const zone of ["Australia/Sydney", "UTC", "Etc/GMT+10", "Etc/GMT"]) {
      expect(requiredTimeZone(zone, "Timezone"), zone).toBe(zone);
    }
  });

  it("trims the zone it returns", () => {
    expect(requiredTimeZone("  Australia/Sydney ", "Timezone")).toBe("Australia/Sydney");
  });

  it("rejects a typo with a message the user can act on", () => {
    expect(() => requiredTimeZone("Australia/Sydeny", "Timezone")).toThrow(InvalidCommandError);
    expect(() => requiredTimeZone("Australia/Sydeny", "Timezone")).toThrow(/valid IANA time zone/);
  });

  it("rejects empty, blank and non-string values", () => {
    for (const value of ["", "   ", undefined, null, 10]) {
      expect(() => requiredTimeZone(value, "Timezone")).toThrow(InvalidCommandError);
    }
  });
});

describe("requiredLocale", () => {
  it("accepts an English locale and returns it trimmed", () => {
    expect(requiredLocale(" en-GB ", "Date format")).toBe("en-GB");
    expect(requiredLocale("en", "Date format")).toBe("en");
  });

  it("rejects another language, a malformed tag and a non-string with a message the user can act on", () => {
    for (const value of ["fr-FR", "not a locale", "", undefined, null, 10]) {
      expect(() => requiredLocale(value, "Date format")).toThrow(InvalidCommandError);
    }
    expect(() => requiredLocale("fr-FR", "Date format")).toThrow(/must be an English locale.*en-GB or en-US/);
  });
});

describe("planCodePatternValue", () => {
  it("clears on null or empty and keeps a good pattern", () => {
    expect(planCodePatternValue(null)).toBeNull();
    expect(planCodePatternValue("")).toBeNull();
    expect(planCodePatternValue(" [A-Z]{3}\\d{4} ")).toBe("[A-Z]{3}\\d{4}");
  });

  it("refuses a pattern that repeats a group, matches nothing useful, or is not text", () => {
    expect(() => planCodePatternValue("(a+)+")).toThrow(InvalidCommandError);
    expect(() => planCodePatternValue(".*")).toThrow(/must not match empty text/);
    expect(() => planCodePatternValue(7)).toThrow(InvalidCommandError);
  });
});

describe("requiredLocalDate", () => {
  it("reads a calendar day, and the date part of a longer string", () => {
    expect(requiredLocalDate("2026-10-28", "Local date")).toBe("2026-10-28");
    expect(requiredLocalDate(" 2026-10-28T09:00:00+11:00 ", "Local date")).toBe("2026-10-28");
    expect(requiredLocalDate("2028-02-29", "Local date")).toBe("2028-02-29");
  });

  it("refuses a missing, malformed or impossible day with a message that names the format", () => {
    for (const value of [undefined, "", "bad", "2026-13-01", "2026-02-30", "2027-02-29", "28/10/2026", 20261028]) {
      expect(() => requiredLocalDate(value, "Local date"), String(value)).toThrow(InvalidCommandError);
    }
    expect(() => requiredLocalDate("bad", "Local date")).toThrow("YYYY-MM-DD");
  });
});
