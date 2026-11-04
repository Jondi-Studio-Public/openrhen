import { describe, expect, it } from "vitest";
import { commitmentOccurrenceId, wallClockFormat, zonedDateTime } from "./zoned-time.js";

const SEED_ZONE = "Australia/Sydney";

describe("zonedDateTime on daylight-saving transitions", () => {
  it("resolves an ambiguous fall-back wall time to the second (standard-time) occurrence", () => {
    // seed-zone clocks go back 03:00 AEDT -> 02:00 AEST on 2026-04-05, so 02:30 happens twice.
    expect(zonedDateTime("2026-04-05", "02:30", SEED_ZONE).toISOString()).toBe("2026-04-04T16:30:00.000Z");
  });

  it("moves a spring-forward gap wall time to the same minutes after the gap", () => {
    // Clocks go forward 02:00 AEST -> 03:00 AEDT on 2026-10-04, so 02:30 never happens.
    expect(zonedDateTime("2026-10-04", "02:30", SEED_ZONE).toISOString()).toBe("2026-10-03T16:30:00.000Z");
  });

  it("is unaffected on an ordinary day either side of the transitions", () => {
    expect(zonedDateTime("2026-04-04", "02:30", SEED_ZONE).toISOString()).toBe("2026-04-03T15:30:00.000Z");
    expect(zonedDateTime("2026-10-05", "02:30", SEED_ZONE).toISOString()).toBe("2026-10-04T15:30:00.000Z");
  });
});

describe("wallClockFormat", () => {
  it("returns the same formatter for a zone and throws on an unknown one", () => {
    expect(wallClockFormat(SEED_ZONE)).toBe(wallClockFormat(SEED_ZONE));
    expect(() => wallClockFormat("Not/AZone")).toThrow();
  });
});

describe("commitmentOccurrenceId", () => {
  it("is the rule id and the local date joined by a colon", () => {
    expect(commitmentOccurrenceId("piano", "2026-08-14")).toBe("piano:2026-08-14");
  });
});
