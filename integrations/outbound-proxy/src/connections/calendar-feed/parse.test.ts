import { describe, expect, it } from "vitest";
import { encodeUid, parseFeed, type FeedEvent, type ParseResult } from "./parse.js";
import { expandDays, parseRule } from "./rrule.js";
import { localToInstant, resolveZone } from "./zones.js";

const enc = new TextEncoder();
const cal = (...events: string[][]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...events.flat(), "END:VCALENDAR"].join("\r\n") + "\r\n";
const vevent = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];

function run(
  text: string | Uint8Array,
  over: Partial<{ from: string; to: string; owner: string; now: string }> = {}
): ParseResult {
  return parseFeed({
    body: typeof text === "string" ? enc.encode(text) : text,
    now: over.now ?? "2026-11-01T00:00:00Z",
    windowStart: over.from ?? "2026-10-01T00:00:00Z",
    windowEnd: over.to ?? "2027-01-01T00:00:00Z",
    ownerTimeZone: over.owner ?? "Europe/London"
  });
}
const starts = (events: FeedEvent[]) => events.map((e) => e.startsAt);

describe("lines", () => {
  const body = vevent("UID:a1", "DTSTART:20261105T100000Z", "DTEND:20261105T110000Z", "SUMMARY:Hello");
  it.each([
    ["CRLF", "\r\n"],
    ["LF", "\n"],
    ["CR", "\r"]
  ])("reads %s line ends", (_n, nl) => {
    const text = cal(body).replace(/\r\n/g, nl);
    expect(run(text).events).toHaveLength(1);
  });
  it("unfolds, including a fold inside a multibyte character", () => {
    const bytes = enc.encode("SUMMARY:Café 日本");
    // cut inside the two-byte e-acute (0xC3 0xA9)
    const at = bytes.indexOf(0xc3) + 1;
    const folded = new Uint8Array([...bytes.slice(0, at), 0x0d, 0x0a, 0x20, ...bytes.slice(at)]);
    const head = enc.encode(
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:f\r\nDTSTART:20261105T100000Z\r\nDTEND:20261105T110000Z\r\n"
    );
    const tail = enc.encode("\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
    const out = run(new Uint8Array([...head, ...folded, ...tail]));
    expect(out.events[0]?.title).toBe("Café 日本");
  });
  it("strips a BOM, ignores VALARM, ends an unclosed VEVENT at the next BEGIN", () => {
    const text =
      "﻿BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261105T100000Z\r\nDTEND:20261105T110000Z\r\nBEGIN:VALARM\r\nTRIGGER:-PT5M\r\nSUMMARY:alarm\r\nEND:VALARM\r\nSUMMARY:Real\r\nBEGIN:VEVENT\r\nUID:y\r\nDTSTART:20261106T100000Z\r\nDTEND:20261106T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const out = run(text);
    expect(out.events.map((e) => [e.id, e.title])).toEqual([
      ["x", "Real"],
      ["y", "(no title)"]
    ]);
  });
  it("is case-insensitive on names, unescapes in one pass, strips bidi and control, cuts long text", () => {
    const text = cal(
      vevent(
        "uid:c",
        "dtstart:20261105T100000Z",
        "dtend:20261105T110000Z",
        "summary:A\\nB\\, C\\\\n ‮evil\u0007",
        `description:${"d".repeat(900)}`
      )
    );
    const e = run(text).events[0]!;
    expect(e.title).toBe("A B, C\\n evil");
    expect(e.description).toHaveLength(500);
  });
  it("a bad line or event never fails the read", () => {
    const text = cal(
      vevent("UID:ok", "DTSTART:20261105T100000Z", "DTEND:20261105T110000Z", "garbage with no colon"),
      vevent("UID:bad", "DTSTART:nonsense", "DTEND:x"),
      vevent("SUMMARY:no uid")
    );
    const out = run(text);
    expect(out.events.map((e) => e.id)).toEqual(["ok"]);
    expect(out.skipped.map((s) => [s.idPrefix, s.reason])).toEqual([
      ["bad", "unreadable dtstart"],
      [null, "no uid"]
    ]);
    expect(out.parseComplete).toBe(true);
  });
  it("reports a feed missing END:VCALENDAR as incomplete", () => {
    expect(
      run(
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261105T100000Z\r\nDTEND:20261105T110000Z\r\nEND:VEVENT\r\n"
      ).parseComplete
    ).toBe(false);
  });
});

describe("zones and times", () => {
  const one = (...lines: string[]) => run(cal(vevent("UID:z", ...lines)));
  it("Z is UTC; TZID, floating (owner), X-WR-TIMEZONE and VALUE=DATE", () => {
    expect(one("DTSTART:20261105T100000Z", "DTEND:20261105T110000Z").events[0]?.startsAt).toBe(
      "2026-11-05T10:00:00.000Z"
    );
    expect(
      one("DTSTART;TZID=America/New_York:20261105T100000", "DTEND;TZID=America/New_York:20261105T110000").events[0]
        ?.startsAt
    ).toBe("2026-11-05T15:00:00.000Z");
    expect(
      run(cal(vevent("UID:z", "DTSTART:20260705T100000", "DTEND:20260705T110000")), { from: "2026-07-01T00:00:00Z" })
        .events[0]?.startsAt
    ).toBe("2026-07-05T09:00:00.000Z");
    const g = run(
      [
        "BEGIN:VCALENDAR",
        "X-WR-TIMEZONE:Asia/Tokyo",
        ...vevent("UID:z", "DTSTART:20261105T100000", "DTEND:20261105T110000"),
        "END:VCALENDAR"
      ].join("\r\n")
    );
    expect(g.events[0]?.startsAt).toBe("2026-11-05T01:00:00.000Z");
    const d = one("DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261107").events[0]!;
    expect([d.allDay, d.startDate, d.endDate]).toEqual([true, "2026-11-05", "2026-11-07"]);
  });
  it("accepts IANA in exact case and Windows names; refuses offsets, abbreviations, lowercase, unknowns", () => {
    expect(resolveZone("Europe/London")).toBe("Europe/London");
    expect(resolveZone("UTC")).toBe("UTC");
    expect(resolveZone("Etc/UTC")).toBe("Etc/UTC");
    expect(resolveZone("W. Europe Standard Time")).toBe("Europe/Berlin");
    expect(resolveZone("AUS Eastern Standard Time")).toBe("Australia/Sydney");
    expect(resolveZone("/mozilla.org/20050126_1/Europe/London")).toBe("Europe/London");
    for (const bad of ["+05:00", "EST", "europe/london", "EUROPE/LONDON", "Customized Time Zone", "Mars/Base", ""])
      expect(resolveZone(bad), bad).toBeNull();
    const out = one(
      "DTSTART;TZID=Customized Time Zone:20261105T100000",
      "DTEND;TZID=Customized Time Zone:20261105T110000"
    );
    expect(out.events).toEqual([]);
    expect(out.skipped).toEqual([{ idPrefix: "z", reason: "unknown zone" }]);
  });
  it("falls back to a VTIMEZONE's X-LIC-LOCATION", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VTIMEZONE",
      "TZID:Custom1",
      "X-LIC-LOCATION:Europe/Paris",
      "END:VTIMEZONE",
      ...vevent("UID:z", "DTSTART;TZID=Custom1:20261105T100000", "DTEND;TZID=Custom1:20261105T110000"),
      "END:VCALENDAR"
    ].join("\r\n");
    expect(run(text).events[0]?.startsAt).toBe("2026-11-05T09:00:00.000Z");
  });
  it("moves a time in a DST gap forward and takes the earlier instant of an overlap", () => {
    // London: 2026-03-29 01:30 does not exist; 2026-10-25 01:30 happens twice.
    expect(new Date(localToInstant("Europe/London", { y: 2026, m: 3, d: 29, h: 1, mi: 30, s: 0 })).toISOString()).toBe(
      "2026-03-29T01:30:00.000Z"
    );
    expect(new Date(localToInstant("Europe/London", { y: 2026, m: 10, d: 25, h: 1, mi: 30, s: 0 })).toISOString()).toBe(
      "2026-10-25T00:30:00.000Z"
    );
    expect(
      new Date(localToInstant("America/New_York", { y: 2026, m: 3, d: 8, h: 2, mi: 30, s: 0 })).toISOString()
    ).toBe("2026-03-08T07:30:00.000Z");
  });
  it("DURATION forms, one day for a zero-length all-day, and skips a timed event with no end", () => {
    expect(one("DTSTART:20261105T100000Z", "DURATION:PT1H30M").events[0]?.endsAt).toBe("2026-11-05T11:30:00.000Z");
    expect(one("DTSTART:20261105T100000Z", "DURATION:P1DT2H").events[0]?.endsAt).toBe("2026-11-06T12:00:00.000Z");
    expect(one("DTSTART:20261105T100000Z", "DURATION:P1W").events[0]?.endsAt).toBe("2026-11-12T10:00:00.000Z");
    expect(one("DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261105").events[0]?.endDate).toBe("2026-11-06");
    expect(one("DTSTART;VALUE=DATE:20261105").events[0]?.endDate).toBe("2026-11-06");
    expect(one("DTSTART:20261105T100000Z").skipped).toEqual([{ idPrefix: "z", reason: "no end" }]);
    expect(one("DTSTART:20261105T100000Z", "DTEND:20261105T090000Z").skipped).toEqual([
      { idPrefix: "z", reason: "no end" }
    ]);
    expect(one("DTSTART:20261105T100000Z", "DTEND;TZID=America/New_York:20261105T110000").events[0]?.endsAt).toBe(
      "2026-11-05T16:00:00.000Z"
    );
  });
  it("status, and an empty summary", () => {
    const e = one("DTSTART:20261105T100000Z", "DTEND:20261105T110000Z", "STATUS:CANCELLED", "SUMMARY:").events[0]!;
    expect([e.status, e.title]).toEqual(["cancelled", "(no title)"]);
    expect(one("DTSTART:20261105T100000Z", "DTEND:20261105T110000Z", "STATUS:TENTATIVE").events[0]?.status).toBe(
      "tentative"
    );
  });
  it("keeps a multi-day event that began before the window", () => {
    const out = run(cal(vevent("UID:m", "DTSTART;VALUE=DATE:20260928", "DTEND;VALUE=DATE:20261003")));
    expect(out.events).toHaveLength(1);
  });
});

const endOf = (start: string) =>
  start
    .replace("DTSTART", "DTEND")
    .replace(/T(\d{2})(\d{4})$/, (_m, h: string, rest: string) => `T${String(Number(h) + 1).padStart(2, "0")}${rest}`);
const series = (
  rule: string,
  start = "DTSTART;TZID=Europe/London:20261001T093000",
  extra: string[] = [],
  over: Parameters<typeof run>[1] = {}
) => run(cal(vevent("UID:s", start, endOf(start), `RRULE:${rule}`, ...extra)), over);

describe("recurrence", () => {
  it("daily 01:30 New York over 1 November 2026 stays 01:30 local", () => {
    const out = series("FREQ=DAILY;COUNT=5", "DTSTART;TZID=America/New_York:20261030T013000", [], {
      from: "2026-10-29T00:00:00Z",
      to: "2026-11-05T00:00:00Z"
    });
    expect(starts(out.events)).toEqual([
      "2026-10-30T05:30:00.000Z",
      "2026-10-31T05:30:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
      "2026-11-03T06:30:00.000Z"
    ]);
    // 1 Nov 01:30 is ambiguous: the earlier (EDT) instant is taken.
  });
  it("weekly across the zone's October change keeps 09:00 local", () => {
    const out = series("FREQ=WEEKLY;COUNT=3", "DTSTART;TZID=Australia/Sydney:20260929T090000", [], {
      from: "2026-09-28T00:00:00Z",
      to: "2026-10-20T00:00:00Z"
    });
    expect(starts(out.events)).toEqual([
      "2026-09-28T23:00:00.000Z",
      "2026-10-05T22:00:00.000Z",
      "2026-10-12T22:00:00.000Z"
    ]);
  });
  it("INTERVAL=2 weekly aligns by WKST", () => {
    // DTSTART Sunday 2026-11-01; BYDAY=SU,MO. WKST=MO: Sunday belongs to the week before Monday 2 Nov.
    const mo = series("FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=MO;COUNT=4", "DTSTART;TZID=UTC:20261101T090000", []);
    const su = series("FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU;COUNT=4", "DTSTART;TZID=UTC:20261101T090000", []);
    expect(starts(mo.events).map((s) => s.slice(0, 10))).toEqual([
      "2026-11-01",
      "2026-11-09",
      "2026-11-15",
      "2026-11-23"
    ]);
    expect(starts(su.events).map((s) => s.slice(0, 10))).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-15",
      "2026-11-16"
    ]);
  });
  it("monthly 2nd Tuesday and last Friday; BYMONTHDAY=-1; Outlook last weekday", () => {
    const d = (r: string, start = "DTSTART;TZID=UTC:20261001T090000") =>
      starts(series(r, start, []).events).map((s) => s.slice(0, 10));
    expect(d("FREQ=MONTHLY;BYDAY=2TU;COUNT=3", "DTSTART;TZID=UTC:20261013T090000")).toEqual([
      "2026-10-13",
      "2026-11-10",
      "2026-12-08"
    ]);
    expect(d("FREQ=MONTHLY;BYDAY=-1FR;COUNT=3", "DTSTART;TZID=UTC:20261030T090000")).toEqual([
      "2026-10-30",
      "2026-11-27",
      "2026-12-25"
    ]);
    expect(d("FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3", "DTSTART;TZID=UTC:20261031T090000")).toEqual([
      "2026-10-31",
      "2026-11-30",
      "2026-12-31"
    ]);
    expect(d("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3", "DTSTART;TZID=UTC:20261030T090000")).toEqual([
      "2026-10-30",
      "2026-11-30",
      "2026-12-31"
    ]);
  });
  it("daily BYDAY filters (weekday form); a DTSTART off the rule still counts as instance one", () => {
    const wk = starts(
      series("FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=5", "DTSTART;TZID=UTC:20261105T090000", []).events
    ).map((s) => s.slice(0, 10));
    expect(wk).toEqual(["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11"]);
    const off = starts(series("FREQ=WEEKLY;BYDAY=MO;COUNT=3", "DTSTART;TZID=UTC:20261103T090000", []).events).map((s) =>
      s.slice(0, 10)
    );
    expect(off).toEqual(["2026-11-03", "2026-11-09", "2026-11-16"]);
  });
  it("yearly BYDAY ordinal is month-relative with BYMONTH, year-relative without", () => {
    const a = starts(
      series("FREQ=YEARLY;BYMONTH=11;BYDAY=1SU;COUNT=2", "DTSTART;TZID=UTC:20261101T090000", [], {
        to: "2030-01-01T00:00:00Z"
      }).events
    ).map((s) => s.slice(0, 10));
    expect(a).toEqual(["2026-11-01", "2027-11-07"]);
    const b = starts(
      series("FREQ=YEARLY;BYDAY=20MO;COUNT=2", "DTSTART;TZID=UTC:20260518T090000", [], {
        from: "2026-01-01T00:00:00Z",
        to: "2030-01-01T00:00:00Z"
      }).events
    ).map((s) => s.slice(0, 10));
    expect(b).toEqual(["2026-05-18", "2027-05-17"]);
  });
  it("skips the 31st and 29 February rather than shifting them", () => {
    const m = starts(
      series("FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4", "DTSTART;TZID=UTC:20261031T090000", [], {
        to: "2027-12-01T00:00:00Z"
      }).events
    ).map((s) => s.slice(0, 10));
    expect(m).toEqual(["2026-10-31", "2026-12-31", "2027-01-31", "2027-03-31"]);
    const y = starts(
      series("FREQ=YEARLY;COUNT=2", "DTSTART;TZID=UTC:20280229T090000", [], {
        from: "2028-01-01T00:00:00Z",
        to: "2040-01-01T00:00:00Z"
      }).events
    ).map((s) => s.slice(0, 10));
    expect(y).toEqual(["2028-02-29", "2032-02-29"]);
  });
  it("COUNT counts EXDATEd occurrences and starts years before the window", () => {
    const out = series(
      "FREQ=DAILY;COUNT=4",
      "DTSTART;TZID=UTC:20261101T090000",
      ["EXDATE;TZID=UTC:20261102T090000"],
      {}
    );
    expect(starts(out.events).map((s) => s.slice(8, 10))).toEqual(["01", "03", "04"]);
    const late = series("FREQ=WEEKLY;COUNT=400", "DTSTART;TZID=UTC:20200106T090000", [], {
      from: "2026-10-01T00:00:00Z",
      to: "2026-10-20T00:00:00Z"
    });
    expect(starts(late.events)).toEqual([
      "2026-10-05T09:00:00.000Z",
      "2026-10-12T09:00:00.000Z",
      "2026-10-19T09:00:00.000Z"
    ]);
    const past = series("FREQ=WEEKLY;COUNT=10", "DTSTART;TZID=UTC:20200106T090000", [], {});
    expect(past.events).toEqual([]);
  });
  it("UNTIL as date, floating and Z against a TZID start; all-day against Z", () => {
    const base = "DTSTART;TZID=America/New_York:20261102T210000";
    const days = (r: string) => starts(series(r, base, []).events).map((s) => s.slice(0, 13));
    // 21:00 New York = 02:00Z next day (EST). UNTIL date-only includes that whole local day.
    expect(days("FREQ=DAILY;UNTIL=20261104")).toEqual(["2026-11-03T02", "2026-11-04T02", "2026-11-05T02"]);
    expect(days("FREQ=DAILY;UNTIL=20261104T210000")).toEqual(["2026-11-03T02", "2026-11-04T02", "2026-11-05T02"]);
    expect(days("FREQ=DAILY;UNTIL=20261104T020000Z")).toEqual(["2026-11-03T02", "2026-11-04T02"]);
    const allDay = (until: string) =>
      run(
        cal(
          vevent("UID:a", "DTSTART;VALUE=DATE:20261101", "DTEND;VALUE=DATE:20261102", `RRULE:FREQ=DAILY;UNTIL=${until}`)
        )
      ).events.map((e) => e.startDate);
    expect(allDay("20261103T000000Z")).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(allDay("20261103T235959Z")).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
  });
  it("overrides: moved, cancelled, UTC RECURRENCE-ID on a TZID series, VALUE=DATE EXDATE, same UID; no master", () => {
    const out = run(
      cal(
        vevent(
          "UID:s",
          "DTSTART;TZID=Europe/London:20261102T090000",
          "DTEND;TZID=Europe/London:20261102T100000",
          "RRULE:FREQ=DAILY;COUNT=5",
          "EXDATE;VALUE=DATE:20261104",
          "SUMMARY:Standup"
        ),
        vevent(
          "UID:s",
          "RECURRENCE-ID:20261103T090000Z",
          "DTSTART;TZID=Europe/London:20261103T140000",
          "DTEND;TZID=Europe/London:20261103T150000",
          "SUMMARY:Moved"
        ),
        vevent(
          "UID:s",
          "RECURRENCE-ID;TZID=Europe/London:20261105T090000",
          "DTSTART;TZID=Europe/London:20261105T090000",
          "DTEND;TZID=Europe/London:20261105T100000",
          "STATUS:CANCELLED"
        ),
        vevent("UID:lone", "RECURRENCE-ID:20261110T090000Z", "DTSTART:20261110T120000Z", "DTEND:20261110T130000Z")
      )
    );
    expect(out.events.map((e) => [e.id, e.title, e.status, e.startsAt.slice(5, 16)])).toEqual([
      ["s#20261102", "Standup", "confirmed", "11-02T09:00"],
      ["s#20261103", "Moved", "confirmed", "11-03T14:00"],
      ["s#20261105", "(no title)", "cancelled", "11-05T09:00"],
      ["s#20261106", "Standup", "confirmed", "11-06T09:00"],
      ["lone#20261110", "(no title)", "confirmed", "11-10T12:00"]
    ]);
  });
  it("THISANDFUTURE and unsupported rules skip with a reason that names the UID", () => {
    const out = run(
      cal(
        vevent(
          "UID:tf",
          "RECURRENCE-ID;RANGE=THISANDFUTURE:20261103T090000Z",
          "DTSTART:20261103T100000Z",
          "DTEND:20261103T110000Z"
        ),
        vevent("UID:h", "DTSTART:20261103T100000Z", "DTEND:20261103T110000Z", "RRULE:FREQ=HOURLY"),
        vevent("UID:w", "DTSTART:20261103T100000Z", "DTEND:20261103T110000Z", "RRULE:FREQ=YEARLY;BYWEEKNO=20"),
        vevent("UID:r", "DTSTART:20261103T100000Z", "DTEND:20261103T110000Z", "RDATE:20261201T100000Z")
      )
    );
    expect(out.skipped.map((s) => s.idPrefix)).toEqual(["tf", "h", "w", "r"]);
    expect(out.events).toEqual([]);
  });
  it("duplicate masters keep the higher SEQUENCE", () => {
    const out = run(
      cal(
        vevent("UID:d", "SEQUENCE:1", "SUMMARY:old", "DTSTART:20261105T100000Z", "DTEND:20261105T110000Z"),
        vevent("UID:d", "SEQUENCE:2", "SUMMARY:new", "DTSTART:20261105T100000Z", "DTEND:20261105T110000Z"),
        vevent("UID:d", "SEQUENCE:1", "SUMMARY:late old", "DTSTART:20261105T100000Z", "DTEND:20261105T110000Z")
      )
    );
    expect(out.events.map((e) => e.title)).toEqual(["new"]);
  });
});

describe("jumping to the window", () => {
  const days = (rule: string, start: string, from: string, to: string) =>
    starts(
      run(cal(vevent("UID:j", `DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${start}`, `RRULE:${rule}`)), {
        from,
        to,
        owner: "UTC"
      }).events
    ).map((s) => s.slice(0, 10));
  it("monthly rules far from DTSTART do not lose the first months of the window", () => {
    expect(days("FREQ=MONTHLY", "20190124", "2026-03-01T00:00:00Z", "2026-09-01T00:00:00Z")).toEqual([
      "2026-03-24",
      "2026-04-24",
      "2026-05-24",
      "2026-06-24",
      "2026-07-24",
      "2026-08-24"
    ]);
    expect(days("FREQ=MONTHLY;INTERVAL=2", "20190124", "2026-03-01T00:00:00Z", "2026-09-01T00:00:00Z")).toEqual([
      "2026-03-24",
      "2026-05-24",
      "2026-07-24"
    ]);
    expect(days("FREQ=MONTHLY;BYMONTHDAY=-1", "20240131", "2029-01-01T00:00:00Z", "2029-04-15T00:00:00Z")).toEqual([
      "2029-01-31",
      "2029-02-28",
      "2029-03-31"
    ]);
  });
  it("skips a series that uses EXRULE, with a reason", () => {
    const out = run(
      cal(
        vevent(
          "UID:x",
          "DTSTART:20261105T100000Z",
          "DTEND:20261105T110000Z",
          "RRULE:FREQ=DAILY;COUNT=2",
          "EXRULE:FREQ=DAILY"
        )
      )
    );
    expect(out.events).toEqual([]);
    expect(out.skipped).toEqual([{ idPrefix: "x", reason: "unsupported exception rule" }]);
  });
});

describe("hostile rules and caps", () => {
  const rule = (text: string) => {
    const parsed = parseRule(text);
    return "rule" in parsed ? parsed.rule : parsed;
  };
  it("rejects out-of-range rules fast and never loops on an empty rule", () => {
    expect(rule("FREQ=DAILY;INTERVAL=100000")).toEqual({ reason: "interval out of range" });
    expect(rule("FREQ=DAILY;COUNT=100000")).toEqual({ reason: "count out of range" });
    expect(rule("FREQ=WEEKLY;BYMONTHDAY=3")).toEqual({ reason: "month day on a weekly rule" });
    expect(rule("FREQ=WEEKLY;BYDAY=1MO")).toEqual({ reason: "ordinal day on a daily or weekly rule" });
    const t = Date.now();
    const out = series("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30", "DTSTART;TZID=UTC:20261001T090000", [], {
      from: "2026-01-01T00:00:00Z",
      to: "2100-01-01T00:00:00Z"
    });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(out.events.map((e) => e.startsAt.slice(0, 10))).toEqual(["2026-10-01"]);
  });
  it("COUNT walking caps at 20,000 periods and skips the series visibly", () => {
    const r = rule("FREQ=MONTHLY;BYMONTHDAY=31;BYMONTH=2;COUNT=5");
    if (!("freq" in r)) throw new Error("rule");
    const out = expandDays(r, 20_000, 20_000, 9_999_999, { checkBudget() {} });
    expect(out.capped).toBe(true);
  });
  it("caps VEVENTs at 5,000 and occurrences at 300 per series, 1,500 overall, keeping the nearest", () => {
    const many = Array.from({ length: 5200 }, (_v, i) =>
      vevent(`UID:e${i}`, "DTSTART:20261105T100000Z", "DTEND:20261105T110000Z")
    ).flat();
    const big = run(["BEGIN:VCALENDAR", ...many, "END:VCALENDAR"].join("\r\n"));
    expect(big.veventCapHit).toBe(true);
    expect(big.parseComplete).toBe(false);
    expect(big.events.length).toBe(1500);
    expect(big.occurrenceCapHit).toBe(true);
    const daily = series("FREQ=DAILY", "DTSTART;TZID=UTC:20260101T090000", [], {
      now: "2026-11-15T00:00:00Z",
      from: "2026-01-01T00:00:00Z",
      to: "2027-12-31T00:00:00Z"
    });
    expect(daily.events).toHaveLength(300);
    expect(daily.occurrenceCapHit).toBe(true);
    const days = daily.events.map((e) => Date.parse(e.startsAt));
    expect(Math.max(...days.map((d) => Math.abs(d - Date.parse("2026-11-15T00:00:00Z"))))).toBeLessThanOrEqual(
      151 * 86_400_000
    );
  });
  it("a time budget overrun stops the parse and marks it incomplete", () => {
    let t = 0;
    const out = parseFeed(
      {
        body: enc.encode(
          cal(
            vevent("UID:a", "DTSTART:20261105T100000Z", "DTEND:20261105T110000Z"),
            vevent("UID:b", "DTSTART:20261105T100000Z", "DTEND:20261105T110000Z")
          )
        ),
        now: "2026-11-01T00:00:00Z",
        windowStart: "2026-10-01T00:00:00Z",
        windowEnd: "2027-01-01T00:00:00Z",
        ownerTimeZone: "UTC"
      },
      () => (t += 4000)
    );
    expect(out.timeBudgetHit).toBe(true);
    expect(out.parseComplete).toBe(false);
  });
});

describe("ids", () => {
  it("encodes # and %, and hashes long UIDs behind a marker the encoder always escapes", () => {
    expect(encodeUid("a#b%c")).toBe("a%23b%25c");
    expect(encodeUid("x!y~z@h")).toBe("x%21y~z@h");
    const long = encodeUid("u".repeat(2001));
    expect(long).toMatch(/^![0-9a-f]{32}$/);
    expect(encodeUid(`h-${"a".repeat(32)}`)).toBe(`h-${"a".repeat(32)}`);
  });
  it("keeps every id plus the longest key prefix within the 120-character import key", () => {
    const uids = ["u".repeat(112), "#".repeat(60), "%#".repeat(500), "x".repeat(2001), "日".repeat(40)];
    const text = cal(
      ...uids.map((uid) =>
        vevent(`UID:${uid}`, "DTSTART:20261105T100000Z", "DTEND:20261105T110000Z", "RRULE:FREQ=DAILY;COUNT=2")
      )
    );
    const out = run(text);
    expect(out.events).toHaveLength(uids.length * 2);
    for (const e of out.events) expect(`calendar_feed:series:${e.id}`.length, e.id).toBeLessThanOrEqual(120);
  });
});
