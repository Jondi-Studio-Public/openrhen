import { calendarEventSchema, type CalendarEvent } from "@openrhen/contracts";
import { calendarFeedSeriesSchema, type CalendarFeedSeries } from "@openrhen/contracts/integrations/calendar-feed";
import { prepareFeedRead } from "./calendar-profiles/calendar-feed";

// Shared by the calendar feed's integration suites: events as the proxy returns them, and a feed answer around them.

export const FEED_WINDOW = { timeMin: "2026-11-04T00:00:00.000Z", timeMax: "2027-02-02T00:00:00.000Z" } as const;
export const FEED_TIMEZONE = "Australia/Sydney";

export function feedEvent(id: string, over: Partial<CalendarEvent> = {}): CalendarEvent {
  return calendarEventSchema.parse({
    externalEventId: id,
    calendarId: null,
    title: `Event ${id}`,
    description: null,
    startsAt: "2026-11-10T01:00:00.000Z",
    endsAt: "2026-11-10T02:00:00.000Z",
    allDay: false,
    timezone: null,
    location: null,
    status: "confirmed",
    seriesId: null,
    recurring: false,
    updatedAt: null,
    ...over
  });
}

export function feedExtras(over: Record<string, unknown> = {}) {
  return {
    host: "calendar.example.com",
    transportComplete: true,
    veventCount: 1,
    skipped: [],
    veventCapHit: false,
    occurrenceCapHit: false,
    timeBudgetHit: false,
    ...over
  };
}

export function preparedFeed(events: CalendarEvent[], extras: Record<string, unknown> = {}) {
  return prepareFeedRead({ events, extras: feedExtras(extras) });
}

/**
 * A valid rule descriptor as the proxy puts it on the first event of a UID: a weekly Tuesday entry from 9:00 to 10:00
 * in the feed zone, starting on a Tuesday (2026-11-10) and running on. `over` replaces any field.
 */
export function feedSeries(stem: string, over: Partial<CalendarFeedSeries> = {}): CalendarFeedSeries {
  return calendarFeedSeriesSchema.parse({
    uid: stem,
    idPrefix: stem,
    timezone: FEED_TIMEZONE,
    status: "confirmed",
    title: `Series ${stem}`,
    location: "",
    startDate: "2026-11-10",
    endDate: null,
    repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [2] },
    localStartTime: "09:00",
    localEndTime: "10:00",
    exceptions: [],
    ...over
  });
}

/** The first two instances of `feedSeries`, the first carrying the descriptor, as the proxy emits them in the window. */
export function feedSeriesEvents(stem: string, series: CalendarFeedSeries = feedSeries(stem)): CalendarEvent[] {
  return [
    feedEvent(`${stem}#20261110`, {
      title: series.title,
      recurring: true,
      seriesId: stem,
      startsAt: "2026-11-09T22:00:00.000Z",
      endsAt: "2026-11-09T23:00:00.000Z",
      attributes: { series }
    }),
    feedEvent(`${stem}#20261117`, {
      title: series.title,
      recurring: true,
      seriesId: stem,
      startsAt: "2026-11-16T22:00:00.000Z",
      endsAt: "2026-11-16T23:00:00.000Z"
    })
  ];
}
