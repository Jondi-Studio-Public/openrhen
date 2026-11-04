import { describe, expect, it } from "vitest";
import {
  commitmentOccurrenceId,
  commitmentOccurrenceRowId,
  deterministicUuid,
  wallClockFormat,
  zonedDateTime
} from "./zoned-time.js";

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

describe("deterministicUuid", () => {
  // Captured from engine-core's private copy before it moved; a change would orphan every stored occurrence row.
  it.each([
    ["", "811c9dc5-9e37-49b9-85eb-ca6bc2b2ae35"],
    ["a", "e40c292c-ea00-4616-bb75-f0623349bf8a"],
    ["22222222-2222-4222-8222-222222222222:2026-11-10", "5db5d95a-8956-4498-b784-b6a6460c9f24"],
    ["routine-step:x:y:z:w", "8e4f232c-7f87-4d2a-b85e-78d6bcfd24e6"],
    ["héllo 😀", "f58d3517-5e80-4369-8e25-5edd29beb59d"]
  ])("maps %j to the id the engine always produced", (value, expected) => {
    expect(deterministicUuid(value)).toBe(expected);
  });

  it("is a version-4 uuid shape", () => {
    expect(deterministicUuid("anything")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});

describe("commitmentOccurrenceRowId", () => {
  it("is the uuid of the raw occurrence id", () => {
    const ruleId = "22222222-2222-4222-8222-222222222222";
    expect(commitmentOccurrenceRowId(ruleId, "2026-11-10")).toBe(deterministicUuid(`${ruleId}:2026-11-10`));
    expect(commitmentOccurrenceRowId(ruleId, "2026-11-10")).toBe("5db5d95a-8956-4498-b784-b6a6460c9f24");
  });
});
