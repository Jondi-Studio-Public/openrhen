import { describe, expect, it } from "vitest";
import { PARTS_LOCALE } from "./locale.js";

// Instants around both 2026 daylight-saving changes in each zone, each including local midnight.
const CASES: [string, string][] = [
  ["Australia/Sydney", "2026-04-04T13:00:00Z"],
  ["Australia/Sydney", "2026-04-04T14:00:00Z"],
  ["Australia/Sydney", "2026-10-03T13:59:00Z"],
  ["Australia/Sydney", "2026-10-03T14:00:00Z"],
  ["America/New_York", "2026-03-08T05:00:00Z"],
  ["America/New_York", "2026-03-08T07:30:00Z"],
  ["America/New_York", "2026-11-01T04:00:00Z"],
  ["America/New_York", "2026-11-01T06:30:00Z"],
  ["Europe/London", "2026-03-29T00:00:00Z"],
  ["Europe/London", "2026-03-29T01:00:00Z"],
  ["Europe/London", "2026-10-25T00:00:00Z"],
  ["Europe/London", "2026-10-25T23:00:00Z"]
];

const shape: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
};

const read = (locale: string, timeZone: string, date: Date, options: Intl.DateTimeFormatOptions) => {
  const parts = new Intl.DateTimeFormat(locale, { timeZone, ...options }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  // The hour is read modulo 24, as the callers do.
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour") === undefined ? undefined : Number(value("hour")) % 24,
    minute: value("minute"),
    second: value("second")
  };
};

describe("PARTS_LOCALE", () => {
  it.each(CASES)("reads the same parts as en-AU in %s at %s", (zone, iso) => {
    const date = new Date(iso);
    const mine = read(PARTS_LOCALE, zone, date, { ...shape, hourCycle: "h23" });
    const theirs = read("en-AU", zone, date, { ...shape, hour12: false });
    expect(mine).toEqual(theirs);
  });

  it.each(CASES)("reads the clockTime shape the same as en-AU in %s at %s", (zone, iso) => {
    const date = new Date(iso);
    const clock = { hour: "numeric", minute: "2-digit" } as const;
    expect(read(PARTS_LOCALE, zone, date, { ...clock, hourCycle: "h23" })).toEqual(
      read("en-AU", zone, date, { ...clock, hour12: false })
    );
  });

  it("names the seven weekdays as en-AU does", () => {
    for (let day = 1; day <= 7; day += 1) {
      const date = new Date(Date.UTC(2026, 7, day, 12));
      const name = (locale: string) =>
        new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(date);
      expect(name(PARTS_LOCALE)).toBe(name("en-AU"));
    }
  });
});
