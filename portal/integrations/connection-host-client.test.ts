import { describe, expect, it, vi } from "vitest";
import {
  callCapability,
  connectionHostConfigured,
  ConnectionHostNotConfiguredError,
  streamCapability
} from "./connection-host-client";

const env = { OUTBOUND_PROXY_URL: "http://proxy.internal:4200/", OUTBOUND_PROXY_TOKEN: "test-token" };

function answer(body: unknown, status = 200) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(body, { status }));
}

describe("connection host client", () => {
  it("posts a JSON body to the capability path with the bearer token", async () => {
    const fetcher = answer({ calendars: [] });
    const result = await callCapability({
      connectionId: "google_calendar",
      capability: "calendar_source",
      op: "list_calendars",
      body: { a: 1 },
      env,
      fetcher: fetcher as unknown as typeof fetch
    });
    expect(result).toEqual({ ok: true, status: 200, body: { calendars: [] } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://proxy.internal:4200/capabilities/calendar_source/google_calendar/list_calendars");
    expect(init?.method).toBe("POST");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer test-token");
    expect(JSON.parse(String(init?.body))).toEqual({ a: 1 });
  });

  it("parses a failure, and keeps the message when the reason is one it does not know", async () => {
    const known = await callCapability({
      connectionId: "x",
      capability: "calendar_source",
      op: "proof",
      body: {},
      env,
      fetcher: answer({ error: "no", reason: "invalid_grant" }, 502) as unknown as typeof fetch
    });
    expect(known).toMatchObject({ ok: false, status: 502, failure: { error: "no", reason: "invalid_grant" } });
    const unknown = await callCapability({
      connectionId: "x",
      capability: "calendar_source",
      op: "proof",
      body: {},
      env,
      fetcher: answer({ error: "odd", reason: "something_new" }, 502) as unknown as typeof fetch
    });
    expect(unknown.failure).toEqual({ error: "odd" });
  });

  it("refuses without a request when the sidecar is not set up, and reads the env it is given", async () => {
    const fetcher = vi.fn();
    await expect(
      callCapability({ connectionId: "x", capability: "calendar_source", op: "proof", body: {}, env: {}, fetcher })
    ).rejects.toBeInstanceOf(ConnectionHostNotConfiguredError);
    expect(fetcher).not.toHaveBeenCalled();
    expect(connectionHostConfigured({})).toBe(false);
    expect(connectionHostConfigured(env)).toBe(true);
  });

  it("aborts when the host never answers, within the configured timeout", async () => {
    const stalled = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
        })
    );
    await expect(
      callCapability({
        connectionId: "x",
        capability: "calendar_source",
        op: "proof",
        body: {},
        env: { ...env, OUTBOUND_REQUEST_TIMEOUT_MS: "20" },
        fetcher: stalled as unknown as typeof fetch
      })
    ).rejects.toThrow();
  });

  it("streams: returns the raw Response unread, from the same capability path", async () => {
    const sse = new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => sse);
    const result = await streamCapability({
      connectionId: "openai",
      capability: "model_provider",
      op: "stream",
      body: { stream: true },
      env,
      fetcher: fetcher as unknown as typeof fetch
    });
    expect(result).toBe(sse);
    expect(result.bodyUsed).toBe(false);
    expect(fetcher.mock.calls[0]![0]).toBe("http://proxy.internal:4200/capabilities/model_provider/openai/stream");
  });

  it("streams: throws without a request when the sidecar is not set up", async () => {
    const fetcher = vi.fn();
    await expect(
      streamCapability({
        connectionId: "openai",
        capability: "model_provider",
        op: "stream",
        body: {},
        env: {},
        fetcher: fetcher as unknown as typeof fetch
      })
    ).rejects.toBeInstanceOf(ConnectionHostNotConfiguredError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
