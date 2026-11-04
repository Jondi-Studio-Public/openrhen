// Parity between this folder's wall-clock-to-instant code (zones.ts) and the contracts function the portal uses
// (zonedDateTime). The series safety net only holds if it can see where they differ, so this pins both halves: they agree
// on ordinary wall times, they are known to disagree on gap and fold wall times, and a series at such a time is refused.
import { zonedDateTime } from "@openrhen/contracts/zoned-time";
import { describe, expect, it } from "vitest";
import { parseFeed } from "./parse.js";
import { localToInstant } from "./zones.js";

const proxyInstant = (zone: string, date: string, time: string): number => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  return localToInstant(zone, { y, m, d, h, mi, s: 0 });
};
const contractsInstant = (zone: string, date: string, time: string): number =>
  zonedDateTime(date, time, zone).getTime();

/** Gap (spring forward) and fold (fall back) wall times, with a nearby ordinary one for each zone. */
const CASES = [
  { zone: "America/New_York", kind: "gap", date: "2027-03-14", time: "02:30", ordinary: "2027-03-15" },
  { zone: "America/New_York", kind: "fold", date: "2026-11-01", time: "01:30", ordinary: "2026-11-02" },
  { zone: "Europe/London", kind: "gap", date: "2027-03-28", time: "01:30", ordinary: "2027-03-29" },
  { zone: "Europe/London", kind: "fold", date: "2026-10-25", time: "01:30", ordinary: "2026-10-26" },
  { zone: "Australia/Lord_Howe", kind: "fold", date: "2027-04-04", time: "01:45", ordinary: "2027-04-05" }
] as const;

describe("zones.ts and the contracts zonedDateTime", () => {
  it.each(CASES)("agree on an ordinary wall time next to a $zone $kind", ({ zone, ordinary }) => {
    for (const time of ["00:15", "09:00", "12:30", "23:45"])
      expect(proxyInstant(zone, ordinary, time), `${ordinary} ${time}`).toBe(contractsInstant(zone, ordinary, time));
  });

  it("agree on an ordinary instant in a half-hour zone and across the year", () => {
    for (const zone of ["Asia/Kolkata", "Australia/Adelaide", "America/St_Johns", "UTC"])
      for (const date of ["2026-11-03", "2027-01-15", "2027-07-04"])
        expect(proxyInstant(zone, date, "09:30")).toBe(contractsInstant(zone, date, "09:30"));
  });

  it("disagree on the New York gap, which is why the safety net compares instants", () => {
    expect(proxyInstant("America/New_York", "2027-03-14", "02:30")).not.toBe(
      contractsInstant("America/New_York", "2027-03-14", "02:30")
    );
  });

  // For every gap or fold wall time: a weekly series that reaches it a week after its start is refused exactly when the
  // two functions disagree about its start or its end (one hour later), and accepted when they agree.
  // Control: the same transition dates at 09:00 are fine, so the refusals above are about the wall time, not the zone or the date.
  it.each(CASES)("accepts a weekly 09:00 series through a $zone $kind", ({ zone, date }) => {
    const week = 7 * 86_400_000;
    const startDate = new Date(Date.parse(`${date}T00:00:00Z`) - week).toISOString().slice(0, 10).replaceAll("-", "");
    const body = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:s1",
      `DTSTART;TZID=${zone}:${startDate}T090000`,
      `DTEND;TZID=${zone}:${startDate}T100000`,
      "RRULE:FREQ=WEEKLY",
      "END:VEVENT",
      "END:VCALENDAR",
      ""
    ].join("\r\n");
    const result = parseFeed({
      body: new TextEncoder().encode(body),
      now: new Date(Date.parse(`${date}T00:00:00Z`) - 10 * 86_400_000).toISOString(),
      windowStart: new Date(Date.parse(`${date}T00:00:00Z`) - 30 * 86_400_000).toISOString(),
      windowEnd: new Date(Date.parse(`${date}T00:00:00Z`) + 60 * 86_400_000).toISOString(),
      ownerTimeZone: zone
    });
    expect(result.unrepresentableSeries).toEqual([]);
    expect(result.events.some((e) => e.series)).toBe(true);
  });

  it.each(CASES)(
    "refuses a weekly series reaching a $zone $kind exactly when the instants differ",
    ({ zone, date, time }) => {
      const week = 7 * 86_400_000;
      const startDate = new Date(Date.parse(`${date}T00:00:00Z`) - week).toISOString().slice(0, 10);
      const hour = Number(time.slice(0, 2));
      const endTime = `${String(hour + 1).padStart(2, "0")}:${time.slice(3, 5)}`;
      const startAgree = proxyInstant(zone, date, time) === contractsInstant(zone, date, time);
      const endAgree = proxyInstant(zone, date, time) + 3_600_000 === contractsInstant(zone, date, endTime);
      const stamp = (day: string, t: string) => `${day.replaceAll("-", "")}T${t.replace(":", "")}00`;
      const body = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:s1",
        `DTSTART;TZID=${zone}:${stamp(startDate, time)}`,
        `DTEND;TZID=${zone}:${stamp(startDate, endTime)}`,
        "RRULE:FREQ=WEEKLY",
        "END:VEVENT",
        "END:VCALENDAR",
        ""
      ].join("\r\n");
      const result = parseFeed({
        body: new TextEncoder().encode(body),
        now: new Date(Date.parse(`${date}T00:00:00Z`) - 10 * 86_400_000).toISOString(),
        windowStart: new Date(Date.parse(`${date}T00:00:00Z`) - 30 * 86_400_000).toISOString(),
        windowEnd: new Date(Date.parse(`${date}T00:00:00Z`) + 60 * 86_400_000).toISOString(),
        ownerTimeZone: zone
      });
      expect(result.skipped).toEqual([]);
      const accepted = result.events.some((e) => e.series);
      expect(accepted, `${zone} ${date} ${time}`).toBe(startAgree && endAgree);
      if (!accepted)
        expect(result.unrepresentableSeries.map((s) => s.reason)).toEqual(["a wall time changes with daylight saving"]);
    }
  );

  it("agree on a UTC UNTIL instant and on override instants away from a change", () => {
    const until = Date.UTC(2026, 10, 18, 4, 30);
    // 23:30 on 11-17 in New York is the same instant as the UNTIL.
    expect(proxyInstant("America/New_York", "2026-11-17", "23:30")).toBe(until);
    expect(contractsInstant("America/New_York", "2026-11-17", "23:30")).toBe(until);
    expect(proxyInstant("Europe/London", "2026-11-10", "14:00")).toBe(
      contractsInstant("Europe/London", "2026-11-10", "14:00")
    );
  });
});
