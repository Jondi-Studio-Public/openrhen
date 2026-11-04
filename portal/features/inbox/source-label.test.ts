import { describe, expect, it } from "vitest";
import { inboxWhen, sentenceCase, sourceLine } from "./source-label";

const NOW = new Date("2026-10-27T03:00:00.000Z");
const SEED_ZONE = "Australia/Sydney";

describe("sentenceCase", () => {
  it.each([
    ["manual_capture", "Manual capture"],
    ["ai_extraction", "Ai extraction"],
    ["scribe", "Scribe"],
    ["Already fine", "Already fine"],
    ["  padded_value ", "Padded value"],
    ["", ""]
  ])("%j becomes %j", (input, expected) => {
    expect(sentenceCase(input)).toBe(expected);
  });
});

describe("inboxWhen", () => {
  it("leaves the year off for this year and writes am or pm in lowercase", () => {
    expect(inboxWhen("2026-10-26T13:15:00.000Z", NOW, SEED_ZONE)).toBe("27 Oct, 12:15 am");
    expect(inboxWhen("2026-10-27T03:45:00.000Z", NOW, SEED_ZONE)).toBe("27 Oct, 2:45 pm");
  });

  it("adds the year when the date is not in this year", () => {
    expect(inboxWhen("2025-10-26T13:15:00.000Z", NOW, SEED_ZONE)).toBe("27 Oct 2025, 12:15 am");
    expect(inboxWhen("2026-10-26T13:15:00.000Z", new Date("2027-03-01T00:00:00.000Z"), SEED_ZONE)).toBe(
      "27 Oct 2026, 12:15 am"
    );
  });

  it("compares years in the same time zone it formats in", () => {
    // 1 Jan 2027 in the seed zone, still 31 Dec 2026 in UTC
    expect(inboxWhen("2026-12-31T14:00:00.000Z", new Date("2027-06-01T00:00:00.000Z"), SEED_ZONE)).toBe(
      "1 Jan, 1:00 am"
    );
  });

  it("takes a Date as well as a string, and gives nothing for a date that does not parse", () => {
    expect(inboxWhen(new Date("2026-10-26T13:15:00.000Z"), NOW, SEED_ZONE)).toBe("27 Oct, 12:15 am");
    expect(inboxWhen("not a date", NOW, SEED_ZONE)).toBe("");
  });
});

describe("sourceLine", () => {
  it("joins the source in sentence case to when it arrived", () => {
    expect(sourceLine("manual_capture", "2026-10-26T13:15:00.000Z", NOW, SEED_ZONE)).toBe(
      "Manual capture · 27 Oct, 12:15 am"
    );
  });
});
