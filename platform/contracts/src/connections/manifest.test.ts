import { describe, expect, it } from "vitest";
import { CONNECTION_MANIFEST_VERSION, connectionManifestSchema } from "./manifest.js";

const base = {
  id: "demo",
  label: "Demo",
  capabilities: ["travel_time"],
  secrets: { anyOf: [["DEMO_KEY"]] },
  config: {}
};

describe("connectionManifestSchema", () => {
  it("accepts a minimal manifest", () => {
    expect(connectionManifestSchema.safeParse(base).success).toBe(true);
  });
  it("rejects no capabilities, a reserved id, and a bad env name", () => {
    expect(connectionManifestSchema.safeParse({ ...base, capabilities: [] }).success).toBe(false);
    expect(connectionManifestSchema.safeParse({ ...base, id: "email" }).success).toBe(false);
    expect(connectionManifestSchema.safeParse({ ...base, secrets: { anyOf: [["lower"]] } }).success).toBe(false);
  });
  it("rejects ops outside the capability or not declared", () => {
    expect(connectionManifestSchema.safeParse({ ...base, ops: { travel_time: ["geocode"] } }).success).toBe(false);
    expect(connectionManifestSchema.safeParse({ ...base, ops: { geocoding: ["geocode"] } }).success).toBe(false);
  });
  it("requires calendarSource exactly for calendar_source", () => {
    expect(connectionManifestSchema.safeParse({ ...base, capabilities: ["calendar_source"] }).success).toBe(false);
  });
  it("reads a missing version as 1 and exposes the supported version", () => {
    expect(CONNECTION_MANIFEST_VERSION).toBe(1);
    expect(connectionManifestSchema.parse(base).version).toBe(1);
  });
  it("keeps an explicit version, including one above the supported version", () => {
    expect(connectionManifestSchema.parse({ ...base, version: 1 }).version).toBe(1);
    expect(connectionManifestSchema.parse({ ...base, version: 2 }).version).toBe(2);
    expect(connectionManifestSchema.safeParse({ ...base, version: 0 }).success).toBe(false);
  });
});
