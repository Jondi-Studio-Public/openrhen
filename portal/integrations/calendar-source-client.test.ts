import { beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => [] as { provider: string; operation: string }[]);
vi.mock("@/server/telemetry/provider-call-recorder", () => ({
  recordProviderCall: async (
    provider: string,
    operation: string,
    run: () => Promise<unknown>,
    classify?: (result: unknown) => { ok: boolean }
  ) => {
    recorded.push({ provider, operation });
    const result = await run();
    classify?.(result);
    return result;
  }
}));

import {
  CalendarSourceError,
  listSourceCalendars,
  proveCalendarSource,
  readCalendarEvents
} from "./calendar-source-client";
import { ConnectionHostNotConfiguredError } from "./connection-host-client";

const env = { OUTBOUND_PROXY_URL: "http://proxy.internal:4200", OUTBOUND_PROXY_TOKEN: "test-token" };
const window = {
  timeMin: "2026-10-01T00:00:00.000Z",
  timeMax: "2026-11-01T00:00:00.000Z",
  dateStart: "2026-10-01",
  dateEnd: "2026-11-01",
  calendarIds: ["a"]
};

function answer(body: unknown, status = 200) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(body, { status }));
}

beforeEach(() => {
  recorded.length = 0;
});

describe("calendar source client", () => {
  it("reads events through the capability path, recording under the telemetry name and old operation", async () => {
    const fetcher = answer({ events: [], scope: { frameId: null, timezone: null } });
    await expect(
      readCalendarEvents("google_calendar", window, { env, fetcher: fetcher as unknown as typeof fetch })
    ).resolves.toMatchObject({ events: [], scope: { frameId: null } });
    expect(fetcher.mock.calls[0]![0]).toBe(
      "http://proxy.internal:4200/capabilities/calendar_source/google_calendar/read_events"
    );
    expect(recorded).toEqual([{ provider: "google_calendar", operation: "events" }]);
  });

  it("throws a CalendarSourceError carrying the reason, and refuses an unset sidecar before recording", async () => {
    const rejected = answer({ error: "Google rejected the refresh token.", reason: "invalid_grant" }, 502);
    await expect(
      readCalendarEvents("google_calendar", window, { env, fetcher: rejected as unknown as typeof fetch })
    ).rejects.toMatchObject({ message: "Google rejected the refresh token.", reason: "invalid_grant" });
    expect(recorded).toHaveLength(1);
    recorded.length = 0;
    await expect(readCalendarEvents("google_calendar", window, { env: {} })).rejects.toBeInstanceOf(
      ConnectionHostNotConfiguredError
    );
    await expect(listSourceCalendars("google_calendar", { env: {} })).rejects.toBeInstanceOf(
      ConnectionHostNotConfiguredError
    );
    expect(recorded).toEqual([]);
  });

  it("lists calendars", async () => {
    const fetcher = answer({ calendars: [{ calendarId: "a" }] });
    await expect(
      listSourceCalendars("google_calendar", { env, fetcher: fetcher as unknown as typeof fetch })
    ).resolves.toEqual([{ calendarId: "a" }]);
    expect(recorded).toEqual([{ provider: "google_calendar", operation: "calendars" }]);
  });

  it("answers a proof as a result, never a throw, and records only when asked", async () => {
    const connected = answer({ status: "connected", checkedAt: "2026-10-01T00:00:00.000Z", calendarCount: 2 });
    await expect(
      proveCalendarSource("google_calendar", { env, fetcher: connected as unknown as typeof fetch })
    ).resolves.toMatchObject({ status: "connected", calendarCount: 2 });
    expect(recorded).toEqual([{ provider: "google_calendar", operation: "proof" }]);
    recorded.length = 0;
    const down = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(
      proveCalendarSource("google_calendar", { env, fetcher: down as unknown as typeof fetch, record: false })
    ).resolves.toMatchObject({ status: "failed", reason: "network_error", message: "connect ECONNREFUSED" });
    await expect(proveCalendarSource("google_calendar", { env: {} })).resolves.toEqual({
      status: "not_configured",
      missing: ["OUTBOUND_PROXY_URL", "OUTBOUND_PROXY_TOKEN"]
    });
    expect(recorded).toEqual([]);
  });

  it("turns a host failure that is not a proof into a failed proof with the host's message and reason", async () => {
    await expect(
      proveCalendarSource("google_calendar", {
        env,
        fetcher: answer({ error: "upstream_timeout" }, 504) as unknown as typeof fetch,
        record: false
      })
    ).resolves.toMatchObject({ status: "failed", message: "upstream_timeout", reason: "upstream_error" });
    await expect(
      proveCalendarSource("google_calendar", {
        env,
        fetcher: answer({ error: "Not ready.", reason: "not_ready" }, 503) as unknown as typeof fetch,
        record: false
      })
    ).resolves.toMatchObject({ status: "failed", message: "Not ready.", reason: "not_ready" });
  });

  it("rejects an id that is not a calendar source", async () => {
    await expect(readCalendarEvents("openai", window, { env })).rejects.toBeInstanceOf(CalendarSourceError);
    await expect(proveCalendarSource("nope", { env })).rejects.toMatchObject({ reason: "unknown_connection" });
  });
});
