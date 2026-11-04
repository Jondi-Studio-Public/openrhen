import { calendarEventSchema, type CalendarEvent } from "@openrhen/contracts";
import {
  CALENDAR_FEED_SERIES_BATCH_MAX_CHARS,
  CALENDAR_FEED_SERIES_MAX_CHARS,
  calendarFeedSeriesSchema,
  type CalendarFeedSeries
} from "@openrhen/contracts/integrations/calendar-feed";
import { describe, expect, it } from "vitest";
import { toCalendarEvent } from "./connection.js";
import { parseFeed, type FeedEvent, type ParseResult } from "./parse.js";
import { mapRepeat } from "./series.js";
import { parseRule } from "./rrule.js";

const NOW = "2026-11-01T12:00:00Z"; // Sunday 2026-11-01; the New York fold day
const enc = new TextEncoder();
const cal = (...events: string[][]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...events.flat(), "END:VCALENDAR"].join("\r\n") + "\r\n";
const vevent = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];

function run(text: string, now = NOW): ParseResult {
  return parseFeed({
    body: enc.encode(text),
    now,
    windowStart: "2026-10-25T00:00:00Z",
    windowEnd: "2027-06-01T00:00:00Z",
    ownerTimeZone: "America/New_York"
  });
}

/** A timed repeating master in New York; Tuesday 2026-11-03 09:00 to 10:00 unless overridden. */
function master(rrule: string, ...extra: string[]): string[] {
  const lines = extra.some((l) => l.startsWith("DTSTART")) ? [] : ["DTSTART;TZID=America/New_York:20261103T090000"];
  const end = extra.some((l) => l.startsWith("DTEND")) ? [] : ["DTEND;TZID=America/New_York:20261103T100000"];
  return vevent("UID:s1", ...lines, ...end, `RRULE:${rrule}`, "SUMMARY:Standup", "LOCATION:Room 1", ...extra);
}

function seriesOf(result: ParseResult, uid = "s1"): CalendarFeedSeries | undefined {
  return result.events.find((e) => e.uid === uid && e.series)?.series;
}
const reasons = (result: ParseResult) => result.unrepresentableSeries.map((s) => s.reason);

describe("representable series", () => {
  it("maps a weekly Tuesday and Thursday rule and carries it once, on the first event", () => {
    const result = run(cal(master("FREQ=WEEKLY;BYDAY=TU,TH")));
    const series = seriesOf(result)!;
    expect(series).toMatchObject({
      uid: "s1",
      idPrefix: "s1",
      timezone: "America/New_York",
      status: "confirmed",
      title: "Standup",
      location: "Room 1",
      startDate: "2026-11-03",
      endDate: null,
      repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [2, 4] },
      localStartTime: "09:00",
      localEndTime: "10:00",
      exceptions: []
    });
    expect(calendarFeedSeriesSchema.parse(series)).toEqual(series);
    expect(result.unrepresentableSeries).toEqual([]);
    // The proxy always emits the expanded instances; the descriptor is an extra on the first one only.
    const mine = result.events.filter((e) => e.uid === "s1");
    expect(mine.length).toBeGreaterThan(50);
    expect(mine.filter((e) => e.series)).toHaveLength(1);
    expect(mine[0]!.series).toBe(series);
    expect(mine.every((e) => e.recurring)).toBe(true);
  });

  it("carries the descriptor into attributes.series and still validates as a CalendarEvent", () => {
    const result = run(cal(master("FREQ=DAILY;INTERVAL=3")));
    const wire: CalendarEvent[] = result.events.map((e) =>
      calendarEventSchema.parse(toCalendarEvent(e, "America/New_York"))
    );
    const carriers = wire.filter((e) => "series" in e.attributes);
    expect(carriers).toHaveLength(1);
    expect(calendarFeedSeriesSchema.parse(carriers[0]!.attributes.series).repeat).toEqual({
      unit: "days",
      intervalDays: 3
    });
  });

  it.each([
    ["FREQ=DAILY", { unit: "days", intervalDays: 1 }],
    ["FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR", null],
    ["FREQ=WEEKLY;INTERVAL=2", { unit: "weeks", intervalWeeks: 2, weekdays: [2] }],
    ["FREQ=MONTHLY", { unit: "months", intervalMonths: 1, anchor: "day_of_month" }],
    ["FREQ=MONTHLY;BYMONTHDAY=3", { unit: "months", intervalMonths: 1, anchor: "day_of_month" }],
    ["FREQ=MONTHLY;BYDAY=1TU", { unit: "months", intervalMonths: 1, anchor: "nth_weekday" }],
    ["FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1", { unit: "months", intervalMonths: 1, anchor: "nth_weekday" }],
    ["FREQ=YEARLY", { unit: "months", intervalMonths: 12, anchor: "day_of_month" }],
    ["FREQ=YEARLY;BYMONTH=11", { unit: "months", intervalMonths: 12, anchor: "day_of_month" }]
  ])("maps %s", (rrule, repeat) => {
    const series = seriesOf(run(cal(master(rrule))));
    expect(series, rrule).toBeDefined();
    if (repeat) expect(series!.repeat).toEqual(repeat);
    else expect(series!.repeat).toEqual({ unit: "weeks", intervalWeeks: 1, weekdays: [1, 2, 3, 4, 5] });
  });

  it("maps a last weekday and a last day", () => {
    // 2026-11-24 is the last Tuesday of November; 2026-11-30 is the last day.
    const lastTuesday = master(
      "FREQ=MONTHLY;BYDAY=-1TU",
      "DTSTART;TZID=America/New_York:20261124T090000",
      "DTEND;TZID=America/New_York:20261124T100000"
    );
    expect(seriesOf(run(cal(lastTuesday)))!.repeat).toEqual({
      unit: "months",
      intervalMonths: 1,
      anchor: "last_weekday"
    });
    const lastDay = master(
      "FREQ=MONTHLY;BYMONTHDAY=-1",
      "DTSTART;TZID=America/New_York:20261130T090000",
      "DTEND;TZID=America/New_York:20261130T100000"
    );
    expect(seriesOf(run(cal(lastDay)))!.repeat).toMatchObject({ anchor: "last_day" });
  });

  it("holds a cancelled master as a descriptor with its status", () => {
    expect(seriesOf(run(cal(master("FREQ=WEEKLY", "STATUS:CANCELLED"))))!.status).toBe("cancelled");
  });
});

describe("bounds", () => {
  it("counts excluded instances toward COUNT", () => {
    // Five Tuesdays from 11-03: 11-03, 11-10, 11-17, 11-24, 12-01. The excluded 11-10 still counts.
    const series = seriesOf(run(cal(master("FREQ=WEEKLY;COUNT=5", "EXDATE;TZID=America/New_York:20261110T090000"))))!;
    expect(series.endDate).toBe("2026-12-01");
    expect(series.exceptions).toEqual([{ kind: "cancelled", date: "2026-11-10" }]);
  });

  it("reads a date-only UNTIL as inclusive of that day", () => {
    expect(seriesOf(run(cal(master("FREQ=WEEKLY;UNTIL=20261117"))))!.endDate).toBe("2026-11-17");
  });

  it("converts a UTC UNTIL by instant, not by its date", () => {
    // Tuesday 23:30 in New York (EST) is Wednesday 04:30Z. The 11-17 instance starts 2026-11-18T04:30Z.
    const late = (until: string) =>
      master(
        `FREQ=WEEKLY;UNTIL=${until}`,
        "DTSTART;TZID=America/New_York:20261103T233000",
        "DTEND;TZID=America/New_York:20261103T235500"
      );
    expect(seriesOf(run(cal(late("20261118T043000Z"))))!.endDate).toBe("2026-11-17");
    expect(seriesOf(run(cal(late("20261118T042959Z"))))!.endDate).toBe("2026-11-10");
    // The UTC date (11-18) is not a Tuesday: a date-based reading would have ended it on 11-18 or missed 11-17.
    expect(seriesOf(run(cal(late("20261117T235959Z"))))!.endDate).toBe("2026-11-10");
  });

  it("finds the end of a far-off UNTIL without expanding every day", () => {
    const series = seriesOf(run(cal(master("FREQ=DAILY;UNTIL=20991231T000000Z"))))!;
    expect(series.endDate).toBe("2099-12-30");
  });

  it("refuses a series that ends before it starts", () => {
    const result = run(cal(master("FREQ=WEEKLY;UNTIL=20261101")));
    expect(seriesOf(result)).toBeUndefined();
    expect(reasons(result)).toEqual(["series ends before it starts"]);
  });
});

describe("exceptions", () => {
  it("drops exceptions older than yesterday and keeps yesterday's", () => {
    // Daily from 2026-10-20. now is 2026-11-01 12:00Z (08:00 EDT... the fold day), so yesterday is 2026-10-31.
    const result = run(
      cal(
        master(
          "FREQ=DAILY",
          "DTSTART;TZID=America/New_York:20261020T090000",
          "DTEND;TZID=America/New_York:20261020T100000",
          "EXDATE;TZID=America/New_York:20261029T090000,20261030T090000,20261031T090000,20261105T090000"
        )
      )
    );
    expect(seriesOf(result)!.exceptions.map((e) => e.date)).toEqual(["2026-10-31", "2026-11-05"]);
  });

  it("describes a moved time, a cancelled override, and ignores a change that is not about the rule", () => {
    const base = ["UID:s1"];
    const override = (date: string, ...lines: string[]) =>
      vevent(...base, `RECURRENCE-ID;TZID=America/New_York:${date}T090000`, ...lines);
    const result = run(
      cal(
        master("FREQ=WEEKLY"),
        override(
          "20261110",
          "DTSTART;TZID=America/New_York:20261110T140000",
          "DTEND;TZID=America/New_York:20261110T153000",
          "SUMMARY:Standup (moved)",
          "LOCATION:Room 1"
        ),
        override(
          "20261117",
          "DTSTART;TZID=America/New_York:20261117T090000",
          "DTEND;TZID=America/New_York:20261117T100000",
          "SUMMARY:Standup",
          "LOCATION:Room 1",
          "STATUS:CANCELLED"
        ),
        override(
          "20261124",
          "DTSTART;TZID=America/New_York:20261124T090000",
          "DTEND;TZID=America/New_York:20261124T100000",
          "SUMMARY:Standup",
          "LOCATION:Room 1",
          "DESCRIPTION:only the notes changed"
        )
      )
    );
    expect(seriesOf(result)!.exceptions).toEqual([
      {
        kind: "changed",
        date: "2026-11-10",
        title: "Standup (moved)",
        location: "Room 1",
        startDate: "2026-11-10",
        localStartTime: "14:00",
        endDate: "2026-11-10",
        localEndTime: "15:30"
      },
      { kind: "cancelled", date: "2026-11-17" }
    ]);
    // The expanded instances are still emitted, the override at its own time.
    expect(result.events.some((e) => e.id === "s1#20261110" && e.startsAt === "2026-11-10T19:00:00.000Z")).toBe(true);
  });

  it("reads an override in another zone as wall time in the series zone", () => {
    const result = run(
      cal(
        master("FREQ=WEEKLY"),
        vevent(
          "UID:s1",
          "RECURRENCE-ID;TZID=America/New_York:20261110T090000",
          "DTSTART:20261110T200000Z",
          "DTEND:20261110T210000Z",
          "SUMMARY:Standup",
          "LOCATION:Room 1"
        )
      )
    );
    expect(seriesOf(result)!.exceptions).toMatchObject([
      { kind: "changed", localStartTime: "15:00", localEndTime: "16:00" }
    ]);
  });

  it.each([
    ["the second pass of the repeated hour", "20261101T063000Z", "20261101T073000Z"],
    ["the first pass, where the end lands on the same wall time", "20261101T053000Z", "20261101T063000Z"]
  ])("refuses a change on %s of the New York fall-back", (_name, start, end) => {
    const result = run(
      cal(
        master(
          "FREQ=WEEKLY",
          "DTSTART;TZID=America/New_York:20261025T090000",
          "DTEND;TZID=America/New_York:20261025T100000"
        ),
        vevent(
          "UID:s1",
          "RECURRENCE-ID;TZID=America/New_York:20261101T090000",
          `DTSTART:${start}`,
          `DTEND:${end}`,
          "SUMMARY:x"
        )
      )
    );
    expect(seriesOf(result)).toBeUndefined();
    expect(reasons(result)).toEqual(["a change falls on a repeated or skipped clock time"]);
  });

  it("refuses an all-day change and a change on a date the rule does not produce", () => {
    const allDay = run(
      cal(
        master("FREQ=WEEKLY"),
        vevent(
          "UID:s1",
          "RECURRENCE-ID;TZID=America/New_York:20261110T090000",
          "DTSTART;VALUE=DATE:20261110",
          "SUMMARY:x"
        )
      )
    );
    expect(reasons(allDay)).toEqual(["a change turns one date all-day"]);
    const stray = run(
      cal(
        master("FREQ=WEEKLY"),
        vevent(
          "UID:s1",
          "RECURRENCE-ID;TZID=America/New_York:20261111T090000",
          "DTSTART;TZID=America/New_York:20261111T090000",
          "DTEND;TZID=America/New_York:20261111T100000",
          "SUMMARY:x"
        )
      )
    );
    expect(reasons(stray)).toEqual(["a change on a date the rule does not produce"]);
  });

  it("refuses a series with a this-and-future change", () => {
    const result = run(
      cal(
        master("FREQ=WEEKLY"),
        vevent(
          "UID:s1",
          "RECURRENCE-ID;TZID=America/New_York;RANGE=THISANDFUTURE:20261117T090000",
          "DTSTART;TZID=America/New_York:20261117T100000",
          "DTEND;TZID=America/New_York:20261117T110000"
        )
      )
    );
    expect(reasons(result)).toEqual(["this-and-future change"]);
  });
});

describe("path D: unrepresentable series are reported with a reason and still expanded", () => {
  it.each([
    [
      "floating start",
      ["DTSTART:20261103T090000", "DTEND:20261103T100000"],
      "FREQ=WEEKLY",
      "no time zone on the start"
    ],
    ["UTC start", ["DTSTART:20261103T140000Z", "DTEND:20261103T150000Z"], "FREQ=WEEKLY", "no time zone on the start"],
    ["all-day", ["DTSTART;VALUE=DATE:20261103", "DTEND;VALUE=DATE:20261104"], "FREQ=WEEKLY", "all-day repeating event"],
    [
      "spans midnight",
      ["DTSTART;TZID=America/New_York:20261103T220000", "DTEND;TZID=America/New_York:20261104T010000"],
      "FREQ=WEEKLY",
      "event does not end on its start day"
    ],
    ["several month days", [], "FREQ=MONTHLY;BYMONTHDAY=3,17", "monthly rule on several or other days"],
    ["fifth weekday", [], "FREQ=MONTHLY;BYDAY=5TU", "monthly weekday position not supported"],
    ["monthly in some months", [], "FREQ=MONTHLY;BYMONTH=1,2", "monthly rule with limits"],
    ["weekly by set position", [], "FREQ=WEEKLY;BYSETPOS=1;BYDAY=TU,TH", "weekly rule with limits"],
    ["daily every other weekday", [], "FREQ=DAILY;INTERVAL=2;BYDAY=MO,TU", "daily rule with limits"],
    [
      "start off the rule",
      ["DTSTART;TZID=America/New_York:20261102T090000", "DTEND;TZID=America/New_York:20261102T100000"],
      "FREQ=WEEKLY;BYDAY=TU",
      "start date is not on the rule"
    ]
  ])("%s", (_name, lines, rrule, reason) => {
    const result = run(cal(master(rrule, ...lines)));
    expect(seriesOf(result)).toBeUndefined();
    expect(result.unrepresentableSeries).toEqual([{ idPrefix: "s1", reason }]);
    expect(result.events.filter((e) => e.uid === "s1").length).toBeGreaterThan(1);
    expect(result.events.every((e) => e.series === undefined)).toBe(true);
  });

  it("refuses when the safety net finds the portal would produce other dates (week start)", () => {
    // Sunday-first weeks: every other week's Sunday and Monday. The portal's weeks start Monday, so the Sunday lands a week early.
    const result = run(
      cal(
        master(
          "FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU",
          "DTSTART;TZID=America/New_York:20261108T090000",
          "DTEND;TZID=America/New_York:20261108T100000"
        )
      )
    );
    expect(reasons(result)).toEqual(["repeat does not match the feed's dates"]);
  });

  it("keeps the unrepresentable ones apart from parser skips", () => {
    const result = run(cal(master("FREQ=SECONDLY")));
    expect(result.unrepresentableSeries).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });
});

describe("daylight saving: the safety net compares instants through the contracts function", () => {
  const ny = (day: string, start: string, end: string) => [
    `DTSTART;TZID=America/New_York:${day}T${start}00`,
    `DTEND;TZID=America/New_York:${day}T${end}00`
  ];
  it("refuses an instance whose wall time is in a spring-forward gap", () => {
    // Sundays 02:30; 2027-03-14 has no 02:30 in New York and the two functions disagree about it.
    const result = run(cal(master("FREQ=WEEKLY", ...ny("20261108", "0230", "0300"))));
    expect(reasons(result)).toEqual(["a wall time changes with daylight saving"]);
  });
  it("refuses an instance on a fold date where the two functions pick different instants", () => {
    const result = parseFeed({
      body: enc.encode(
        cal(
          vevent(
            "UID:s1",
            "DTSTART;TZID=Europe/London:20261108T013000",
            "DTEND;TZID=Europe/London:20261108T020000",
            "RRULE:FREQ=WEEKLY"
          )
        )
      ),
      now: NOW,
      windowStart: "2026-10-25T00:00:00Z",
      windowEnd: "2027-06-01T00:00:00Z",
      ownerTimeZone: "Europe/London"
    });
    expect(reasons(result)).toEqual(["a wall time changes with daylight saving"]);
  });
  it("refuses an event whose length crosses a clock change", () => {
    // Sundays 01:00 to 03:30 (2.5 hours on an ordinary Sunday). On 2027-03-14 it ends at 04:30.
    const result = run(cal(master("FREQ=WEEKLY", ...ny("20261108", "0100", "0330"))));
    expect(reasons(result)).toEqual(["a wall time changes with daylight saving"]);
  });
  it("accepts a rule whose instances never meet a clock change at their time", () => {
    // Mondays 02:30: no clock change falls on a Monday in the next 400 days.
    expect(seriesOf(run(cal(master("FREQ=WEEKLY", ...ny("20261109", "0230", "0300")))))).toBeDefined();
  });
});

describe("size caps", () => {
  const manyChanges = (uid: string, count: number, title: string): string[][] => {
    const rows: string[][] = [
      vevent(
        `UID:${uid}`,
        "DTSTART;TZID=America/New_York:20261103T090000",
        "DTEND;TZID=America/New_York:20261103T100000",
        "RRULE:FREQ=WEEKLY",
        `SUMMARY:${title}`
      )
    ];
    for (let i = 1; i <= count; i++) {
      const d = new Date(Date.UTC(2026, 10, 3 + 7 * i)).toISOString().slice(0, 10).replaceAll("-", "");
      rows.push(
        vevent(
          `UID:${uid}`,
          `RECURRENCE-ID;TZID=America/New_York:${d}T090000`,
          `DTSTART;TZID=America/New_York:${d}T110000`,
          `DTEND;TZID=America/New_York:${d}T120000`,
          `SUMMARY:${title} ${i}`
        )
      );
    }
    return rows;
  };

  it("refuses one series whose descriptor passes 8,000 characters", () => {
    const result = run(cal(...manyChanges("s1", 40, "x".repeat(150))));
    expect(seriesOf(result)).toBeUndefined();
    expect(reasons(result)).toEqual(["too many changes to describe"]);
    const small = seriesOf(run(cal(...manyChanges("s1", 5, "x".repeat(30)))))!;
    expect(JSON.stringify(small).length).toBeLessThan(CALENDAR_FEED_SERIES_MAX_CHARS);
  });

  it("keeps the descriptors of one read under 30,000 characters and reports the rest", () => {
    const uids = Array.from({ length: 20 }, (_, i) => `u${String(i).padStart(2, "0")}`);
    const result = run(cal(...uids.flatMap((uid) => manyChanges(uid, 12, "y".repeat(100)))));
    const carried = result.events.filter((e) => e.series).map((e) => e.series!);
    const total = carried.reduce((sum, s) => sum + JSON.stringify(s).length, 0);
    expect(total).toBeLessThanOrEqual(CALENDAR_FEED_SERIES_BATCH_MAX_CHARS);
    expect(carried.length).toBeGreaterThan(2);
    expect(carried.length + result.unrepresentableSeries.length).toBe(uids.length);
    expect(new Set(reasons(result))).toEqual(new Set(["too many repeating events in one read"]));
    // Stable: UID order decides who is kept.
    expect(carried.map((s) => s.uid)).toEqual(uids.slice(0, carried.length));
  });
});

describe("mapRepeat", () => {
  const map = (rrule: string, startDay = 20_000) => {
    const parsed = parseRule(rrule);
    if (!("rule" in parsed)) throw new Error(parsed.reason);
    return mapRepeat(parsed.rule, startDay);
  };
  it("numbers weekdays from Sunday as the contracts do", () => {
    // 20,000 days after the epoch is 2024-10-04, a Friday.
    expect(map("FREQ=WEEKLY")).toEqual({ unit: "weeks", intervalWeeks: 1, weekdays: [5] });
    expect(map("FREQ=WEEKLY;BYDAY=SU,SA,MO")).toEqual({ unit: "weeks", intervalWeeks: 1, weekdays: [0, 1, 6] });
  });
  it("keeps a yearly interval as months", () => {
    expect(map("FREQ=YEARLY;INTERVAL=2")).toEqual({ unit: "months", intervalMonths: 24, anchor: "day_of_month" });
  });
});

describe("feed event shape", () => {
  it("leaves FeedEvent.series unset when there is no series", () => {
    const result = run(cal(vevent("UID:one", "DTSTART:20261105T100000Z", "DTEND:20261105T110000Z")));
    const event: FeedEvent = result.events[0]!;
    expect("series" in event).toBe(false);
    expect(result.unrepresentableSeries).toEqual([]);
  });
});
