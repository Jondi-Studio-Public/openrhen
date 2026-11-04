import { beforeEach, describe, expect, it, vi } from "vitest";

const readCalendarEvents = vi.fn();
vi.mock("@/integrations/calendar-source-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/calendar-source-client")>()),
  readCalendarEvents
}));

const { calendarFeedAdapter } = await import("./calendar-feed-adapter");
const { CalendarSourceError } = await import("@/integrations/calendar-source-client");
const { ConnectionHostNotConfiguredError } = await import("@/integrations/connection-host-client");

const SECRET_URL = "https://calendar.example.com/private/SECRETPATH123.ics";
const args = {
  timeMin: "2026-11-04T00:00:00.000Z",
  timeMax: "2027-02-02T00:00:00.000Z",
  timezone: "Australia/Sydney",
  env: {}
};
const answer = (events: unknown[], extras: Record<string, unknown> = {}) => ({
  events,
  scope: { frameId: null, timezone: "Australia/Sydney" },
  extras: {
    host: "calendar.example.com",
    transportComplete: true,
    veventCount: events.length,
    skipped: [],
    veventCapHit: false,
    occurrenceCapHit: false,
    timeBudgetHit: false,
    ...extras
  }
});
const feedEvent = (id: string, over: Record<string, unknown> = {}) => ({
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
  profileLabel: null,
  attributes: {},
  ...over
});

beforeEach(() => vi.clearAllMocks());

describe("the calendar feed adapter", () => {
  it("is the feed's own provider and source type", () => {
    expect(calendarFeedAdapter).toMatchObject({
      provider: "calendar_feed",
      sourceType: "calendar_feed",
      ownSourceType: "calendar_feed_event"
    });
    // The series pass holds its own records (build plan PR 8); a per-instance record names no series and is never held.
    expect(calendarFeedAdapter.holds).toBeTypeOf("function");
    const perInstance = { relationships: { remoteCancelled: "true" } } as never;
    expect(calendarFeedAdapter.holds!(perInstance)).toBe(false);
  });

  it("names the window's days in the owner's zone, not as UTC slices of the instants", async () => {
    readCalendarEvents.mockResolvedValue(answer([]));
    await calendarFeedAdapter.read({
      ...args,
      timeMin: "2026-11-04T20:00:00.000Z",
      timeMax: "2027-02-02T20:00:00.000Z",
      timezone: "Pacific/Auckland"
    });
    expect(readCalendarEvents.mock.calls[0]![1]).toMatchObject({ dateStart: "2026-11-05", dateEnd: "2027-02-03" });
  });

  it("asks the generic client for the window with the owner's timezone and diffs through the store", async () => {
    readCalendarEvents.mockResolvedValue(
      answer([feedEvent("a"), feedEvent("s#20261110", { attributes: { series: {} } })])
    );
    const read = await calendarFeedAdapter.read(args);
    expect(readCalendarEvents).toHaveBeenCalledWith(
      "calendar_feed",
      {
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        dateStart: "2026-11-04",
        dateEnd: "2027-02-02",
        timezone: "Australia/Sydney"
      },
      { env: {} }
    );
    expect(read.status).toBe("read");
    if (read.status !== "read") return;
    // The count is what the proxy returned; the series event is set aside inside the diff.
    expect(read.eventCount).toBe(2);
    const diffCalendarFeed = vi.fn(async () => ({ records: [], previewFor: vi.fn(), notImported: undefined }));
    await read.diff({ diffCalendarFeed } as never);
    const passed = (
      diffCalendarFeed.mock.calls[0] as unknown as [{ prepared: { events: { externalEventId: string }[] } }]
    )[0];
    expect(passed.prepared.events.map((e) => e.externalEventId)).toEqual(["a"]);
  });

  it("reports an unset URL as not configured, naming the field and not any address", async () => {
    readCalendarEvents.mockRejectedValue(
      new CalendarSourceError("The calendar feed is not configured.", "not_configured", 400)
    );
    expect(await calendarFeedAdapter.read(args)).toEqual({ status: "not_configured", missing: ["CALENDAR_FEED_URL"] });
  });

  it("reports an unset proxy as not configured", async () => {
    readCalendarEvents.mockRejectedValue(new ConnectionHostNotConfiguredError());
    expect(await calendarFeedAdapter.read(args)).toEqual({
      status: "not_configured",
      missing: ["OUTBOUND_PROXY_URL", "OUTBOUND_PROXY_TOKEN"]
    });
  });

  it("keeps the proxy's message and a reason this app knows, and drops one it does not", async () => {
    readCalendarEvents.mockRejectedValue(
      new CalendarSourceError(
        "The calendar feed host refused the request (calendar.example.com, status 404).",
        "upstream_error",
        502
      )
    );
    expect(await calendarFeedAdapter.read(args)).toEqual({
      status: "failed",
      message: "The calendar feed host refused the request (calendar.example.com, status 404).",
      reason: "upstream_error"
    });
    readCalendarEvents.mockRejectedValue(
      new CalendarSourceError("The calendar feed host could not be reached (calendar.example.com).", "unreachable", 502)
    );
    expect(await calendarFeedAdapter.read(args)).toEqual({
      status: "failed",
      message: "The calendar feed host could not be reached (calendar.example.com)."
    });
  });

  it("words an unreadable answer from fixed text, never from the error (canary: nothing carries the URL)", async () => {
    readCalendarEvents.mockRejectedValue(new Error(`Invalid input at ${SECRET_URL}`));
    const failed = await calendarFeedAdapter.read(args);
    expect(failed).toEqual({
      status: "failed",
      message: "The calendar feed answer could not be read.",
      reason: "invalid_response"
    });
    expect(JSON.stringify(failed)).not.toMatch(/SECRET/);
    readCalendarEvents.mockResolvedValue({
      events: [],
      scope: { frameId: null, timezone: null },
      extras: { odd: SECRET_URL }
    });
    const unreadable = await calendarFeedAdapter.read(args);
    expect(unreadable).toMatchObject({ status: "failed", reason: "invalid_response" });
    expect(JSON.stringify(unreadable)).not.toMatch(/SECRET/);
  });
});
