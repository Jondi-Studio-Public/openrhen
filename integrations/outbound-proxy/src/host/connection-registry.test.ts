import { describe, expect, it } from "vitest";
import { CORE_CONNECTIONS, bundledConnections } from "./bundled-connections.js";
import type { BoundConnection } from "./connection-api.js";
import { registerConnection, registeredConnections } from "./connection-registry.js";

describe("the connection host's lists", () => {
  it("keeps a fixed core list that needs no drop-in", () => {
    expect(CORE_CONNECTIONS.map(({ manifest }) => manifest.id)).toEqual([
      "google_calendar",
      "google",
      "pulse",
      "openai",
      "deepinfra",
      "calendar_feed",
      "youtube_data"
    ]);
  });

  it("serves the core list first, then whatever drop-ins registered", () => {
    const ids = bundledConnections().map(({ manifest }) => manifest.id);
    expect(ids.slice(0, CORE_CONNECTIONS.length)).toEqual(CORE_CONNECTIONS.map(({ manifest }) => manifest.id));
    expect(ids.slice(CORE_CONNECTIONS.length)).toEqual(registeredConnections().map(({ manifest }) => manifest.id));
  });

  it("registers a connection once per id", () => {
    const extra = { manifest: { id: "example_registered" }, create: () => ({}) } as unknown as BoundConnection;
    const before = registeredConnections().length;
    registerConnection(extra);
    registerConnection(extra);
    expect(registeredConnections().length).toBe(before + 1);
    expect(bundledConnections().at(-1)).toBe(extra);
  });
});
