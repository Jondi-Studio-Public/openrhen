import { registerConnectionManifest } from "@openrhen/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A calendar sink, registered here so the client is tested without naming a provider.
registerConnectionManifest({
  id: "example_sink",
  label: "Example Sink",
  capabilities: ["calendar_sink"],
  ops: {},
  secrets: { anyOf: [["EXAMPLE_SINK_TOKEN"]] },
  config: {},
  telemetryName: "example_sink"
});

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
  CalendarSinkError,
  calendarSinkStatus,
  createSinkEvent,
  proveSinkWrite,
  removeSinkEvent,
  updateSinkEvent
} from "./calendar-sink-client";

const env = { OUTBOUND_PROXY_URL: "http://proxy.internal:4200", OUTBOUND_PROXY_TOKEN: "test-token" };
const create = {
  summary: "Test",
  starts_at: "2026-09-10T09:00:00+10:00",
  ends_at: "2026-09-10T10:00:00+10:00",
  all_day: false as const,
  timezone: "Australia/Sydney",
  location: null,
  description: null,
  category_ids: ["1"]
};

function answer(body: unknown, status = 200) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(body, { status }));
}

beforeEach(() => {
  recorded.length = 0;
});

describe("calendar sink client", () => {
  it("writes through the capability path, recording under the telemetry name and the old operations", async () => {
    const fetcher = answer({ data: { id: "7" } });
    const options = { env, fetcher: fetcher as unknown as typeof fetch };
    await expect(createSinkEvent("example_sink", create, options)).resolves.toBe("7");
    await expect(updateSinkEvent("example_sink", "7", { location: "Hall" }, options)).resolves.toBe("7");
    await expect(
      removeSinkEvent("example_sink", "7", { ...options, fetcher: answer({ ok: true }) as never })
    ).resolves.toBeUndefined();
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "http://proxy.internal:4200/capabilities/calendar_sink/example_sink/create",
      "http://proxy.internal:4200/capabilities/calendar_sink/example_sink/update"
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({ location: "Hall", eventId: "7" });
    expect(recorded).toEqual([
      { provider: "example_sink", operation: "calendar_event_create" },
      { provider: "example_sink", operation: "calendar_event_update" },
      { provider: "example_sink", operation: "calendar_event_delete" }
    ]);
  });

  it("throws a CalendarSinkError, relaying the provider's status only when the host attached one", async () => {
    const options = (fetcher: unknown) => ({ env, fetcher: fetcher as typeof fetch });
    await expect(
      createSinkEvent("example_sink", create, options(answer({ error: "Route not found." }, 404)))
    ).rejects.toMatchObject({ message: "Route not found.", upstreamStatus: 404, relayed: false });
    await expect(
      createSinkEvent("example_sink", create, options(answer({ error: "Refused.", status: 422, step: "create" }, 502)))
    ).rejects.toMatchObject({ upstreamStatus: 422, relayed: true });
    await expect(createSinkEvent("example_sink", create, options(answer(null, 500)))).rejects.toBeInstanceOf(
      CalendarSinkError
    );
  });

  it("refuses an unset sidecar before recording, and an id that is not a sink", async () => {
    await expect(createSinkEvent("example_sink", create, { env: {} })).rejects.toThrow(
      "Example Sink is not configured: OUTBOUND_PROXY_URL, OUTBOUND_PROXY_TOKEN."
    );
    await expect(createSinkEvent("google_calendar", create, { env })).rejects.toThrow("not a calendar sink");
    expect(recorded).toEqual([]);
  });

  it("reads the write status without recording", async () => {
    await expect(
      calendarSinkStatus("example_sink", { env, fetcher: answer({ writeEnabled: false, frameId: null }) as never })
    ).resolves.toEqual({ writeEnabled: false, frameId: null });
    expect(recorded).toEqual([]);
  });

  it("proves a write without throwing: a 404 and a dead host are failed results", async () => {
    const off = await proveSinkWrite("example_sink", undefined, "Writes are off.", {
      env,
      fetcher: answer({ error: "Route not found." }, 404) as never
    });
    expect(off).toMatchObject({ status: "failed", message: "Writes are off.", deleted: false, fields: [] });
    const down = await proveSinkWrite("example_sink", "frame-1", "Writes are off.", {
      env,
      fetcher: vi.fn(async () => Promise.reject(new Error("network down"))) as never
    });
    expect(down).toMatchObject({ status: "failed", message: "network down" });
    expect(recorded.map((entry) => entry.operation)).toEqual(["write_proof", "write_proof"]);
    expect(await proveSinkWrite("example_sink", undefined, "x", { env: {} })).toMatchObject({ status: "failed" });
    expect(recorded).toHaveLength(2);
  });
});
