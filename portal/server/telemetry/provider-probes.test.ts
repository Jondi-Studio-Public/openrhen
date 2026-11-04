import "@/test/example-calendar-sources";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeCalendarSource, probeOpenAI } from "./provider-probes";

/**
 * Both probes already turn a network failure into a normal `{ ok: false, detail }` result rather than
 * throwing — see the comment in provider-probes.ts. What's new is that a stalled sidecar now resolves
 * that way too, inside `OUTBOUND_REQUEST_TIMEOUT_MS`, instead of hanging the probe forever.
 */
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.stubEnv("OUTBOUND_PROXY_URL", "http://proxy.internal:4200");
  vi.stubEnv("OUTBOUND_PROXY_TOKEN", "test-token");
  vi.stubEnv("OUTBOUND_REQUEST_TIMEOUT_MS", "20");
});

function stubNeverRespondingFetch() {
  globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "TimeoutError"))
      );
    });
  }) as typeof fetch;
}

describe("provider reachability probes", () => {
  it("answers notConfigured, without any request, for every sidecar probe when the sidecar is not set up", async () => {
    vi.stubEnv("OUTBOUND_PROXY_URL", "");
    vi.stubEnv("OUTBOUND_PROXY_TOKEN", "");
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    for (const probe of [
      probeOpenAI,
      () => probeCalendarSource("example_shared"),
      () => probeCalendarSource("example_daily"),
      () => probeCalendarSource("google_calendar")
    ])
      await expect(probe()).resolves.toMatchObject({ ok: false, notConfigured: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers notConfigured when the sidecar is up but reports the integration's settings missing", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ status: "not_configured", missing: ["EXAMPLE_SHARED_EMAIL"] }, { status: 200 })
    ) as unknown as typeof fetch;
    await expect(probeCalendarSource("example_shared")).resolves.toMatchObject({
      ok: false,
      notConfigured: true,
      detail: "Example Shared is not configured: EXAMPLE_SHARED_EMAIL."
    });
  });

  it("resolves probeOpenAI as a normal failure when the sidecar never answers", async () => {
    stubNeverRespondingFetch();
    await expect(probeOpenAI()).resolves.toMatchObject({ ok: false });
  });

  it("resolves the shared source probe as a normal failure when the sidecar never answers", async () => {
    stubNeverRespondingFetch();
    await expect(probeCalendarSource("example_shared")).resolves.toMatchObject({ ok: false });
  });

  it("probes Example Daily through its calendar_source proof capability", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () =>
      Response.json({ status: "not_configured", missing: ["EXAMPLE_DAILY_COOKIE"] }, { status: 200 })
    );
    globalThis.fetch = fetchSpy;
    await expect(probeCalendarSource("example_daily")).resolves.toMatchObject({
      ok: false,
      notConfigured: true,
      detail: "Example Daily is not configured: EXAMPLE_DAILY_COOKIE."
    });
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "http://proxy.internal:4200/capabilities/calendar_source/example_daily/proof"
    );
  });

  it("resolves the daily source probe as a normal failure when the sidecar never answers", async () => {
    stubNeverRespondingFetch();
    await expect(probeCalendarSource("example_daily")).resolves.toMatchObject({ ok: false });
  });
});
