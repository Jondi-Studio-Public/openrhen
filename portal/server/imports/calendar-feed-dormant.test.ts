import { beforeEach, describe, expect, it, vi } from "vitest";

// The calendar feed is registered (PR 4 of the feed plan) but has no adapter, no schedule and no card: its sync route
// must never reach the connection host, whether or not the provider list names it.
const state = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
const readCalendarEvents = vi.fn();
const proveCalendarSource = vi.fn();
const withImportStore = vi.fn();
const outbound = vi.fn(async () => {
  throw new Error("the feed must not reach the network");
});

vi.mock("@/integrations/calendar-source-client", () => ({ readCalendarEvents, proveCalendarSource }));
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

  it("has no adapter, so even a provider list that names it fails without reading anything", async () => {
    state.env = { CALENDAR_SYNC_PROVIDERS: "calendar_feed" };
    const response = await syncPostHandler("calendar_feed", post(), {}, log);
    expect(await response.json()).toMatchObject({
      status: "failed",
      provider: "calendar_feed",
      message: expect.stringContaining("not available")
    });
    expect(readCalendarEvents).not.toHaveBeenCalled();
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
