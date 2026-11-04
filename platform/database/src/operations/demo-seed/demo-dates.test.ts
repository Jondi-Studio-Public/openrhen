import { describe, expect, it } from "vitest";
import { addDays, createShifter, demoDate, isoWeekday, localInstant, localIso } from "./demo-dates.js";

describe("demo seed dates", () => {
  it("finds the demo zone's calendar date across the UTC boundary", () => {
    expect(demoDate(new Date("2026-10-27T03:30:00Z"))).toBe("2026-10-26");
    expect(demoDate(new Date("2026-10-27T04:30:00Z"))).toBe("2026-10-27");
  });

  it("leaves the anchor day unchanged", () => {
    const shifter = createShifter(new Date("2026-10-27T16:00:00Z"));
    expect(shifter.delta).toBe(0);
    expect(shifter.value("2026-10-31T17:00:00-04:00")).toBe("2026-10-31T17:00:00-04:00");
    expect(shifter.weekdays([3, 5])).toEqual([3, 5]);
  });

  it("moves dates by the day difference and keeps the local clock time", () => {
    const shifter = createShifter(new Date("2026-10-29T16:00:00Z"));
    expect(shifter.delta).toBe(2);
    expect(shifter.value("2026-10-31")).toBe("2026-11-02");
    expect(shifter.value("2026-10-27T14:00:00-04:00")).toBe("2026-10-29T14:00:00-04:00");
    expect(shifter.value("Dentist: check-up and clean")).toBe("Dentist: check-up and clean");
  });

  it("recomputes the offset when the shift crosses the end of daylight saving", () => {
    // Daylight saving ends on Sun 2026-11-01 in the United States.
    const shifter = createShifter(new Date("2026-11-10T16:00:00Z"));
    expect(shifter.value("2026-10-27T07:00:00-04:00")).toBe("2026-11-10T07:00:00-05:00");
    expect(localInstant(shifter.today, "07:00").toISOString()).toBe(
      new Date(`${shifter.today}T07:00:00-05:00`).toISOString()
    );
  });

  it("rotates weekly recurrence weekdays (0 = Sunday) with the shift, wrapping and sorted", () => {
    const wednesday = createShifter(new Date("2026-10-28T16:00:00Z"));
    expect(isoWeekday(wednesday.today)).toBe(3);
    expect(wednesday.weekdays([2, 4])).toEqual([3, 5]);
    const thursday = createShifter(new Date("2026-10-29T16:00:00Z"));
    expect(thursday.weekdays([3, 5])).toEqual([0, 5]);
    const earlier = createShifter(new Date("2026-10-26T16:00:00Z"));
    expect(earlier.delta).toBe(-1);
    expect(earlier.weekdays([0, 3])).toEqual([2, 6]);
  });

  it("moves nested fixtures and leaves non-date strings alone", () => {
    const shifter = createShifter(new Date("2026-10-28T16:00:00Z"));
    expect(
      shifter.deep({ a: ["2026-10-27"], b: { c: "2026-10-27T09:00:00-04:00", d: "hello", e: 5, f: null } })
    ).toEqual({ a: ["2026-10-28"], b: { c: "2026-10-28T09:00:00-04:00", d: "hello", e: 5, f: null } });
  });

  it("labels an anchored date after it has moved", () => {
    const shifter = createShifter(new Date("2026-10-27T16:00:00Z"));
    expect(shifter.label("2026-11-05")).toBe("Thu Nov 5");
    expect(shifter.label("2026-11-13", "long")).toBe("Friday November 13");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(localIso("2026-10-27", "14:00")).toBe("2026-10-27T14:00:00-04:00");
  });
});
