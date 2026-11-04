import { describe, expect, it } from "vitest";
import { dayCapacityMinutes, overlaps } from "./today-view";

describe("Today view helpers", () => {
  it("treats touching intervals as separate and crossing ones as a collision", () => {
    expect(
      overlaps(
        "2026-08-10T01:00:00.000Z",
        "2026-08-10T02:00:00.000Z",
        "2026-08-10T02:00:00.000Z",
        "2026-08-10T03:00:00.000Z"
      )
    ).toBe(false);
    expect(
      overlaps(
        "2026-08-10T01:00:00.000Z",
        "2026-08-10T02:30:00.000Z",
        "2026-08-10T02:00:00.000Z",
        "2026-08-10T03:00:00.000Z"
      )
    ).toBe(true);
  });
});

describe("dayCapacityMinutes", () => {
  const slot = (start: string, end: string, capacityMinutes: number) => ({
    startsAt: new Date(start),
    endsAt: new Date(end),
    capacityMinutes
  });
  const dayStart = new Date("2026-08-18T14:00:00.000Z");
  const dayEnd = new Date("2026-08-19T14:00:00.000Z");

  it("counts only today, and splits usable from remaining at now", () => {
    const slots = [
      slot("2026-08-18T14:00:00.000Z", "2026-08-18T14:15:00.000Z", 0),
      slot("2026-08-18T20:00:00.000Z", "2026-08-18T20:15:00.000Z", 15),
      slot("2026-08-19T00:00:00.000Z", "2026-08-19T00:15:00.000Z", 10),
      slot("2026-08-19T05:00:00.000Z", "2026-08-19T05:15:00.000Z", 15),
      // Tomorrow and later in the week must not be counted.
      slot("2026-08-19T14:00:00.000Z", "2026-08-19T14:15:00.000Z", 15),
      slot("2026-08-24T00:00:00.000Z", "2026-08-24T00:15:00.000Z", 15)
    ];
    const result = dayCapacityMinutes(slots, dayStart, dayEnd, new Date("2026-08-19T00:05:00.000Z"));
    expect(result.usable).toBe(40);
    expect(result.remaining).toBeCloseTo(10 * (10 / 15) + 15);
  });

  it("clips a slot that straddles midnight in proportion", () => {
    const result = dayCapacityMinutes(
      [
        slot("2026-08-18T14:00:00.000Z", "2026-08-18T14:15:00.000Z", 0),
        slot("2026-08-19T13:45:00.000Z", "2026-08-19T14:15:00.000Z", 30)
      ],
      dayStart,
      dayEnd,
      dayStart
    );
    expect(result.usable).toBeCloseTo(15);
  });

  it("has no whole-day figure when no slot reaches back to the start of the day", () => {
    const result = dayCapacityMinutes(
      [slot("2026-08-19T00:00:00.000Z", "2026-08-19T00:15:00.000Z", 15)],
      dayStart,
      dayEnd,
      new Date("2026-08-19T00:00:00.000Z")
    );
    expect(result.usable).toBeNull();
    expect(result.remaining).toBe(15);
  });
});
