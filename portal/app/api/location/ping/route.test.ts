import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => vi.fn());
vi.mock("@/server/location/location-observation-store", () => ({ withLocationObservationStore: store }));

import { POST } from "./route";

const ping = (authorization?: string) =>
  POST(
    new Request("http://x/api/location/ping", {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ latitude: 1, longitude: 2, accuracyMeters: 5, observedAt: new Date().toISOString() })
    }),
    { params: Promise.resolve({}) } as never
  );

describe("POST /api/location/ping with no LOCATION_PING_TOKEN", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails closed: an unset, empty or blank token accepts nothing, not even an empty bearer", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) vi.stubEnv("LOCATION_PING_TOKEN", undefined as never);
      else vi.stubEnv("LOCATION_PING_TOKEN", value);
      for (const header of [undefined, "Bearer ", "Bearer ", "Bearer anything"]) {
        expect((await ping(header)).status).toBe(401);
      }
    }
    expect(store).not.toHaveBeenCalled();
  });
});
