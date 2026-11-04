import { describe, expect, it, vi } from "vitest";
import {
  fetchGoogleCalendarEvents,
  fetchGoogleCalendarProof,
  fetchGoogleCalendars,
  GoogleCalendarProxyError
} from "./google-calendar-proxy-client";

const env = { OUTBOUND_PROXY_URL: "http://proxy.internal:4200/", OUTBOUND_PROXY_TOKEN: "test-token" };

function jsonResponse(body: unknown, status = 200) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  );
}

function neverRespondingFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "TimeoutError"))
        );
      })
  );
}

const calendar = {
  calendarId: "jon@example.com",
  summary: "Jon",
  primary: true,
  accessRole: "owner",
  timezone: "Australia/Sydney"
};
const event = {
  externalEventId: "e1",
  calendarId: "jon@example.com",
  title: "Dentist",
  description: null,
  startsAt: "2026-10-10T09:00:00.000+10:00",
  endsAt: "2026-10-10T10:00:00.000+10:00",
  allDay: false,
  timezone: "Australia/Sydney",
  location: null,
  status: "confirmed",
  seriesId: null,
  updatedAt: "2026-10-01T00:00:00.000Z"
};

describe("Google Calendar proxy client", () => {
  it("returns not_configured without calling the sidecar when the proxy env is missing", async () => {
    const fetcher = vi.fn();
    await expect(fetchGoogleCalendarProof({}, fetcher)).resolves.toMatchObject({ status: "not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("asks the sidecar's capability path for the proof with the bearer token", async () => {
    const fetcher = jsonResponse({ status: "connected", checkedAt: "2026-10-01T00:00:00.000Z", calendarCount: 3 });
    await expect(fetchGoogleCalendarProof(env, fetcher as unknown as typeof fetch)).resolves.toMatchObject({
      status: "connected",
      calendarCount: 3
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://proxy.internal:4200/capabilities/calendar_source/google_calendar/proof");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer test-token");
  });

  it("turns a stalled sidecar into a normal failed proof result, not a hang", async () => {
    const result = await fetchGoogleCalendarProof(
      { ...env, OUTBOUND_REQUEST_TIMEOUT_MS: "20" },
      neverRespondingFetch() as unknown as typeof fetch
    );
    expect(result).toMatchObject({ status: "failed", reason: "network_error" });
  });

  it("lists calendars", async () => {
    const fetcher = jsonResponse({ calendars: [calendar] });
    await expect(fetchGoogleCalendars(env, fetcher as unknown as typeof fetch)).resolves.toEqual([calendar]);
    expect(fetcher.mock.calls[0]![0]).toBe(
      "http://proxy.internal:4200/capabilities/calendar_source/google_calendar/list_calendars"
    );
  });

  it("posts the calendar ids and window to the read_events capability and parses the events", async () => {
    const fetcher = jsonResponse({ events: [event], scope: { frameId: null, timezone: null } });
    const events = await fetchGoogleCalendarEvents(
      ["jon@example.com"],
      "2026-10-01T00:00:00.000Z",
      "2026-12-30T00:00:00.000Z",
      env,
      fetcher as unknown as typeof fetch
    );
    expect(events).toHaveLength(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://proxy.internal:4200/capabilities/calendar_source/google_calendar/read_events");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      calendarIds: ["jon@example.com"],
      timeMin: "2026-10-01T00:00:00.000Z",
      timeMax: "2026-12-30T00:00:00.000Z",
      dateStart: "2026-10-01",
      dateEnd: "2026-12-30"
    });
  });

  it("keeps the reason off a failed sidecar answer", async () => {
    const fetcher = jsonResponse({ error: "Google rejected the refresh token.", reason: "invalid_grant" }, 502);
    await expect(
      fetchGoogleCalendarEvents(
        ["a"],
        "2026-10-01T00:00:00.000Z",
        "2026-12-30T00:00:00.000Z",
        env,
        fetcher as unknown as typeof fetch
      )
    ).rejects.toMatchObject({ message: "Google rejected the refresh token.", reason: "invalid_grant" });
  });

  it("drops a reason it does not recognise rather than passing it on", async () => {
    const fetcher = jsonResponse({ error: "odd", reason: "something_new" }, 502);
    const error = await fetchGoogleCalendars(env, fetcher as unknown as typeof fetch).catch((caught) => caught);
    expect(error).toBeInstanceOf(GoogleCalendarProxyError);
    expect(error.reason).toBeUndefined();
  });

  it("throws a not_configured error without calling the sidecar", async () => {
    const fetcher = vi.fn();
    await expect(fetchGoogleCalendarEvents(["a"], "x", "y", {}, fetcher)).rejects.toMatchObject({
      reason: "not_configured"
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds the events call with an abort signal that fires when the sidecar never answers", async () => {
    await expect(
      fetchGoogleCalendarEvents(
        ["a"],
        "2026-10-01T00:00:00.000Z",
        "2026-12-30T00:00:00.000Z",
        { ...env, OUTBOUND_REQUEST_TIMEOUT_MS: "20" },
        neverRespondingFetch() as unknown as typeof fetch
      )
    ).rejects.toThrow();
  });
});
