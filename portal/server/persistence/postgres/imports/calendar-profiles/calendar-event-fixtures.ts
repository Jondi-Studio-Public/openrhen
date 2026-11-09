import type { CalendarEvent, GoogleCalendarEvent } from "@openrhen/contracts";

/**
 * Test fixtures: a calendar-source event as the primary calendar connection returns it. This is the same mapping as the
 * proxy's `toCalendarEvent` (`connections/google-calendar/connection.ts`), which the portal cannot import.
 */
export function toCalendarEvent(event: GoogleCalendarEvent): CalendarEvent {
  return {
    externalEventId: event.externalEventId,
    calendarId: event.calendarId,
    title: event.title,
    description: event.description,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    timezone: event.timezone,
    location: event.location,
    status: event.status,
    seriesId: event.seriesId,
    recurring: event.seriesId !== null,
    updatedAt: event.updatedAt,
    profileLabel: null,
    attributes: {}
  };
}
