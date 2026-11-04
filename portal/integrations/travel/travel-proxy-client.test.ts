import { describe, expect, it, vi } from "vitest";
import { fetchTravelMatrix, geocodeQuery } from "./travel-proxy-client";

const env = { OUTBOUND_PROXY_URL: "http://proxy.internal:4200", OUTBOUND_PROXY_TOKEN: "test-token" };

describe("travel proxy client timeouts", () => {
  it("bounds geocodeQuery with an abort signal that fires when the sidecar never answers", async () => {
    const neverResponds = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "TimeoutError"))
          );
        })
    );
    await expect(
      geocodeQuery("123 Main St", { ...env, OUTBOUND_REQUEST_TIMEOUT_MS: "20" }, neverResponds as typeof fetch)
    ).rejects.toThrow();
  });

  it("bounds fetchTravelMatrix with an abort signal that fires when the sidecar never answers", async () => {
    const neverResponds = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "TimeoutError"))
          );
        })
    );
    await expect(
      fetchTravelMatrix(
        {
          origin: { latitude: 0, longitude: 0 },
          destinations: [{ locationId: "loc-1", latitude: 1, longitude: 1 }],
          modes: ["car"]
        },
        { ...env, OUTBOUND_REQUEST_TIMEOUT_MS: "20" },
        neverResponds as typeof fetch
      )
    ).rejects.toThrow();
  });
});
