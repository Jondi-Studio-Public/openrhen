import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ health: vi.fn() }));

vi.mock("@/server/persistence/state-store", () => ({
  getStateStore: () => ({ health: holder.health })
}));

vi.mock("@/server/owner-credential-store", () => ({
  findOwnerCredentialByHash: async (_pool: unknown, hash: string) =>
    hash === createHash("sha256").update("good").digest("hex")
      ? { id: "c1", kind: "token", secretHash: hash, expiresAt: null, revokedAt: null }
      : null,
  touchOwnerCredential: async () => false
}));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));

import { GET } from "./route";

const get = (headers: Record<string, string> = {}) =>
  GET(new Request("http://x/api/health/database", { headers }), { params: Promise.resolve({}) } as never);

describe("GET /api/health/database", () => {
  beforeEach(() => {
    holder.health.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns the health when the database is reachable and migrated", async () => {
    holder.health.mockResolvedValue({
      provider: "postgresql",
      connected: true,
      version: "PostgreSQL 16",
      latencyMs: 3
    });
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connected: true });
  });

  it("answers 503 connected with MIGRATIONS_PENDING when the schema is behind", async () => {
    holder.health.mockImplementation(async () => {
      throw Object.assign(new Error("1 database migration is pending (0103_x); run db:migrate"), {
        code: "MIGRATIONS_PENDING"
      });
    });
    const response = await get();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      connected: true,
      errorCode: "MIGRATIONS_PENDING",
      detail: expect.stringContaining("0103_x")
    });
  });

  it("answers 503 not connected for any other failure", async () => {
    holder.health.mockImplementation(async () => {
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    });
    const response = await get();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ connected: false, errorCode: "ECONNREFUSED" });
  });

  describe("with owner auth on", () => {
    beforeEach(() => vi.stubEnv("OPENRHEN_OWNER_AUTH", "require"));
    afterEach(() => vi.unstubAllEnvs());

    it("tells an anonymous caller only ok / not ok, never the version, driver code or error text", async () => {
      holder.health.mockResolvedValue({
        provider: "postgresql",
        connected: true,
        version: "PostgreSQL 16",
        latencyMs: 3
      });
      const ok = await get();
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ connected: true });
      holder.health.mockImplementation(async () => {
        throw Object.assign(new Error("password authentication failed for user openrhen"), { code: "28P01" });
      });
      const down = await get();
      expect(down.status).toBe(503);
      expect(await down.json()).toEqual({ connected: false });
    });

    it("keeps the pending-migrations flag for an anonymous caller but not the detail", async () => {
      holder.health.mockImplementation(async () => {
        throw Object.assign(new Error("1 database migration is pending (0103_x)"), { code: "MIGRATIONS_PENDING" });
      });
      const response = await get();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ connected: true, errorCode: "MIGRATIONS_PENDING" });
    });

    it("keeps the detail for an owner credential", async () => {
      holder.health.mockImplementation(async () => {
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      });
      expect(await (await get({ "x-openrhen-owner": "good" })).json()).toMatchObject({
        errorCode: "ECONNREFUSED",
        detail: "refused"
      });
    });
  });
});
