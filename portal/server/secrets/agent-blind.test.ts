import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_TOOL_MANIFEST, scopesForRoute } from "@openrhen/contracts";
import type { AgentPrincipal } from "@/server/agent-tokens";

/**
 * No agent can reach a saved password or key. A token holding every scope it could be given is refused on all of the
 * secret routes (and the one that spends the saved YouTube key), no tool in the MCP manifest names them, the
 * in-process CLI route table can only reach them as the owner, and no CLI source mentions them.
 */
const identity = vi.hoisted(() => ({ current: undefined as undefined | { actor: string; principal: AgentPrincipal } }));
vi.mock("@/server/agent-tokens", async (original) => ({
  ...(await original<typeof import("@/server/agent-tokens")>()),
  identifyRequest: async () => identity.current ?? { actor: undefined }
}));
const store = vi.hoisted(() => ({ putSecret: vi.fn(), deleteSecret: vi.fn(), secretStatuses: vi.fn() }));
vi.mock("@/server/persistence/postgres/app-secrets-store", () => store);
const lengths = vi.hoisted(() => ({ fetchMissingVideoLengths: vi.fn() }));
vi.mock("@/server/persistence/postgres/video-lengths-store", () => lengths);
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "u" }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgresql://u:p@localhost/db" }));

const { GET } = await import("@/app/api/settings/secrets/route");
const { PUT, DELETE } = await import("@/app/api/settings/secrets/[name]/route");
const { POST: FETCH_LENGTHS } = await import("@/app/api/review/watch-history/lengths/route");
const { MCP_ROUTE_TABLE } = await import("@/server/mcp-route-table");

const ALL_SCOPES = [
  "read:plan",
  "read:mail",
  "read:files",
  "read:changes",
  "read:settings",
  "write:catch-up",
  "propose:catch-up",
  "write:entity:commitment",
  "write:entity:action",
  "write:entity:settings",
  "write:settings"
];

beforeEach(() => {
  vi.stubEnv("PORTAL_PUBLIC_URL", "http://portal.test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const mock of [...Object.values(store), ...Object.values(lengths)]) mock.mockReset();
  identity.current = {
    actor: "companion",
    principal: {
      name: "companion",
      source: "db",
      tokenId: "t1",
      scopes: ALL_SCOPES,
      directWrites: { commitment: "on", action: "on" }
    }
  };
});

describe("an agent token holding every scope", () => {
  const ctx = { params: Promise.resolve({ name: "youtube_data_api_key" }) };
  const request = (method: string, body?: unknown) =>
    new Request("http://portal.test/api/settings/secrets/youtube_data_api_key", {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    });

  it("gets 403 listing the secrets", async () => {
    expect((await GET(request("GET"), undefined)).status).toBe(403);
    expect(store.secretStatuses).not.toHaveBeenCalled();
  });

  it("gets 403 saving a key and 403 removing one, and nothing is stored or removed", async () => {
    expect((await PUT(request("PUT", { value: "k" }), ctx)).status).toBe(403);
    expect((await DELETE(request("DELETE"), ctx)).status).toBe(403);
    expect(store.putSecret).not.toHaveBeenCalled();
    expect(store.deleteSecret).not.toHaveBeenCalled();
  });

  it("gets 403 asking the app to spend the saved YouTube key", async () => {
    const response = await FETCH_LENGTHS(
      new Request("http://portal.test/api/review/watch-history/lengths", { method: "POST" }),
      undefined
    );
    expect(response.status).toBe(403);
    expect(lengths.fetchMissingVideoLengths).not.toHaveBeenCalled();
  });
});

describe("the MCP surface", () => {
  it("routes every secret path as owner-only, for every method", () => {
    const secretRoutes = Object.keys(MCP_ROUTE_TABLE).filter((route) => /secrets|watch-history\/lengths/.test(route));
    expect(secretRoutes.sort()).toEqual([
      "/api/review/watch-history/lengths",
      "/api/settings/secrets",
      "/api/settings/secrets/[name]"
    ]);
    for (const route of secretRoutes)
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
        expect(scopesForRoute(method, route, {}), `${method} ${route}`).toMatchObject({ kind: "refused" });
  });

  it("has no tool that names a secret route, the store, or a key", () => {
    const text = JSON.stringify(MCP_TOOL_MANIFEST).toLowerCase();
    for (const word of ["settings/secrets", "app_secrets", "youtube_data_api_key", "passwords and keys"])
      expect(text, word).not.toContain(word);
  });
});

describe("the CLI and the MCP tool sources", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (["node_modules", "dist", ".next"].includes(entry.name)) return [];
      const path = join(dir, entry.name);
      return entry.isDirectory()
        ? walk(path)
        : /\.(ts|tsx|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)
          ? [path]
          : [];
    });

  it("mention no secret route, store or key name", () => {
    const files = [
      ...walk(join(root, "tools", "cli", "src")),
      join(root, "platform", "contracts", "src", "mcp-manifest-data.ts")
    ];
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const word of ["settings/secrets", "app_secrets", "youtube_data_api_key", "OPENRHEN_SECRETS_KEY"])
        expect(text, `${file} names ${word}`).not.toContain(word);
    }
  });
});
