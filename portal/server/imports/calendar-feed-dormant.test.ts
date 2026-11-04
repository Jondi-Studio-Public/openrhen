import { beforeEach, describe, expect, it, vi } from "vitest";

// The calendar feed is registered (PR 4 of the feed plan) with no schedule and no card: its sync route must never
// reach the connection host unless the provider list names it (PR 6 added its adapter; see the test below).
const state = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
const readCalendarEvents = vi.fn();
const proveCalendarSource = vi.fn();
const withImportStore = vi.fn();
const outbound = vi.fn(async () => {
  throw new Error("the feed must not reach the network");
});

vi.mock("@/integrations/calendar-source-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/calendar-source-client")>()),
  readCalendarEvents,
  proveCalendarSource
}));
vi.mock("@/integrations/google-calendar/google-calendar-proxy-client", () => ({
  fetchGoogleCalendarEvents: vi.fn(),
  fetchGoogleCalendarProof: vi.fn(),
  fetchGoogleCalendars: vi.fn()
}));
vi.mock("@/server/persistence/postgres/import-store", () => ({ withImportStore }));
vi.mock("@/server/persistence/postgres/calendar-source-selections", () => ({
  listSelectedGoogleCalendars: vi.fn(async () => []),
  listGoogleCalendarSelections: vi.fn(async () => []),
  saveGoogleCalendarSelections: vi.fn()
}));
vi.mock("@/server/events/state-events", () => ({ ensureCalendarPublishSubscribed: () => undefined }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({
  sqlPool: () =>
    Object.assign(async () => [{ timezone: "Australia/Sydney" }], {
      json: (value: unknown) => value,
      reserve: async () =>
        Object.assign(
          async (strings: TemplateStringsArray) => (strings.join("?").includes("pg_try") ? [{ locked: true }] : []),
          {
            release: () => undefined
          }
        )
    })
}));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test", runtimeEnv: () => state.env }));

const { CalendarSourceError } = await import("@/integrations/calendar-source-client");
const { syncPostHandler, proofGetHandler } = await import("@/server/connections/route-handlers");
const { connectionExtensions } = await import("@/features/connections/connection-extensions");
const { intervalCalendarSourceIds } = await import("@openrhen/contracts");

const log = { setError: vi.fn() } as never;
const post = () =>
  new Request("http://portal.test/api/connections/calendar_feed/sync", {
    method: "POST",
    body: JSON.stringify({ trigger: "manual" })
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", outbound);
  state.env = {};
});

describe("the dormant calendar feed", () => {
  it("is a registered interval source that the portal knows, with no Connections extension or card", () => {
    expect(intervalCalendarSourceIds()).toContain("calendar_feed");
    expect(connectionExtensions().map((extension) => extension.id)).not.toContain("calendar_feed");
  });

  it("answers not_enabled to a manual sync and reads nothing, even with the URL field set", async () => {
    state.env = { CALENDAR_FEED_URL: "https://calendar.example.com/private/SECRETPATH123.ics" };
    const response = await syncPostHandler("calendar_feed", post(), {}, log);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: "not_enabled", provider: "calendar_feed" });
    expect(JSON.stringify(body)).not.toMatch(/SECRET/);
    expect(readCalendarEvents).not.toHaveBeenCalled();
    expect(proveCalendarSource).not.toHaveBeenCalled();
    expect(withImportStore).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it("answers not_enabled while the list names only other providers", async () => {
    state.env = { CALENDAR_SYNC_PROVIDERS: "google_calendar,example_shared" };
    expect(await (await syncPostHandler("calendar_feed", post(), {}, log)).json()).toMatchObject({
      status: "not_enabled"
    });
    expect(readCalendarEvents).not.toHaveBeenCalled();
  });

  // PR 6 of the feed plan gives the feed an adapter (core, registered against the `fixed_blocks` profile). It changes
  // exactly this expectation and no other: the feed still reads only when the provider list names it, and it is not in
  // the default list, so nothing schedules it and the manual route above stays `not_enabled`.
  it("has an adapter now, but only a provider list that names it reaches the proxy, and then only through the generic client", async () => {
    state.env = { CALENDAR_SYNC_PROVIDERS: "calendar_feed" };
    readCalendarEvents.mockRejectedValue(
      new CalendarSourceError("The calendar feed is not configured.", "not_configured", 400)
    );
    const response = await syncPostHandler("calendar_feed", post(), {}, log);
    expect(await response.json()).toEqual({ status: "not_configured", missing: ["CALENDAR_FEED_URL"] });
    expect(readCalendarEvents).toHaveBeenCalledTimes(1);
    expect(readCalendarEvents.mock.calls[0]![0]).toBe("calendar_feed");
    expect(proveCalendarSource).not.toHaveBeenCalled();
    expect(withImportStore).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it("proves through the generic calendar-source proof, which is the passive DNS and TLS check", async () => {
    proveCalendarSource.mockResolvedValue({ status: "not_configured", missing: ["CALENDAR_FEED_URL"] });
    const response = await proofGetHandler("calendar_feed", new Request("http://portal.test/x"), {}, log);
    expect(await response.json()).toEqual({ status: "not_configured", missing: ["CALENDAR_FEED_URL"] });
    expect(proveCalendarSource).toHaveBeenCalledWith("calendar_feed");
    expect(readCalendarEvents).not.toHaveBeenCalled();
  });
});
