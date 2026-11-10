import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => vi.fn());
vi.mock("@/server/location/location-observation-store", () => ({ withLocationObservationStore: store }));
const credentials = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock("@/server/owner-credential-store", () => ({
  findOwnerCredentialByHash: credentials.find,
  touchOwnerCredential: async () => false
}));
vi.mock("@/server/runtime-env", async (original) => ({
  ...(await original<typeof import("@/server/runtime-env")>()),
  databaseUrl: () => "postgres://test"
}));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));

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

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const TOKEN = "pri_own_phone";
const INSTALL = "c0ffee00-1234-4abc-8def-0123456789ab";
const OTHER = "deadbeef-1234-4abc-8def-0123456789ab";
let counter = 0;
const withOwner = (headers: Record<string, string>, body: Record<string, unknown> = {}) =>
  POST(
    new Request("http://x/api/location/ping", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.9.0.${++counter}`, ...headers },
      body: JSON.stringify({
        latitude: 1,
        longitude: 2,
        accuracyMeters: 5,
        observedAt: new Date().toISOString(),
        ...body
      })
    }),
    { params: Promise.resolve({}) } as never
  );
const record = vi.fn(async (_observation?: unknown, _now?: Date, _device?: string) => ({
  decision: "refreshed",
  locationId: null,
  locationName: null,
  suggestion: null
}));
const stored = (over: Record<string, unknown> = {}) =>
  credentials.find.mockImplementation(async (_sql: unknown, h: string) =>
    h === hash(TOKEN)
      ? {
          id: "11111111-1111-4111-8111-111111111111",
          kind: "token",
          secretHash: h,
          expiresAt: null,
          revokedAt: null,
          limited: true,
          device: { installId: INSTALL, platform: "ios" },
          parentId: null,
          ...over
        }
      : null
  );

describe("POST /api/location/ping with an owner header token", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    store.mockReset();
    record.mockClear();
  });
  const wire = () =>
    store.mockImplementation(async (operation: (s: unknown) => unknown) => operation({ recordPhonePing: record }));

  it("accepts the device's token with no LOCATION_PING_TOKEN set, and tracks presence under the token's device", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("LOCATION_PING_TOKEN", "");
    stored();
    wire();
    const response = await withOwner({ "x-openrhen-owner": TOKEN });
    expect(response.status).toBe(200);
    expect(record.mock.calls[0]![2]).toBe(INSTALL);
  });

  it("verifies the token itself under every owner-auth mode, because off and shadow return before the gate", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    stored();
    wire();
    for (const mode of ["off", "shadow", "require"]) {
      vi.stubEnv("OPENRHEN_OWNER_AUTH", mode);
      expect((await withOwner({ "x-openrhen-owner": TOKEN })).status, mode).toBe(200);
      expect((await withOwner({ "x-openrhen-owner": "pri_own_unknown" })).status, mode).toBe(401);
    }
  });

  it("answers a revoked token with the owner-auth error, not 'requires a valid location token'", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    stored({ revokedAt: new Date() });
    wire();
    for (const mode of ["off", "require"]) {
      vi.stubEnv("OPENRHEN_OWNER_AUTH", mode);
      const response = await withOwner({ "x-openrhen-owner": TOKEN });
      expect(response.status, mode).toBe(401);
      const { error } = (await response.json()) as { error: string };
      expect(error).toContain("revoked");
      expect(error).not.toContain("location token");
    }
    expect(record).not.toHaveBeenCalled();
  });

  it("does not accept a cookie, so a browser cannot move the location", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("LOCATION_PING_TOKEN", "");
    stored({ kind: "browser" });
    wire();
    const response = await withOwner({ cookie: "openrhen_owner=pri_own_phone" });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toContain("location token");
    // A browser-session secret in the header is not an owner token either.
    expect((await withOwner({ "x-openrhen-owner": TOKEN })).status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it("takes an optional device, refuses one that contradicts the token's device, and still serves LOCATION_PING_TOKEN", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    stored();
    wire();
    expect((await withOwner({ "x-openrhen-owner": TOKEN }, { device: INSTALL })).status).toBe(200);
    expect((await withOwner({ "x-openrhen-owner": TOKEN }, { device: OTHER })).status).toBe(400);
    expect((await withOwner({ "x-openrhen-owner": TOKEN }, { device: "NOT VALID" })).status).toBe(400);
    vi.stubEnv("LOCATION_PING_TOKEN", "shared-collector-token");
    expect((await withOwner({ authorization: "Bearer shared-collector-token" }, { device: OTHER })).status).toBe(200);
    expect(record.mock.calls.at(-1)![2]).toBe(OTHER);
    expect((await withOwner({ authorization: "Bearer shared-collector-token" })).status).toBe(200);
    expect(record.mock.calls.at(-1)![2]).toBeUndefined();
  });
});
