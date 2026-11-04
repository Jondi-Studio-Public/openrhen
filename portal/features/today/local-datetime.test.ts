import { describe, expect, it } from "vitest";
import {
  dateInput,
  dateOnly,
  hourMarks,
  iso,
  nextDayKey,
  zonedDayBounds,
  zonedDayStart,
  zonedWallTimeOnDay
} from "./local-datetime";

const SEED_ZONE = "Australia/Sydney";

describe("Today datetime-local conversion", () => {
  it("renders an empty input for a missing instant", () => {
    expect(dateInput(undefined, SEED_ZONE)).toBe("");
    expect(dateInput("", SEED_ZONE)).toBe("");
  });

  it("round-trips an instant through the local input format, in the planning zone", () => {
    const instant = "2026-08-18T04:30:00.000Z"; // 18 August, 2:30pm local (AEST, +10)
    const local = dateInput(instant, SEED_ZONE);
    expect(local).toBe("2026-08-18T14:30");
    expect(iso(local, SEED_ZONE)).toBe(instant);
  });

  it("converts a value entered as 08:30 local back to the instant it names (round-trip)", () => {
    const enteredLocal = "2026-09-03T08:30";
    const instant = iso(enteredLocal, SEED_ZONE);
    expect(instant).toBe("2026-09-02T22:30:00.000Z"); // AEST is UTC+10
    expect(dateInput(instant, SEED_ZONE)).toBe(enteredLocal);
  });

  it("reads the planning zone, not the browser's — a zone far from UTC still round-trips", () => {
    const instant = "2026-08-18T04:30:00.000Z";
    const local = dateInput(instant, "America/New_York"); // UTC-4 in August
    expect(local).toBe("2026-08-18T00:30");
    expect(iso(local, "America/New_York")).toBe(instant);
  });

  it("normalizes an already-absolute ISO value to a canonical instant, untouched by the zone", () => {
    expect(iso("2026-08-18T04:30:00.000Z", SEED_ZONE)).toBe("2026-08-18T04:30:00.000Z");
  });
});

describe("dateOnly", () => {
  it("reads the calendar day in the planning zone, not UTC's (finding 30)", () => {
    // 2026-09-02T22:30:00Z is 2026-09-03, 08:30 in the seed zone (AEST, +10) — the exact "seed-zone morning
    // before 10:00" case that made cadence read a day early every morning.
    expect(dateOnly(new Date("2026-09-02T22:30:00.000Z"), SEED_ZONE)).toBe("2026-09-03");
  });

  it("agrees with UTC when the zone is UTC", () => {
    expect(dateOnly(new Date("2026-09-02T22:30:00.000Z"), "UTC")).toBe("2026-09-02");
  });

  it("reads yesterday for a zone behind UTC late at night", () => {
    // 23:30 UTC is still 19:30 the same UTC day in New York (UTC-4 in August) — no rollover here,
    // unlike the seed-zone case, which is exactly the point: the zone decides, not a fixed offset.
    expect(dateOnly(new Date("2026-08-18T23:30:00.000Z"), "America/New_York")).toBe("2026-08-18");
  });
});
const hours = (bounds: { startsAt: Date; endsAt: Date }) =>
  (bounds.endsAt.getTime() - bounds.startsAt.getTime()) / 3_600_000;

describe("Zoned day bounds", () => {
  it("rolls a day key over month and year ends", () => {
    expect(nextDayKey("2026-01-31")).toBe("2026-02-01");
    expect(nextDayKey("2026-12-31")).toBe("2027-01-01");
    expect(nextDayKey("2028-02-28")).toBe("2028-02-29");
    expect(nextDayKey("2026-08-19", 7)).toBe("2026-08-26");
  });

  it("starts an ordinary seed-zone winter day at 14:00 UTC the evening before", () => {
    expect(zonedDayStart("2026-08-19", SEED_ZONE).toISOString()).toBe("2026-08-18T14:00:00.000Z");
    const bounds = zonedDayBounds("2026-08-19", SEED_ZONE);
    expect(bounds.endsAt.toISOString()).toBe("2026-08-19T14:00:00.000Z");
    expect(hours(bounds)).toBe(24);
  });

  it("gives the day daylight saving ends in the seed zone twenty-five hours", () => {
    // Clocks go back from 03:00 AEDT to 02:00 AEST on 2026-04-05.
    const bounds = zonedDayBounds("2026-04-05", SEED_ZONE);
    expect(bounds.startsAt.toISOString()).toBe("2026-04-04T13:00:00.000Z");
    expect(bounds.endsAt.toISOString()).toBe("2026-04-05T14:00:00.000Z");
    expect(hours(bounds)).toBe(25);
  });

  it("gives the day daylight saving begins in the seed zone twenty-three hours", () => {
    // Clocks go forward from 02:00 AEST to 03:00 AEDT on 2026-10-04.
    const bounds = zonedDayBounds("2026-10-04", SEED_ZONE);
    expect(bounds.startsAt.toISOString()).toBe("2026-10-03T14:00:00.000Z");
    expect(bounds.endsAt.toISOString()).toBe("2026-10-04T13:00:00.000Z");
    expect(hours(bounds)).toBe(23);
  });

  it("treats UTC and a negative-offset zone the same way", () => {
    expect(zonedDayStart("2026-08-19", "UTC").toISOString()).toBe("2026-08-19T00:00:00.000Z");
    // New York is UTC−4 in August.
    const bounds = zonedDayBounds("2026-08-19", "America/New_York");
    expect(bounds.startsAt.toISOString()).toBe("2026-08-19T04:00:00.000Z");
    expect(bounds.endsAt.toISOString()).toBe("2026-08-20T04:00:00.000Z");
  });

  it("places a wall-clock time on the day in the planning zone, before and after a clock change", () => {
    expect(zonedWallTimeOnDay("2026-08-19", "22:00", SEED_ZONE).toISOString()).toBe("2026-08-19T12:00:00.000Z");
    // Evening of the fall-back day is AEST (+10); the morning was AEDT (+11).
    expect(zonedWallTimeOnDay("2026-04-05", "22:00", SEED_ZONE).toISOString()).toBe("2026-04-05T12:00:00.000Z");
    expect(zonedWallTimeOnDay("2026-04-05", "01:30", SEED_ZONE).toISOString()).toBe("2026-04-04T14:30:00.000Z");
    // Evening of the spring-forward day is AEDT (+11).
    expect(zonedWallTimeOnDay("2026-10-04", "22:00", SEED_ZONE).toISOString()).toBe("2026-10-04T11:00:00.000Z");
    expect(zonedWallTimeOnDay("2026-08-19", "7:05", "UTC").toISOString()).toBe("2026-08-19T07:05:00.000Z");
  });

  it("rejects a malformed day key", () => {
    expect(() => zonedDayStart("19/08/2026", SEED_ZONE)).toThrow(/day key/);
  });
});

describe("Hour marks", () => {
  it("labels twenty-four real hours on an ordinary day, in local time", () => {
    const marks = hourMarks(zonedDayBounds("2026-08-19", SEED_ZONE), SEED_ZONE);
    expect(marks).toHaveLength(24);
    expect(marks[0]).toMatchObject({ minuteOffset: 0, hour: 0, label: "12 am" });
    expect(marks[9]).toMatchObject({ minuteOffset: 540, hour: 9, label: "9 am" });
    expect(marks[12]!.label).toBe("12 pm");
    expect(marks[23]).toMatchObject({ minuteOffset: 1380, hour: 23, label: "11 pm" });
  });

  it("repeats the two o'clock hour on the day the clocks go back", () => {
    const marks = hourMarks(zonedDayBounds("2026-04-05", SEED_ZONE), SEED_ZONE);
    expect(marks).toHaveLength(25);
    expect(marks.slice(1, 5).map((mark) => mark.hour)).toEqual([1, 2, 2, 3]);
    expect(marks[24]).toMatchObject({ minuteOffset: 1440, hour: 23 });
  });

  it("skips the two o'clock hour on the day the clocks go forward", () => {
    const marks = hourMarks(zonedDayBounds("2026-10-04", SEED_ZONE), SEED_ZONE);
    expect(marks).toHaveLength(23);
    expect(marks.slice(1, 4).map((mark) => mark.hour)).toEqual([1, 3, 4]);
    expect(marks[22]).toMatchObject({ minuteOffset: 1320, hour: 23 });
  });

  it("keeps offsets in real minutes so a UTC day reads straight through", () => {
    const marks = hourMarks(zonedDayBounds("2026-08-19", "UTC"), "UTC");
    expect(marks.map((mark) => mark.minuteOffset)).toEqual(Array.from({ length: 24 }, (_, index) => index * 60));
  });
});
