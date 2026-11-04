import { describe, expect, it, vi } from "vitest";
import type { OpCall } from "../../host/connection-api.js";
import { pulseConnection } from "./connection.js";

function call(body: unknown, env: Record<string, string | undefined>, fetcher: typeof fetch): OpCall {
  return { body, env, fetch: fetcher, signal: new AbortController().signal, pathname: "/test" };
}

const { config, publish } = pulseConnection.create({}).status_publish!;
const failing = (() => Promise.reject(new Error("network down"))) as typeof fetch;
const env = { PULSE_PUBLISH_URL: "https://tracker.example.com/api/pulse", PULSE_PUBLISH_SECRET: "s" };

describe("pulse connection", () => {
  it("reports the tracker host from the call's env, never the URL", async () => {
    expect(await config!.run(call({}, {}, failing))).toEqual({ status: 200, body: { configured: false, host: null } });
    expect(await config!.run(call({}, env, failing))).toEqual({
      status: 200,
      body: { configured: true, host: "tracker.example.com" }
    });
  });

  it("answers 503 unconfigured, then 400 for an object that fails the schema", async () => {
    expect(await publish!.run(call({}, {}, failing))).toEqual({
      status: 503,
      body: { error: "The pulse tracker is not configured." }
    });
    const fetcher = vi.fn() as unknown as typeof fetch;
    expect(await publish!.run(call({ extra: 1 }, env, fetcher))).toEqual({
      status: 400,
      body: { error: "The pulse object failed validation." }
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
