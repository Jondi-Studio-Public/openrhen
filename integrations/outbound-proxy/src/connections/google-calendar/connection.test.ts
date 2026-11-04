import { calendarEventSchema, calendarReadEventsResponseSchema } from "@openrhen/contracts";
import { describe, expect, it, vi } from "vitest";
import type { OpCall } from "../../host/connection-api.js";
import { googleCalendarConnection, toCalendarEvent } from "./connection.js";
import { clearGoogleCalendarTokenCacheForTests } from "./google-calendar-client.js";

const googleEvent = {
  externalEventId: "e1",
  calendarId: "jon@example.com",
  title: "Dentist",
  description: null,
  startsAt: "2026-10-10T09:00:00.000+10:00",
  endsAt: "2026-10-10T10:00:00.000+10:00",
  allDay: false,
  timezone: "Australia/Sydney",
  location: null,
  status: "confirmed" as const,
  seriesId: null,
  updatedAt: "2026-10-01T00:00:00.000Z"
};

const credentials = {
  GOOGLE_CALENDAR_CLIENT_ID: "id",
  GOOGLE_CALENDAR_CLIENT_SECRET: "secret",
  GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh"
};

function call(body: unknown, env: Record<string, string | undefined>, fetcher: typeof fetch): OpCall {
  return { body, env, fetch: fetcher, signal: new AbortController().signal, pathname: "/test" };
}

const window = {
  timeMin: "2026-10-01T00:00:00Z",
  timeMax: "2026-11-01T00:00:00Z",
  dateStart: "2026-10-01",
  dateEnd: "2026-11-01",
  calendarIds: ["jon@example.com"]
};

function googleApi(items: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes("oauth2.googleapis.com")
      ? new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }))
      : new Response(JSON.stringify({ timeZone: "Australia/Sydney", items }))
  ) as unknown as typeof fetch;
}

describe("google_calendar connection", () => {
  it("maps a Google event 1:1, marking a series instance recurring", () => {
    const one = toCalendarEvent(googleEvent);
    expect(calendarEventSchema.parse(one)).toEqual(one);
    expect(one).toMatchObject({ recurring: false, profileLabel: null, attributes: {}, title: "Dentist" });
    expect(toCalendarEvent({ ...googleEvent, seriesId: "s1" })).toMatchObject({ recurring: true, seriesId: "s1" });
  });

  it("reads events as CalendarEvent with no frame", async () => {
    clearGoogleCalendarTokenCacheForTests();
    const op = googleCalendarConnection.create({}).calendar_source!.read_events!;
    const result = await op.run(
      call(
        window,
        credentials,
        googleApi([
          {
            id: "e1",
            summary: "Dentist",
            status: "confirmed",
            start: { dateTime: "2026-10-10T09:00:00+10:00" },
            end: { dateTime: "2026-10-10T10:00:00+10:00" },
            recurringEventId: "series",
            updated: "2026-10-01T00:00:00Z"
          }
        ])
      )
    );
    if (result instanceof Response) throw new Error("expected JSON");
    expect(result.status).toBe(200);
    const parsed = calendarReadEventsResponseSchema.parse(result.body);
    expect(parsed.scope).toEqual({ frameId: null, timezone: null });
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({ externalEventId: "e1", recurring: true, seriesId: "series" });
  });

  it("refuses an events request without calendars, and answers not_configured without credentials", async () => {
    const op = googleCalendarConnection.create({}).calendar_source!.read_events!;
    const never = vi.fn() as unknown as typeof fetch;
    expect(await op.run(call({ ...window, calendarIds: [] }, credentials, never))).toEqual({
      status: 400,
      body: { error: "The Google Calendar events request failed validation." }
    });
    expect(await op.run(call(window, {}, never))).toMatchObject({
      status: 400,
      body: { reason: "not_configured", missing: expect.arrayContaining(["GOOGLE_CALENDAR_REFRESH_TOKEN"]) }
    });
    expect(never).not.toHaveBeenCalled();
  });

  it("keeps the legacy status and shape for proof, calendars and failures", async () => {
    const ops = googleCalendarConnection.create({}).calendar_source!;
    const never = vi.fn() as unknown as typeof fetch;
    expect(await ops.proof!.run(call({}, {}, never))).toMatchObject({
      status: 200,
      body: { status: "not_configured" }
    });
    expect(await ops.list_calendars!.run(call({}, {}, never))).toMatchObject({
      status: 400,
      body: { reason: "not_configured" }
    });
    clearGoogleCalendarTokenCacheForTests();
    const rejected = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    expect(await ops.list_calendars!.run(call({}, credentials, rejected as unknown as typeof fetch))).toMatchObject({
      status: 502,
      body: { reason: "invalid_grant" }
    });
  });

  it("rethrows once the call was aborted, so the host answers", async () => {
    const controller = new AbortController();
    const op = googleCalendarConnection.create({}).calendar_source!.list_calendars!;
    const fetcher = (async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    await expect(
      op.run({ body: {}, env: credentials, fetch: fetcher, signal: controller.signal, pathname: "/test" })
    ).rejects.toThrow();
  });
});
