import { describe, expect, it } from "vitest";
import { groupCalendarSeries, type CalendarSeriesEvent } from "./calendar-series";

function event(
  overrides: Partial<CalendarSeriesEvent> & { externalEventId: string; startsAt: string; endsAt: string }
): CalendarSeriesEvent {
  return { title: "Piano lesson", location: null, recurring: true, seriesId: "piano-series", ...overrides };
}

describe("groupCalendarSeries", () => {
  it("collapses a fortnightly series with uniform spacing into one recurring group", () => {
    const events = [
      event({
        externalEventId: "piano-series-1",
        startsAt: "2026-08-14T04:00:00.000Z",
        endsAt: "2026-08-14T05:00:00.000Z"
      }),
      event({
        externalEventId: "piano-series-2",
        startsAt: "2026-08-28T04:00:00.000Z",
        endsAt: "2026-08-28T05:00:00.000Z"
      }),
      event({
        externalEventId: "piano-series-3",
        startsAt: "2026-09-11T04:00:00.000Z",
        endsAt: "2026-09-11T05:00:00.000Z"
      })
    ];
    const { series, ungrouped } = groupCalendarSeries(events, "Australia/Sydney");
    expect(ungrouped).toHaveLength(0);
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      seriesId: "piano-series",
      title: "Piano lesson",
      startDate: "2026-08-14",
      intervalDays: 14,
      localStartTime: "14:00",
      localEndTime: "15:00"
    });
  });

  it("keeps a single-instance series as an ungrouped event", () => {
    const events = [
      event({ externalEventId: "solo-1", startsAt: "2026-08-14T04:00:00.000Z", endsAt: "2026-08-14T05:00:00.000Z" })
    ];
    const { series, ungrouped } = groupCalendarSeries(events, "Australia/Sydney");
    expect(series).toHaveLength(0);
    expect(ungrouped).toHaveLength(1);
  });

  it("falls back to ungrouped when spacing is irregular (a skipped or moved occurrence)", () => {
    const events = [
      event({
        externalEventId: "irregular-1",
        startsAt: "2026-08-14T04:00:00.000Z",
        endsAt: "2026-08-14T05:00:00.000Z"
      }),
      event({
        externalEventId: "irregular-2",
        startsAt: "2026-08-28T04:00:00.000Z",
        endsAt: "2026-08-28T05:00:00.000Z"
      }),
      event({
        externalEventId: "irregular-3",
        startsAt: "2026-09-18T04:00:00.000Z",
        endsAt: "2026-09-18T05:00:00.000Z"
      })
    ];
    const { series, ungrouped } = groupCalendarSeries(events, "Australia/Sydney");
    expect(series).toHaveLength(0);
    expect(ungrouped).toHaveLength(3);
  });

  it("falls back to ungrouped when the time of day changes between occurrences", () => {
    const events = [
      event({ externalEventId: "shifted-1", startsAt: "2026-08-14T04:00:00.000Z", endsAt: "2026-08-14T05:00:00.000Z" }),
      event({ externalEventId: "shifted-2", startsAt: "2026-08-21T05:00:00.000Z", endsAt: "2026-08-21T06:00:00.000Z" })
    ];
    const { series, ungrouped } = groupCalendarSeries(events, "Australia/Sydney");
    expect(series).toHaveLength(0);
    expect(ungrouped).toHaveLength(2);
  });

  it("leaves non-recurring events ungrouped and handles multiple series independently", () => {
    const weekly = [
      event({
        externalEventId: "weekly-1",
        seriesId: "weekly-series",
        title: "Cooking class",
        startsAt: "2026-08-13T23:00:00.000Z",
        endsAt: "2026-08-14T00:00:00.000Z"
      }),
      event({
        externalEventId: "weekly-2",
        seriesId: "weekly-series",
        title: "Cooking class",
        startsAt: "2026-08-20T23:00:00.000Z",
        endsAt: "2026-08-21T00:00:00.000Z"
      })
    ];
    const oneOff = event({
      externalEventId: "one-off",
      recurring: false,
      seriesId: null,
      title: "Dentist",
      startsAt: "2026-08-15T01:00:00.000Z",
      endsAt: "2026-08-15T02:00:00.000Z"
    });
    const { series, ungrouped } = groupCalendarSeries([...weekly, oneOff], "Australia/Sydney");
    expect(series).toHaveLength(1);
    expect(series[0]?.title).toBe("Cooking class");
    expect(series[0]?.intervalDays).toBe(7);
    expect(ungrouped).toEqual([oneOff]);
  });

  const at = (id: string, date: string): CalendarSeriesEvent =>
    event({ externalEventId: id, seriesId: "wk", startsAt: `${date}T04:00:00.000Z`, endsAt: `${date}T05:00:00.000Z` });

  it("groups a Tuesday and Thursday series as one weekly weekday-set rule", () => {
    const events = ["2026-08-04", "2026-08-06", "2026-08-11", "2026-08-13", "2026-08-18"].map((date, index) =>
      at(`e${index}`, date)
    );
    const { series, ungrouped } = groupCalendarSeries(events, "Australia/Sydney");
    expect(ungrouped).toHaveLength(0);
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      startDate: "2026-08-04",
      intervalDays: null,
      repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [2, 4] }
    });
  });

  it("groups a fortnightly Monday and Wednesday series as an every-2-weeks rule", () => {
    const events = ["2026-08-03", "2026-08-05", "2026-08-17", "2026-08-19", "2026-08-31"].map((date, index) =>
      at(`f${index}`, date)
    );
    const { series } = groupCalendarSeries(events, "Australia/Sydney");
    expect(series[0]?.repeat).toEqual({ unit: "weeks", intervalWeeks: 2, weekdays: [1, 3] });
  });

  it("still falls back to one-offs when a weekday set has a skipped week", () => {
    const events = ["2026-08-04", "2026-08-06", "2026-08-11", "2026-08-20"].map((date, index) => at(`g${index}`, date));
    const { series, ungrouped } = groupCalendarSeries(events, "Australia/Sydney");
    expect(series).toHaveLength(0);
    expect(ungrouped).toHaveLength(4);
  });
});
