// Synthetic exports in the shape Google, Outlook/Exchange, iCloud and Fastmail write. No real calendar content.
import { describe, expect, it } from "vitest";
import { parseFeed } from "./parse.js";

const run = (text: string, owner = "Europe/London") =>
  parseFeed({
    body: new TextEncoder().encode(text),
    now: "2026-11-01T00:00:00Z",
    windowStart: "2026-10-26T00:00:00Z",
    windowEnd: "2026-12-07T00:00:00Z",
    ownerTimeZone: owner
  });
const dates = (r: ReturnType<typeof run>) => r.events.map((e) => `${e.id}|${e.startsAt.slice(0, 16)}`);

describe("real-world export shapes", () => {
  it("Google: X-WR-TIMEZONE, UTC stamps, TZID masters with UTC RECURRENCE-ID and EXDATE, all-day with UNTIL...Z", () => {
    const out = run(
      [
        "BEGIN:VCALENDAR",
        "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
        "VERSION:2.0",
        "CALSCALE:GREGORIAN",
        "X-WR-TIMEZONE:Europe/London",
        "BEGIN:VEVENT",
        "DTSTART;TZID=Europe/London:20261026T090000",
        "DTEND;TZID=Europe/London:20261026T093000",
        "RRULE:FREQ=WEEKLY;WKST=MO;UNTIL=20261121T225959Z;BYDAY=MO,WE",
        "EXDATE;TZID=Europe/London:20261028T090000",
        "DTSTAMP:20261001T000000Z",
        "UID:g1@google.com",
        "SEQUENCE:0",
        "STATUS:CONFIRMED",
        "SUMMARY:Stand-up",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "DTSTART;VALUE=DATE:20261101",
        "DTEND;VALUE=DATE:20261102",
        "RRULE:FREQ=DAILY;UNTIL=20261103T000000Z",
        "UID:g2@google.com",
        "SUMMARY:Holiday",
        "END:VEVENT",
        "END:VCALENDAR"
      ].join("\r\n")
    );
    expect(dates(out).filter((d) => d.startsWith("g1"))).toEqual([
      "g1@google.com#20261026|2026-10-26T09:00",
      "g1@google.com#20261102|2026-11-02T09:00",
      "g1@google.com#20261104|2026-11-04T09:00",
      "g1@google.com#20261109|2026-11-09T09:00",
      "g1@google.com#20261111|2026-11-11T09:00",
      "g1@google.com#20261116|2026-11-16T09:00",
      "g1@google.com#20261118|2026-11-18T09:00"
    ]);
    expect(out.events.filter((e) => e.uid === "g2@google.com").map((e) => e.startDate)).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03"
    ]);
  });

  it("Outlook/Exchange: Windows zone names, BYSETPOS last weekday, Outlook BYMONTHDAY=-1, DURATION-free all-day", () => {
    const out = run(
      [
        "BEGIN:VCALENDAR",
        "METHOD:PUBLISH",
        "PRODID:Microsoft Exchange Server 2010",
        "VERSION:2.0",
        "BEGIN:VTIMEZONE",
        "TZID:W. Europe Standard Time",
        "BEGIN:STANDARD",
        "DTSTART:16010101T030000",
        "TZOFFSETFROM:+0200",
        "TZOFFSETTO:+0100",
        "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10",
        "END:STANDARD",
        "END:VTIMEZONE",
        "BEGIN:VEVENT",
        "CLASS:PUBLIC",
        "DESCRIPTION:Month end\\nclose",
        "DTEND;TZID=W. Europe Standard Time:20261030T170000",
        "DTSTART;TZID=W. Europe Standard Time:20261030T160000",
        "RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
        "SUMMARY;LANGUAGE=en-us:Month end",
        "TRANSP:OPAQUE",
        "UID:040000008200E00074C5B7101A82E008000000000000000001000000",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "DTSTART;VALUE=DATE:20261201",
        "DTEND;VALUE=DATE:20261202",
        "UID:ol2",
        "SUMMARY:Planning day",
        "X-MICROSOFT-CDO-ALLDAYEVENT:TRUE",
        "END:VEVENT",
        "END:VCALENDAR"
      ].join("\r\n"),
      "Europe/Amsterdam"
    );
    const month = out.events.filter((e) => e.uid.startsWith("0400"));
    expect(month.map((e) => e.startsAt)).toEqual(["2026-10-30T15:00:00.000Z", "2026-11-30T15:00:00.000Z"]);
    expect(month[0]?.description).toBe("Month end\nclose");
    expect(out.events.find((e) => e.uid === "ol2")?.allDay).toBe(true);
  });

  it("iCloud: LF endings, TZID with VTIMEZONE using IANA ids, DTEND equal to DTSTART for all-day, X- properties", () => {
    const out = run(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Apple Inc.//macOS 15//EN",
        "X-WR-CALNAME:Home",
        "BEGIN:VEVENT",
        "CREATED:20261001T000000Z",
        "UID:ic-1",
        "DTSTART;TZID=America/Los_Angeles:20261105T180000",
        "DTEND;TZID=America/Los_Angeles:20261105T190000",
        "SUMMARY:Dinner",
        "LOCATION:Cafe\\, Main St",
        "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER:-PT15M",
        "DESCRIPTION:Reminder",
        "END:VALARM",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:ic-2",
        "DTSTART;VALUE=DATE:20261110",
        "DTEND;VALUE=DATE:20261110",
        "SUMMARY:Birthday",
        "END:VEVENT",
        "END:VCALENDAR",
        ""
      ].join("\n"),
      "UTC"
    );
    expect(out.events.map((e) => [e.title, e.location, e.startsAt, e.endDate])).toEqual([
      ["Dinner", "Cafe, Main St", "2026-11-06T02:00:00.000Z", null],
      ["Birthday", "", "2026-11-10T00:00:00.000Z", "2026-11-11"]
    ]);
    expect(out.parseComplete).toBe(true);
  });

  it("Fastmail: folded long lines at 75 octets, CATEGORIES, ATTENDEE with quoted params, lowercase tzid-less floating", () => {
    const longTitle = "Quarterly planning ".repeat(8).trim();
    const folded = `SUMMARY:${longTitle}`.replace(/(.{70})/g, "$1\r\n ");
    const out = run(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Fastmail/2020//EN",
        "BEGIN:VEVENT",
        "UID:fm-1@fastmail.com",
        "DTSTAMP:20261001T000000Z",
        "DTSTART:20261105T140000",
        "DTEND:20261105T150000",
        folded,
        'ATTENDEE;CN="Doe, Jane";PARTSTAT=ACCEPTED:mailto:jane@example.invalid',
        "CATEGORIES:Work,Planning",
        "END:VEVENT",
        "END:VCALENDAR",
        ""
      ].join("\r\n")
    );
    expect(out.events[0]?.title).toBe(longTitle);
    expect(out.events[0]?.startsAt).toBe("2026-11-05T14:00:00.000Z");
  });
});
