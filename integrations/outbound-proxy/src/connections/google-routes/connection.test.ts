import { describe, expect, it, vi } from "vitest";
import type { OpCall } from "../../host/connection-api.js";
import { googleRoutesConnection } from "./connection.js";

function call(body: unknown, env: Record<string, string | undefined>, fetcher: typeof fetch): OpCall {
  return { body, env, fetch: fetcher, signal: new AbortController().signal, pathname: "/test" };
}

const impl = googleRoutesConnection.create({});
const matrix = impl.travel_time!.matrix!;
const geocode = impl.geocoding!.geocode!;
const failing = (() => Promise.reject(new Error("network down"))) as typeof fetch;

describe("google connection", () => {
  it("refuses an invalid body before it looks for the key", async () => {
    expect(await matrix.run(call({}, {}, failing))).toEqual({
      status: 400,
      body: { error: "The travel request failed validation." }
    });
    expect(await geocode.run(call({}, {}, failing))).toEqual({
      status: 400,
      body: { error: "The geocode request failed validation." }
    });
  });

  it("reads the key from the call's env, and says so when it is missing", async () => {
    expect(await geocode.run(call({ query: "x" }, {}, failing))).toEqual({
      status: 400,
      body: { error: "GOOGLE_MAPS_API_KEY is not configured." }
    });
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ status: "OK", results: [] }))
    ) as unknown as typeof fetch;
    const result = await geocode.run(call({ query: "x" }, { GOOGLE_MAPS_API_KEY: "k" }, fetcher));
    expect(result).toEqual({ status: 200, body: { matches: [] } });
  });

  it("answers an upstream failure as a 502 carrying the message", async () => {
    const result = await geocode.run(call({ query: "x" }, { GOOGLE_MAPS_API_KEY: "k" }, failing));
    expect(result).toEqual({ status: 502, body: { error: "network down" } });
  });
});
