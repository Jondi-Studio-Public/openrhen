import { describe, expect, it } from "vitest";
import { googleCalendarEventSchema } from "../integrations/google-calendar.js";
import {
  calendarEventSchema,
  calendarReadEventsRequestSchema,
  calendarReadEventsResponseSchema,
  calendarSinkCreateRequestSchema
} from "./events.js";

const googleEvent = googleCalendarEventSchema.parse({
  externalEventId: "abc_20261101T000000Z",
  calendarId: "primary",
  title: "Dentist",
  description: null,
  startsAt: "2026-11-01T09:00:00+11:00",
  endsAt: "2026-11-01T10:00:00+11:00",
  allDay: false,
  timezone: "Etc/UTC",
  location: null,
  status: "confirmed",
  seriesId: "abc",
  updatedAt: "2026-10-20T01:00:00Z"
});

describe("calendar events", () => {
  it("parses a Google event 1:1", () => {
    const parsed = calendarEventSchema.parse(googleEvent);
    expect(parsed).toMatchObject({ ...googleEvent, recurring: false, profileLabel: null, attributes: {} });
  });

  it("parses a shared-calendar-shaped event with null calendar fields", () => {
    const parsed = calendarEventSchema.safeParse({
      ...googleEvent,
      calendarId: null,
      timezone: null,
      updatedAt: null,
      allDay: false,
      recurring: true,
      profileLabel: "Mum"
    });
    expect(parsed.success).toBe(true);
  });

  it("round-trips the request and response", () => {
    expect(
      calendarReadEventsRequestSchema.safeParse({
        timeMin: "2026-11-01T00:00:00+11:00",
        timeMax: "2026-12-01T00:00:00+11:00",
        dateStart: "2026-11-01",
        dateEnd: "2026-12-01"
      }).success
    ).toBe(true);
    const response = calendarReadEventsResponseSchema.parse({
      events: [googleEvent],
      scope: { frameId: null, timezone: "Etc/UTC" }
    });
    expect(response.extras).toEqual({});
  });

  it("takes an optional owner timezone on the request and rejects an empty or oversized one", () => {
    const window = {
      timeMin: "2026-11-01T00:00:00+11:00",
      timeMax: "2026-12-01T00:00:00+11:00",
      dateStart: "2026-11-01",
      dateEnd: "2026-12-01"
    };
    expect(calendarReadEventsRequestSchema.parse({ ...window, timezone: "Australia/Sydney" }).timezone).toBe(
      "Australia/Sydney"
    );
    expect(calendarReadEventsRequestSchema.parse(window).timezone).toBeUndefined();
    expect(calendarReadEventsRequestSchema.safeParse({ ...window, timezone: "" }).success).toBe(false);
    expect(calendarReadEventsRequestSchema.safeParse({ ...window, timezone: "x".repeat(101) }).success).toBe(false);
  });

  it("exposes the neutral sink write schema", () => {
    expect(calendarSinkCreateRequestSchema).toBeDefined();
  });
});

describe("calendar event negatives", () => {
  it("rejects an empty title, a bad datetime and an unknown status", () => {
    expect(calendarEventSchema.safeParse({ ...googleEvent, title: "" }).success).toBe(false);
    expect(calendarEventSchema.safeParse({ ...googleEvent, startsAt: "tomorrow" }).success).toBe(false);
    expect(calendarEventSchema.safeParse({ ...googleEvent, status: "maybe" }).success).toBe(false);
    expect(
      calendarReadEventsRequestSchema.safeParse({ timeMin: "x", timeMax: "y", dateStart: "", dateEnd: "" }).success
    ).toBe(false);
  });
});
