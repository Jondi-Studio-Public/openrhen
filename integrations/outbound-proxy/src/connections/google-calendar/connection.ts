import {
  calendarReadEventsRequestSchema,
  calendarReadEventsResponseSchema,
  connectionManifest,
  googleCalendarListResponseSchema,
  googleCalendarProofResultSchema,
  type CalendarEvent,
  type GoogleCalendarEvent
} from "@openrhen/contracts";
import type { BoundConnection, OpResult } from "../../host/connection-api.js";
import {
  GoogleCalendarClientError,
  googleCalendarConfigFromEnv,
  listGoogleCalendars,
  readGoogleCalendarEvents,
  runGoogleCalendarProof
} from "./google-calendar-client.js";

/** Google's events map 1:1 onto `CalendarEvent`; a recurring instance is one carrying a series id. */
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

function notConfigured(missing: string[]): OpResult {
  return {
    status: 400,
    body: { error: `Google Calendar is not configured: ${missing.join(", ")}.`, reason: "not_configured", missing }
  };
}

function failure(error: unknown, fallback: string): OpResult {
  if (error instanceof GoogleCalendarClientError)
    return { status: 502, body: { error: error.message, reason: error.reason } };
  return { status: 502, body: { error: fallback, reason: "upstream_error" } };
}

function manifest() {
  const found = connectionManifest("google_calendar");
  if (!found) throw new Error("The google_calendar manifest is missing from the registry.");
  return found;
}

export const googleCalendarConnection: BoundConnection = {
  manifest: manifest(),
  create: () => ({
    calendar_source: {
      proof: {
        kind: "json",
        async run(call) {
          const result = googleCalendarProofResultSchema.parse(await runGoogleCalendarProof(call.env, call.fetch));
          return { status: result.status === "failed" ? 502 : 200, body: result };
        }
      },
      list_calendars: {
        kind: "json",
        async run(call) {
          const resolved = googleCalendarConfigFromEnv(call.env);
          if (!resolved.config) return notConfigured(resolved.missing);
          try {
            const calendars = await listGoogleCalendars(resolved.config, call.fetch);
            return { status: 200, body: googleCalendarListResponseSchema.parse({ calendars }) };
          } catch (error) {
            // A timeout or a gone client aborted the call: the host answers that (504 or nothing), not a Google failure.
            if (call.signal.aborted) throw error;
            return failure(error, "The Google Calendar list failed.");
          }
        }
      },
      read_events: {
        kind: "json",
        async run(call) {
          const parsed = calendarReadEventsRequestSchema.safeParse(call.body);
          if (!parsed.success || !parsed.data.calendarIds?.length)
            return { status: 400, body: { error: "The Google Calendar events request failed validation." } };
          const resolved = googleCalendarConfigFromEnv(call.env);
          if (!resolved.config) return notConfigured(resolved.missing);
          try {
            const events = await readGoogleCalendarEvents(
              resolved.config,
              parsed.data.calendarIds,
              parsed.data.timeMin,
              parsed.data.timeMax,
              call.fetch
            );
            return {
              status: 200,
              body: calendarReadEventsResponseSchema.parse({
                events: events.map(toCalendarEvent),
                scope: { frameId: null, timezone: null },
                extras: {}
              })
            };
          } catch (error) {
            // A timeout or a gone client aborted the call: the host answers that (504 or nothing), not a Google failure.
            if (call.signal.aborted) throw error;
            return failure(error, "The Google Calendar events fetch failed.");
          }
        }
      }
    }
  })
};
