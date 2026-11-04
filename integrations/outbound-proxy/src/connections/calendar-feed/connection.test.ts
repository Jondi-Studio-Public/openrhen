import { inspect } from "node:util";
import {
  calendarEventSchema,
  calendarReadEventsResponseSchema,
  capabilityFailureSchema,
  connectionRegistry
} from "@openrhen/contracts";
import {
  calendarFeedExtrasSchema,
  calendarFeedProofResultSchema,
  calendarFeedSeriesSchema
} from "@openrhen/contracts/integrations/calendar-feed";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpCall } from "../../host/connection-api.js";
import { PLACEHOLDER_CREDENTIAL } from "../../host/http.js";

const fetchCalendarFeed = vi.hoisted(() => vi.fn());
const proveCalendarFeed = vi.hoisted(() => vi.fn());

vi.mock("./fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fetch.js")>()),
  fetchCalendarFeed
}));
vi.mock("./proof.js", () => ({ proveCalendarFeed }));
// The worker thread is covered by run-worker.test.ts; here the real parser runs in-process.
vi.mock("./run-worker.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./run-worker.js")>();
  const { parseFeed } = await import("./parse.js");
  return {
    ...original,
    parseFeedInWorker: vi.fn(async (request: Parameters<typeof parseFeed>[0]) => parseFeed(request))
  };
});

const { calendarFeedConnection, toCalendarEvent } = await import("./connection.js");
const { FeedFetchError } = await import("./fetch.js");
const { FeedParseError, parseFeedInWorker } = await import("./run-worker.js");

const SECRET_URL = "https://calendar.example.com/private/SECRETPATH123/feed.ics?token=SECRETTOKEN456";
const env = { CALENDAR_FEED_URL: SECRET_URL };
const WINDOW = {
  timeMin: "2026-11-01T00:00:00.000Z",
  timeMax: "2026-12-01T00:00:00.000Z",
  dateStart: "2026-11-01",
  dateEnd: "2026-12-01"
};

function call(body: unknown, e: Record<string, string | undefined>, signal = new AbortController().signal): OpCall {
  return { body, env: e, fetch: vi.fn() as unknown as typeof fetch, signal, pathname: "/test" };
}
const ops = () => calendarFeedConnection.create({}).calendar_source!;
async function run(op: "proof" | "read_events", body: unknown, e: Record<string, string | undefined>) {
  const result = await ops()[op]!.run(call(body, e));
  if (result instanceof Response) throw new Error("expected JSON");
  return result;
}

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:one@example.com",
  "DTSTAMP:20261101T000000Z",
  "DTSTART:20261110T230000Z",
  "DTEND:20261111T003000Z",
  "SUMMARY:Dentist",
  "LOCATION:Surgery",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:weekly@example.com",
  "DTSTAMP:20261101T000000Z",
  "DTSTART;TZID=Australia/Sydney:20261102T090000",
  "DTEND;TZID=Australia/Sydney:20261102T100000",
  "RRULE:FREQ=WEEKLY;COUNT=3",
  "SUMMARY:Standup",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:allday@example.com",
  "DTSTAMP:20261101T000000Z",
  "DTSTART;VALUE=DATE:20261120",
  "DTEND;VALUE=DATE:20261121",
  "SUMMARY:Holiday",
  "END:VEVENT",
  "END:VCALENDAR",
  ""
].join("\r\n");

beforeEach(() => {
  fetchCalendarFeed.mockReset();
  proveCalendarFeed.mockReset();
  vi.mocked(parseFeedInWorker).mockClear();
});

describe("calendar feed manifest binding", () => {
  it("binds the registered manifest, whose one secret is the URL", () => {
    expect(calendarFeedConnection.manifest).toBe(connectionRegistry().find((m) => m.id === "calendar_feed"));
    expect(calendarFeedConnection.manifest.secrets.anyOf).toEqual([["CALENDAR_FEED_URL"]]);
  });

  it("implements exactly proof and read_events", () => {
    expect(Object.keys(ops()).sort()).toEqual(["proof", "read_events"]);
  });
});

describe("proof", () => {
  it("answers not_configured, without touching the network, when the field is unset, blank or the placeholder", async () => {
    for (const value of [undefined, "", "   ", PLACEHOLDER_CREDENTIAL]) {
      const result = await run("proof", {}, { CALENDAR_FEED_URL: value });
      expect(result.status).toBe(200);
      expect(calendarFeedProofResultSchema.parse(result.body)).toEqual({
        status: "not_configured",
        missing: ["CALENDAR_FEED_URL"]
      });
    }
    expect(proveCalendarFeed).not.toHaveBeenCalled();
    expect(fetchCalendarFeed).not.toHaveBeenCalled();
  });

  it("answers connected with the host only, and downloads nothing", async () => {
    proveCalendarFeed.mockResolvedValue({ host: "calendar.example.com" });
    const result = await run("proof", {}, env);
    expect(result.status).toBe(200);
    expect(calendarFeedProofResultSchema.parse(result.body)).toMatchObject({
      status: "connected",
      host: "calendar.example.com"
    });
    expect(JSON.stringify(result.body)).not.toMatch(/SECRET/);
    expect(proveCalendarFeed).toHaveBeenCalledWith(SECRET_URL, expect.anything());
    expect(fetchCalendarFeed).not.toHaveBeenCalled();
  });

  it("answers failed with a fixed message and the host, never the URL", async () => {
    proveCalendarFeed.mockRejectedValue(new FeedFetchError("denied_address", "calendar.example.com"));
    const result = await run("proof", {}, env);
    expect(result.status).toBe(502);
    const body = calendarFeedProofResultSchema.parse(result.body);
    expect(body).toMatchObject({ status: "failed", reason: "forbidden" });
    expect(JSON.stringify(body)).toContain("calendar.example.com");
    expect(JSON.stringify(body)).not.toMatch(/SECRET/);
  });

  it("does not echo an unexpected error's text, which could carry the URL", async () => {
    proveCalendarFeed.mockRejectedValue(new Error(`socket hang up for ${SECRET_URL}`));
    const result = await run("proof", {}, env);
    expect(result.status).toBe(502);
    expect(calendarFeedProofResultSchema.parse(result.body)).toMatchObject({ status: "failed", reason: "unreachable" });
    expect(JSON.stringify(result.body)).not.toMatch(/SECRET/);
  });

  it("rethrows when the caller aborted, so the host answers rather than this op", async () => {
    const controller = new AbortController();
    proveCalendarFeed.mockImplementation(async () => {
      controller.abort();
      throw new FeedFetchError("aborted");
    });
    await expect(ops().proof!.run(call({}, env, controller.signal))).rejects.toBeInstanceOf(FeedFetchError);
  });
});

describe("read_events", () => {
  it("refuses a malformed request or an unknown timezone before anything is fetched", async () => {
    expect((await run("read_events", {}, env)).status).toBe(400);
    expect((await run("read_events", { ...WINDOW, timezone: "Mars/Olympus" }, env)).status).toBe(400);
    expect((await run("read_events", { ...WINDOW, timezone: "aest" }, env)).status).toBe(400);
    expect(fetchCalendarFeed).not.toHaveBeenCalled();
  });

  it("answers a not_configured failure the portal can parse when the field is unset", async () => {
    const result = await run("read_events", WINDOW, {});
    expect(result.status).toBe(400);
    expect(capabilityFailureSchema.parse(result.body)).toMatchObject({ reason: "not_configured" });
    expect(result.body).toMatchObject({ missing: ["CALENDAR_FEED_URL"] });
    expect(fetchCalendarFeed).not.toHaveBeenCalled();
  });

  it("downloads once and returns generic events with the feed's extras", async () => {
    fetchCalendarFeed.mockResolvedValue({ bytes: Buffer.from(ICS), host: "calendar.example.com", status: 200 });
    const result = await run("read_events", { ...WINDOW, timezone: "Australia/Sydney" }, env);
    expect(result.status).toBe(200);
    expect(fetchCalendarFeed).toHaveBeenCalledTimes(1);
    expect(fetchCalendarFeed).toHaveBeenCalledWith(SECRET_URL, expect.objectContaining({ signal: expect.anything() }));
    const body = calendarReadEventsResponseSchema.parse(result.body);
    expect(body.scope).toEqual({ frameId: null, timezone: "Australia/Sydney" });
    for (const event of body.events) expect(calendarEventSchema.parse(event)).toEqual(event);
    const byId = Object.fromEntries(body.events.map((e) => [e.externalEventId, e]));
    expect(byId["one@example.com"]).toMatchObject({
      title: "Dentist",
      location: "Surgery",
      startsAt: "2026-11-10T23:00:00.000Z",
      allDay: false,
      timezone: null,
      seriesId: null,
      recurring: false,
      calendarId: null,
      status: "confirmed"
    });
    const instances = body.events.filter((e) => e.seriesId === "weekly@example.com");
    expect(instances).toHaveLength(3);
    expect(instances.every((e) => e.recurring && e.externalEventId.startsWith("weekly@example.com#"))).toBe(true);
    expect(instances[0]!.attributes).toMatchObject({ uid: "weekly@example.com", recurrenceDate: "20261102" });
    expect(byId["allday@example.com"]).toMatchObject({ allDay: true, timezone: "Australia/Sydney" });
    expect(byId["allday@example.com"]!.attributes).toMatchObject({ startDate: "2026-11-20", endDate: "2026-11-21" });
    const extras = calendarFeedExtrasSchema.parse(body.extras);
    expect(extras).toMatchObject({
      host: "calendar.example.com",
      transportComplete: true,
      skipped: [],
      veventCount: 3
    });
    expect(JSON.stringify(result.body)).not.toMatch(/SECRET/);
  });

  it("carries the series descriptor in attributes.series on one event, and lists what it could not follow", async () => {
    const lines = ICS.split("\r\n");
    const extra = [
      "BEGIN:VEVENT",
      "UID:floating@example.com",
      "DTSTAMP:20261101T000000Z",
      "DTSTART:20261103T090000",
      "DTEND:20261103T100000",
      "RRULE:FREQ=WEEKLY;COUNT=3",
      "SUMMARY:No zone",
      "END:VEVENT"
    ];
    lines.splice(lines.lastIndexOf("END:VCALENDAR"), 0, ...extra);
    fetchCalendarFeed.mockResolvedValue({
      bytes: Buffer.from(lines.join("\r\n")),
      host: "calendar.example.com",
      status: 200
    });
    const result = await run("read_events", { ...WINDOW, timezone: "Australia/Sydney" }, env);
    const body = calendarReadEventsResponseSchema.parse(result.body);
    const weekly = body.events.filter((e) => e.seriesId === "weekly@example.com");
    expect(weekly).toHaveLength(3);
    const carriers = weekly.filter((e) => "series" in e.attributes);
    expect(carriers).toHaveLength(1);
    expect(calendarFeedSeriesSchema.parse(carriers[0]!.attributes.series)).toMatchObject({
      uid: "weekly@example.com",
      timezone: "Australia/Sydney",
      startDate: "2026-11-02",
      endDate: "2026-11-16",
      repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [1] },
      localStartTime: "09:00",
      localEndTime: "10:00"
    });
    const floating = body.events.filter((e) => e.seriesId === "floating@example.com");
    expect(floating.length).toBeGreaterThan(0);
    expect(floating.some((e) => "series" in e.attributes)).toBe(false);
    const extras = calendarFeedExtrasSchema.parse(body.extras);
    expect(extras.unrepresentableSeries).toEqual([
      { idPrefix: "floating@example.com", reason: "no time zone on the start" }
    ]);
    expect(extras.skipped).toEqual([]);
  });

  it("defaults the zone to UTC when the portal sends none, and passes the window and zone to the parser", async () => {
    fetchCalendarFeed.mockResolvedValue({ bytes: Buffer.from(ICS), host: "calendar.example.com", status: 200 });
    const result = await run("read_events", WINDOW, env);
    expect(calendarReadEventsResponseSchema.parse(result.body).scope.timezone).toBe("UTC");
    expect(parseFeedInWorker).toHaveBeenCalledWith(
      expect.objectContaining({ windowStart: WINDOW.timeMin, windowEnd: WINDOW.timeMax, ownerTimeZone: "UTC" }),
      expect.anything()
    );
  });

  it("reports transportComplete false for a truncated feed, and lists what it skipped", async () => {
    const truncated = ICS.replace("END:VCALENDAR\r\n", "");
    fetchCalendarFeed.mockResolvedValue({ bytes: Buffer.from(truncated), host: "calendar.example.com", status: 200 });
    const noEnd = await run("read_events", WINDOW, env);
    expect(
      calendarFeedExtrasSchema.parse(calendarReadEventsResponseSchema.parse(noEnd.body).extras).transportComplete
    ).toBe(false);

    const bad = ICS.replace("DTEND:20261111T003000Z", "DTEND:20261110T220000Z");
    fetchCalendarFeed.mockResolvedValue({ bytes: Buffer.from(bad), host: "calendar.example.com", status: 200 });
    const skipped = calendarFeedExtrasSchema.parse(
      calendarReadEventsResponseSchema.parse((await run("read_events", WINDOW, env)).body).extras
    );
    expect(skipped.skipped).toEqual([{ idPrefix: "one@example.com", reason: expect.any(String) }]);
  });

  it("maps every fetch failure to a status, a reason the contract allows and a message free of the URL", async () => {
    const codes = [
      "bad_url",
      "denied_address",
      "dns_failed",
      "connect_failed",
      "timeout",
      "network",
      "bad_redirect",
      "too_many_redirects",
      "http_status",
      "too_large",
      "decode_failed",
      "unsupported_encoding"
    ] as const;
    for (const code of codes) {
      fetchCalendarFeed.mockRejectedValue(
        new FeedFetchError(code, "calendar.example.com", code === "http_status" ? 404 : undefined)
      );
      const result = await run("read_events", WINDOW, env);
      expect(result.status, code).toBe(code === "bad_url" ? 400 : 502);
      expect(capabilityFailureSchema.safeParse(result.body).success, code).toBe(true);
      expect(JSON.stringify(result.body), code).not.toMatch(/SECRET/);
    }
    fetchCalendarFeed.mockRejectedValue(new FeedFetchError("http_status", "calendar.example.com", 404));
    expect(JSON.stringify((await run("read_events", WINDOW, env)).body)).toContain("calendar.example.com, status 404");
  });

  it("answers a parse failure or an unexpected error with a fixed message, never the error text", async () => {
    fetchCalendarFeed.mockResolvedValue({ bytes: Buffer.from(ICS), host: "calendar.example.com", status: 200 });
    for (const failure of [
      new FeedParseError("timeout"),
      new FeedParseError("memory"),
      new Error(`boom ${SECRET_URL}`)
    ]) {
      vi.mocked(parseFeedInWorker).mockRejectedValueOnce(failure);
      const result = await run("read_events", WINDOW, env);
      expect(result.status).toBe(502);
      expect(result.body).toMatchObject({ error: "The calendar feed could not be read.", reason: "invalid_response" });
      expect(inspect(result)).not.toMatch(/SECRET/);
    }
  });

  it("rethrows when the caller aborted", async () => {
    const controller = new AbortController();
    fetchCalendarFeed.mockImplementation(async () => {
      controller.abort();
      throw new FeedFetchError("aborted");
    });
    await expect(ops().read_events!.run(call(WINDOW, env, controller.signal))).rejects.toBeInstanceOf(FeedFetchError);
  });
});

describe("toCalendarEvent", () => {
  it("carries nothing but generic fields and the parser's identifiers", () => {
    const event = toCalendarEvent(
      {
        id: "u#20261110",
        uid: "u",
        recurrenceDate: "20261110",
        title: "T",
        location: "",
        description: "",
        startsAt: "2026-11-10T00:00:00.000Z",
        endsAt: "2026-11-10T01:00:00.000Z",
        allDay: false,
        startDate: null,
        endDate: null,
        status: "tentative",
        recurring: true
      },
      "UTC"
    );
    expect(event).toMatchObject({ location: null, description: null, seriesId: "u", status: "tentative" });
    expect(calendarEventSchema.parse(event)).toEqual(event);
  });
});
