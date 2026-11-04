import { describe, expect, it } from "vitest";
import { computeTravelMatrix, geocodePlace } from "./google-routes-client.js";

const origin = { latitude: -36.12, longitude: 146.89 };
const destinations = [
  { locationId: "shops", latitude: -36.13, longitude: 146.9 },
  { locationId: "college", latitude: -36.08, longitude: 146.92 }
];

/** Answers each mode with whatever the test says that mode costs, in the shape Routes returns. */
function stubRoutes(
  byMode: Record<string, Array<{ destinationIndex: number; duration?: string; condition?: string }>>
) {
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const mode = body.travelMode as string;
    calls.push(mode);
    bodies.push(body);
    return { ok: true, json: async () => byMode[mode] ?? [] } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, bodies };
}

describe("travel matrix", () => {
  it("keeps the quickest mode for each destination independently", async () => {
    const { fetchImpl, calls } = stubRoutes({
      DRIVE: [
        { destinationIndex: 0, duration: "600s", condition: "ROUTE_EXISTS" },
        { destinationIndex: 1, duration: "900s", condition: "ROUTE_EXISTS" }
      ],
      BICYCLE: [
        { destinationIndex: 0, duration: "360s", condition: "ROUTE_EXISTS" },
        { destinationIndex: 1, duration: "1800s", condition: "ROUTE_EXISTS" }
      ]
    });
    const result = await computeTravelMatrix({ origin, destinations, modes: ["car", "bike"] }, "test-key", fetchImpl);
    expect(calls).toEqual(["DRIVE", "BICYCLE"]);
    expect(result.estimates).toEqual([
      { locationId: "shops", minutes: 6, mode: "bike" },
      { locationId: "college", minutes: 15, mode: "car" }
    ]);
    expect(result.unroutable).toEqual([]);
  });

  it("asks only for the modes it was given", async () => {
    const { fetchImpl, calls } = stubRoutes({
      WALK: [{ destinationIndex: 0, duration: "1200s", condition: "ROUTE_EXISTS" }]
    });
    const result = await computeTravelMatrix(
      { origin, destinations: [destinations[0]!], modes: ["walk"] },
      "test-key",
      fetchImpl
    );
    expect(calls).toEqual(["WALK"]);
    expect(result.estimates).toEqual([{ locationId: "shops", minutes: 20, mode: "walk" }]);
  });

  it("names a destination it could not route to instead of dropping it", async () => {
    // A place that vanished from the results is indistinguishable from one that is unreachable, and
    // the second is a planning fact while the first is a defect.
    const { fetchImpl } = stubRoutes({
      DRIVE: [
        { destinationIndex: 0, duration: "600s", condition: "ROUTE_EXISTS" },
        { destinationIndex: 1, condition: "ROUTE_NOT_FOUND" }
      ]
    });
    const result = await computeTravelMatrix({ origin, destinations, modes: ["car"] }, "test-key", fetchImpl);
    expect(result.estimates).toEqual([{ locationId: "shops", minutes: 10, mode: "car" }]);
    expect(result.unroutable).toEqual(["college"]);
  });

  it("sets traffic-aware routing and the departure time for car only", async () => {
    const { fetchImpl, bodies } = stubRoutes({
      DRIVE: [{ destinationIndex: 0, duration: "600s", condition: "ROUTE_EXISTS" }],
      BICYCLE: [{ destinationIndex: 0, duration: "360s", condition: "ROUTE_EXISTS" }]
    });
    const departureAt = "2026-09-26T08:00:00+10:00";
    await computeTravelMatrix(
      { origin, destinations: [destinations[0]!], modes: ["car", "bike"], departureAt },
      "test-key",
      fetchImpl
    );
    const [carBody, bikeBody] = bodies;
    expect(carBody).toMatchObject({ routingPreference: "TRAFFIC_AWARE", departureTime: departureAt });
    expect(bikeBody).not.toHaveProperty("routingPreference");
    expect(bikeBody).not.toHaveProperty("departureTime");
  });

  it("omits traffic-aware routing when no departure time is given", async () => {
    const { fetchImpl, bodies } = stubRoutes({
      DRIVE: [{ destinationIndex: 0, duration: "600s", condition: "ROUTE_EXISTS" }]
    });
    await computeTravelMatrix({ origin, destinations: [destinations[0]!], modes: ["car"] }, "test-key", fetchImpl);
    expect(bodies[0]).not.toHaveProperty("routingPreference");
    expect(bodies[0]).not.toHaveProperty("departureTime");
  });

  it("reports every routed mode per destination in measurements, beside the quickest in estimates", async () => {
    const { fetchImpl } = stubRoutes({
      DRIVE: [
        { destinationIndex: 0, duration: "600s", condition: "ROUTE_EXISTS" },
        { destinationIndex: 1, duration: "900s", condition: "ROUTE_EXISTS" }
      ],
      BICYCLE: [
        { destinationIndex: 0, duration: "360s", condition: "ROUTE_EXISTS" },
        { destinationIndex: 1, duration: "1800s", condition: "ROUTE_EXISTS" }
      ]
    });
    const result = await computeTravelMatrix({ origin, destinations, modes: ["car", "bike"] }, "test-key", fetchImpl);
    expect(result.measurements).toEqual([
      { locationId: "shops", mode: "car", minutes: 10 },
      { locationId: "college", mode: "car", minutes: 15 },
      { locationId: "shops", mode: "bike", minutes: 6 },
      { locationId: "college", mode: "bike", minutes: 30 }
    ]);
    expect(result.estimates).toEqual([
      { locationId: "shops", minutes: 6, mode: "bike" },
      { locationId: "college", minutes: 15, mode: "car" }
    ]);
  });

  it("keeps the api key out of the error it raises", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 403,
        text: async () => "denied for key SECRET-KEY-VALUE"
      }) as unknown as Response) as unknown as typeof fetch;
    await expect(
      computeTravelMatrix({ origin, destinations, modes: ["car"] }, "SECRET-KEY-VALUE", fetchImpl)
    ).rejects.toThrow(/\[key\]/);
    await expect(
      computeTravelMatrix({ origin, destinations, modes: ["car"] }, "SECRET-KEY-VALUE", fetchImpl)
    ).rejects.not.toThrow(/SECRET-KEY-VALUE/);
  });
});

describe("geocoding", () => {
  it("returns the coordinates a typed place resolves to", async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        json: async () => ({
          status: "OK",
          results: [
            { formatted_address: "Harbor Mart, Riverside VIC", geometry: { location: { lat: -36.12, lng: 146.88 } } }
          ]
        })
      }) as unknown as Response) as unknown as typeof fetch;
    const result = await geocodePlace("harbor mart riverside", "test-key", fetchImpl);
    expect(result.matches).toEqual([{ label: "Harbor Mart, Riverside VIC", latitude: -36.12, longitude: 146.88 }]);
  });

  it("treats no match as an empty answer rather than a failure", async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        json: async () => ({ status: "ZERO_RESULTS", results: [] })
      }) as unknown as Response) as unknown as typeof fetch;
    await expect(geocodePlace("nowhere at all", "test-key", fetchImpl)).resolves.toEqual({ matches: [] });
  });
});
