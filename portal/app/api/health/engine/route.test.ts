import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/diagnostics/engine-probe", () => ({
  probeEngine: async () => ({ reachable: true, configured: true, latencyMs: 4, engineVersion: "1.2.3" })
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
  GET(new Request("http://x/api/health/engine", { headers }), { params: Promise.resolve({}) } as never);

describe("GET /api/health/engine", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is unchanged with owner auth off", async () => {
    expect(await (await get()).json()).toMatchObject({ engineVersion: "1.2.3" });
  });

  it("tells an anonymous caller only reachable / not once owner auth is on, and an owner everything", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await (await get()).json()).toEqual({ reachable: true });
    expect(await (await get({ "x-openrhen-owner": "good" })).json()).toMatchObject({ engineVersion: "1.2.3" });
  });
});
