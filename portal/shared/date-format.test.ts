import { describe, expect, it } from "vitest";
import { formatShortDate, formatZonedMoment, localiseIsoText } from "./date-format";

describe("formatShortDate", () => {
  const tz = "America/New_York";
  const now = new Date("2026-11-03T15:00:00Z");

  it("drops the year for a date within about six weeks", () => {
    expect(formatShortDate("2026-11-12T17:00:00Z", tz, now)).toBe("Thu 12 Nov");
    expect(formatShortDate("2026-10-20T17:00:00Z", tz, now)).toBe("Tue 20 Oct");
  });

  it("keeps the year beyond about six weeks", () => {
    expect(formatShortDate("2026-12-31T17:00:00Z", tz, now)).toBe("Thu 31 Dec 2026");
    expect(formatShortDate("2027-02-01T17:00:00Z", tz, now)).toBe("Mon 1 Feb 2027");
  });

  it("reads the day in the given zone", () => {
    expect(formatShortDate("2026-11-13T02:00:00Z", tz, now)).toBe("Thu 12 Nov");
  });
});

describe("localiseIsoText", () => {
  it("reads each ISO instant as the zone's own day and time", () => {
    const text = localiseIsoText("Overlaps (2026-09-03T00:00:00.000Z–2026-09-03T01:30:00.000Z).", "Australia/Sydney");
    expect(text).toMatch(/^Overlaps \(Thu, 3 Sep\w* at 10:00 am–Thu, 3 Sep\w* at 11:30 am\)\.$/);
  });

  it("leaves text with no instant in it exactly as written", () => {
    expect(localiseIsoText("Nothing to read here: 2026-09-03.", "UTC")).toBe("Nothing to read here: 2026-09-03.");
  });
});

describe("formatZonedMoment", () => {
  const tz = "Australia/Sydney";

  it("gives only the clock time on the same local day as now", () => {
    // 2026-10-26 03:56 UTC is 2:56 pm in the seed zone (UTC+11).
    expect(formatZonedMoment("2026-10-26T03:56:00Z", tz, new Date("2026-10-26T05:00:00Z"))).toBe("2:56 pm");
  });

  it("adds the day when the moment is on another local day", () => {
    // 12:40 UTC on the 26th is 11:40 pm in the seed zone; "now" is already the 27th there.
    expect(formatZonedMoment("2026-10-26T12:40:00Z", tz, new Date("2026-10-26T22:00:00Z"))).toBe(
      "Mon 26 Oct, 11:40 pm"
    );
  });

  it("uses the local day, not the UTC day, to decide", () => {
    expect(formatZonedMoment("2026-10-26T14:30:00Z", tz, new Date("2026-10-26T20:00:00Z"))).toBe("1:30 am");
  });
});
