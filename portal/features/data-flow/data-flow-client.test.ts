import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDataFlow, parseDataFlow } from "./data-flow-client";
import { response } from "./test-fixtures";

afterEach(() => vi.unstubAllGlobals());

describe("parseDataFlow", () => {
  it("accepts a response with a graph and health", () => {
    expect(parseDataFlow(response())?.entries.length).toBeGreaterThan(0);
  });

  it.each([null, "x", {}, { entries: [] }, { entries: [], edges: [], datasets: [], devices: [], unused: {} }])(
    "refuses a body that is not the graph (%j)",
    (body) => {
      expect(parseDataFlow(body)).toBeNull();
    }
  );

  it("accepts health that is unavailable", () => {
    const parsed = parseDataFlow({ ...response(), health: { unavailable: true, reason: "boom", next: "Run doctor." } });
    expect(parsed?.health.unavailable).toBe(true);
  });
});

describe("fetchDataFlow", () => {
  it("reads the route without caching", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => response() }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchDataFlow();
    expect(fetchMock).toHaveBeenCalledWith("/api/data-flow", expect.objectContaining({ cache: "no-store" }));
  });

  it("throws when the route fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }))
    );
    await expect(fetchDataFlow()).rejects.toThrow(/could not be read/);
  });

  it("throws when the body is not the graph", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ nope: 1 }) }))
    );
    await expect(fetchDataFlow()).rejects.toThrow(/could not be read/);
  });

  it("throws when the network is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline")))
    );
    await expect(fetchDataFlow()).rejects.toThrow();
  });
});
