import { describe, expect, it } from "vitest";
import { buildCalendar, OLDER_THAN_WINDOW_NOTICE, shiftAnchor, spanWindowLabel, weekdayIndex } from "./calendar-model";

type Input = Parameters<typeof buildCalendar>[0];
type State = Input["state"];

const NOW = new Date("2026-10-05T02:00:00Z"); // Monday 5 Oct 2026, 13:00 in Melbourne
const tz = "Australia/Melbourne";

const session = (id: string, endedAt: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    actionId: "a1",
    actionTitle: `Work ${id}`,
    result: "completed",
    startedAt: endedAt,
    endedAt,
    plannedMinutes: 30,
    activeMinutes: 25,
    remainingBeforeMinutes: 0,
    remainingAfterMinutes: 0,
    ...extra
  }) as State["completedToday"][number];

const stateWith = (patch: Partial<State> = {}): State => ({
  completedToday: [],
  sleepPlans: [],
  occurrences: [],
  spans: [],
  actions: [],
  settings: { timezone: tz },
  ...patch
});

const build = (view: "week" | "month", anchor: string, patch: Partial<State> = {}) =>
  buildCalendar({ view, anchor, now: NOW, state: stateWith(patch) });

describe("weekdayIndex and shiftAnchor", () => {
  it("counts Monday as 0 and Sunday as 6", () => {
    expect(weekdayIndex("2026-10-05")).toBe(0);
    expect(weekdayIndex("2026-10-11")).toBe(6);
  });

  it("steps a week by seven days and a month to the first of the next or previous month", () => {
    expect(shiftAnchor("week", "2026-10-05", -1)).toBe("2026-09-28");
    expect(shiftAnchor("month", "2026-10-17", 1)).toBe("2026-11-01");
    expect(shiftAnchor("month", "2026-01-17", -1)).toBe("2025-12-01");
    expect(shiftAnchor("month", "2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("buildCalendar grid", () => {
  it("shows Monday to Sunday for a week and pads a month to whole weeks", () => {
    const week = build("week", "2026-10-07");
    expect(week.weeks).toHaveLength(1);
    expect(week.weeks[0]!.days.map((day) => day.key)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11"
    ]);
    const month = build("month", "2026-10-15");
    expect(month.title).toBe("October 2026");
    expect(month.weeks).toHaveLength(5);
    expect(month.weeks[0]!.days[0]!.key).toBe("2026-09-28");
    expect(month.weeks[0]!.days[0]!.inRange).toBe(false);
    expect(month.weeks[0]!.days[3]!.inRange).toBe(true);
    expect(month.weeks[4]!.days[6]!.key).toBe("2026-11-01");
    expect(month.weeks.flatMap((w) => w.days).find((d) => d.isToday)?.key).toBe("2026-10-05");
  });
});

describe("buildCalendar day contents", () => {
  it("files sessions, sleep and closed occurrences under the person's local day", () => {
    // 2026-10-04T14:30Z is 01:30 on 5 Oct in Melbourne (UTC+11 in daylight time)
    const model = build("week", "2026-10-05", {
      completedToday: [
        session("late", "2026-10-04T14:30:00Z"),
        session("sleepy", "2026-10-05T20:00:00Z", { targetType: "sleep", actionTitle: "Sleep" })
      ],
      occurrences: [
        { id: "o1", actionId: "a1", windowName: "Morning", localDate: "2026-10-06", status: "completed" },
        { id: "o2", actionId: "a1", windowName: "Evening", localDate: "2026-10-06", status: "missed" },
        { id: "o3", actionId: "a1", windowName: "Pending", localDate: "2026-10-06", status: "pending" }
      ] as State["occurrences"],
      actions: [{ id: "a1", title: "Stretch" }] as State["actions"]
    });
    const days = model.weeks[0]!.days;
    expect(days[0]!.sessions.map((entry) => entry.title)).toEqual(["Work late"]);
    expect(days[1]!.sleep.map((entry) => entry.title)).toEqual(["Sleep"]);
    expect(days[1]!.sessions).toEqual([]);
    expect(days[1]!.occurrences.map((entry) => entry.title)).toEqual(["Stretch · Morning", "Stretch · Evening"]);
  });
});

const night = (id: string, actualStartAt: string, actualWakeAt: string, extra: Record<string, unknown> = {}) =>
  ({ id, status: "completed", actualStartAt, actualWakeAt, manual: true, ...extra }) as State["sleepPlans"][number];

describe("buildCalendar sleep logged by hand", () => {
  // Melbourne is UTC+11 on these dates, so 2026-10-03T20:00Z to 2026-10-04T03:42Z is 07:00 to 14:42 on 4 Oct.
  const manual = night("n1", "2026-10-03T20:00:00Z", "2026-10-04T03:42:00Z");

  it("lists a completed plan with no sleep session on the local day it ended, worded as Today words it", () => {
    const model = build("week", "2026-09-28", { sleepPlans: [manual] });
    const day = model.weeks[0]!.days[6]!;
    expect(day.key).toBe("2026-10-04");
    expect(day.sleep).toEqual([
      { id: "sleep:n1", title: "Slept 7.7h · logged by hand", detail: "462 min · ends 2:42 pm" }
    ]);
    expect(model.weeks[0]!.days.slice(0, 6).flatMap((item) => item.sleep)).toEqual([]);
  });

  it("drops the by-hand wording for a tracked night", () => {
    const tracked = night("n1", "2026-10-03T20:00:00Z", "2026-10-04T03:42:00Z", { manual: undefined });
    const day = build("week", "2026-09-28", { sleepPlans: [tracked] }).weeks[0]!.days[6]!;
    expect(day.sleep.map((entry) => entry.title)).toEqual(["Slept 7.7h"]);
  });

  it("does not list a plan a sleep session already covers", () => {
    const model = build("week", "2026-09-28", {
      sleepPlans: [manual],
      completedToday: [
        session("s1", "2026-10-04T03:42:00Z", { targetType: "sleep", actionId: "n1", actionTitle: "Sleep" })
      ]
    });
    expect(model.weeks[0]!.days[6]!.sleep.map((entry) => entry.id)).toEqual(["s1"]);
  });

  it("ignores plans that are not completed or lack actual times", () => {
    const model = build("week", "2026-09-28", {
      sleepPlans: [
        { ...manual, id: "planned", status: "planned" },
        { ...manual, id: "open", actualWakeAt: undefined },
        { ...manual, id: "cancelled", status: "cancelled" }
      ] as State["sleepPlans"]
    });
    expect(model.weeks[0]!.days.flatMap((item) => item.sleep)).toEqual([]);
  });

  it("leaves out nights from before the 30-day window", () => {
    // NOW is 5 Oct, so the window starts 5 Sep; a night ending 4 Sep is out, one ending 5 Sep is in.
    const model = build("month", "2026-09-15", {
      sleepPlans: [
        night("old", "2026-09-03T12:00:00Z", "2026-09-03T20:00:00Z"),
        night("edge", "2026-09-04T13:00:00Z", "2026-09-04T21:00:00Z")
      ]
    });
    const keyed = model.weeks.flatMap((week) => week.days).filter((item) => item.sleep.length);
    expect(keyed.map((item) => [item.key, item.sleep[0]!.id])).toEqual([["2026-09-05", "sleep:edge"]]);
  });
});

const trip = {
  id: "trip",
  title: "Trip 1",
  startDate: "2026-09-27",
  endDate: "2026-09-29"
};

describe("buildCalendar spans", () => {
  it("draws a band across its days with a lane and a window label", () => {
    const model = build("week", "2026-09-28", {
      spans: [{ ...trip, window: { localStartTime: "09:00", localEndTime: "17:30" } }]
    });
    const [band] = model.weeks[0]!.bands;
    expect(band).toMatchObject({
      title: "Trip 1",
      windowLabel: "09:00–17:30",
      startColumn: 0,
      endColumn: 1,
      lane: 0,
      continuesBefore: true,
      continuesAfter: false
    });
  });

  it("splits a span across a month boundary and across weeks in the month view", () => {
    const model = build("month", "2026-09-15", {
      spans: [{ id: "x", title: "Long trip", startDate: "2026-09-24", endDate: "2026-10-08" }]
    });
    // September 2026 grid: weeks starting 31 Aug, 7, 14, 21, 28 Sep. The span reaches the last two.
    const withBands = model.weeks.map((week) => week.bands.map((b) => [b.startColumn, b.endColumn, b.continuesAfter]));
    expect(withBands).toEqual([[], [], [], [[3, 6, true]], [[0, 6, true]]]);
    const october = build("month", "2026-10-01", {
      spans: [{ id: "x", title: "Long trip", startDate: "2026-09-24", endDate: "2026-10-08" }]
    });
    // The October grid starts Monday 28 Sep, so the same trip shows continuing in and ending 8 Oct.
    expect(october.weeks[0]!.bands[0]).toMatchObject({ startColumn: 0, endColumn: 6, continuesBefore: true });
    expect(october.weeks[1]!.bands[0]).toMatchObject({ startColumn: 0, endColumn: 3, continuesAfter: false });
  });

  it("stacks overlapping spans into separate lanes and reuses a lane once it is free", () => {
    const model = build("week", "2026-10-05", {
      spans: [
        { id: "a", title: "A", startDate: "2026-10-05", endDate: "2026-10-07" },
        { id: "b", title: "B", startDate: "2026-10-06", endDate: "2026-10-09" },
        { id: "c", title: "C", startDate: "2026-10-08", endDate: "2026-10-08" }
      ]
    });
    const lanes = Object.fromEntries(model.weeks[0]!.bands.map((band) => [band.title, band.lane]));
    expect(lanes).toEqual({ A: 0, B: 1, C: 0 });
    expect(model.weeks[0]!.laneCount).toBe(2);
  });

  it("keeps a span out of weeks it does not touch", () => {
    const model = build("week", "2026-10-05", { spans: [trip] });
    expect(model.weeks[0]!.bands).toEqual([]);
    expect(model.weeks[0]!.laneCount).toBe(0);
  });

  it("shows days with and without sessions inside a span without marking either as empty", () => {
    const model = build("week", "2026-10-05", {
      spans: [{ id: "s", title: "Sick", startDate: "2026-10-05", endDate: "2026-10-07" }],
      completedToday: [session("one", "2026-10-06T01:00:00Z")]
    });
    const days = model.weeks[0]!.days;
    expect(days[0]!.sessions).toEqual([]);
    expect(days[1]!.sessions).toHaveLength(1);
    expect(days.every((day) => !day.beforeSessionWindow)).toBe(true);
    expect(model.notice).toBeUndefined();
  });
});

describe("buildCalendar session window", () => {
  it("flags days before the window and says sessions are not kept, while still drawing the span", () => {
    // The window starts 30 days back: 2026-09-05. The trip on 27-29 Sep is inside, so go earlier.
    const model = build("week", "2026-08-12", {
      spans: [{ id: "old", title: "Old trip", startDate: "2026-08-10", endDate: "2026-08-14" }]
    });
    expect(model.notice).toBe(OLDER_THAN_WINDOW_NOTICE);
    expect(OLDER_THAN_WINDOW_NOTICE).toBe("Sessions older than 30 days are not kept in this view");
    expect(model.weeks[0]!.days.every((day) => day.beforeSessionWindow)).toBe(true);
    expect(model.weeks[0]!.bands).toHaveLength(1);
  });

  it("gives no notice for a view wholly inside the window", () => {
    expect(build("week", "2026-10-05").notice).toBeUndefined();
  });
});

describe("spanWindowLabel", () => {
  it("is absent without a window", () => {
    expect(spanWindowLabel({})).toBeUndefined();
    expect(spanWindowLabel({ window: { localStartTime: "08:00", localEndTime: "09:15" } })).toBe("08:00–09:15");
  });
});
