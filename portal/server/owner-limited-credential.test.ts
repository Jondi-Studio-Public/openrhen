import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { classifiedRoutes, limitedCredentialDecision, ownerAdminRoutes } from "@openrhen/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A limited owner credential (a paired phone's token, and the web view that descends from it) is held to its route
 * class: the `owner-admin` routes are refused, every other classified route is open, and a route nothing classifies is
 * refused. The routes come from the real route files, so a new route is walked the day it is added; each
 * classification therefore has a route-level test (the refusal comes from `withRoute`'s own gate, not a helper).
 */
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const LIMITED = "pri_own_limited-device-token";
const FULL = "pri_own_full-desk-token";
const CHILD = "pri_ses_limited-web-view";
const stored: Record<string, Record<string, unknown>> = {
  [hash(LIMITED)]: {
    id: "dev-1",
    kind: "token",
    limited: true,
    device: { installId: "install-0001", platform: "ios" }
  },
  [hash(FULL)]: { id: "desk-1", kind: "token", limited: false },
  [hash(CHILD)]: { id: "web-1", kind: "browser", limited: true, parentId: "dev-1" }
};
vi.mock("@/server/agent-tokens", () => ({ identifyRequest: async () => ({}) }));
vi.mock("./owner-credential-store", () => ({
  findOwnerCredentialByHash: async (_sql: unknown, h: string) => {
    const row = stored[h];
    return row ? { secretHash: h, expiresAt: null, revokedAt: null, device: null, parentId: null, ...row } : null;
  },
  touchOwnerCredential: async () => false
}));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));

const { withRoute } = await import("./logging");

const appRoot = fileURLToPath(new URL("../app", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? files(path) : entry === "route.ts" ? [path] : [];
  });
const routes = ["api", "oauth"].flatMap((root) =>
  files(join(appRoot, root)).flatMap((file) => {
    const template = `/${relative(appRoot, join(file, "..")).split(sep).join("/")}`;
    return [
      ...readFileSync(file, "utf8").matchAll(
        /export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g
      )
    ].map((match) => ({ method: match[1]!, template, key: `${match[1]} ${template}` }));
  })
);
const concrete = (template: string) => template.replaceAll(/\[[^\]]+\]/g, "11111111-1111-4111-8111-111111111111");

const handler = vi.fn(async () => Response.json({ ran: true }));
const call = (method: string, template: string, headers: Record<string, string>) =>
  withRoute(template, handler)(
    new Request(`http://portal.test${concrete(template)}`, {
      method,
      headers: { host: "portal.test", origin: "http://portal.test", ...headers },
      ...(method === "GET" ? {} : { body: "{}" })
    }),
    undefined
  );

beforeEach(() => {
  vi.stubEnv("PORTAL_PUBLIC_URL", "https://portal.test");
  vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
  vi.spyOn(console, "log").mockImplementation(() => {});
  handler.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

const SELF_SERVE = new Set(["DELETE /api/owner/credentials/[id]"]);

describe("the owner-admin class", () => {
  it("names only routes that exist, each with a route file", () => {
    const existing = new Set(routes.map((route) => route.key));
    expect(ownerAdminRoutes().filter((key) => !existing.has(key))).toEqual([]);
  });

  it("is exactly the routes the design lists, so adding or dropping one is a deliberate change", () => {
    expect(ownerAdminRoutes().sort()).toEqual(
      [
        "POST /api/owner/enroll",
        "POST /api/owner/credentials",
        "DELETE /api/owner/credentials/[id]",
        "POST /api/agent-tokens",
        "DELETE /api/agent-tokens/[id]",
        "PATCH /api/agent-tokens/[id]",
        "POST /oauth/authorize",
        "POST /api/owner/devices/pairings",
        "POST /api/owner/devices/code/approve",
        "PUT /api/settings/secrets/[name]",
        "DELETE /api/settings/secrets/[name]",
        "POST /api/connections/status",
        "PUT /api/connections/[connectionId]/calendars",
        "POST /api/connections/[connectionId]/write-proof",
        "POST /api/connections/[connectionId]/publish",
        "POST /api/connections/[connectionId]/publish/remove",
        "POST /api/connections/[connectionId]/import/preview",
        "DELETE /api/activity-sources/[source]/events"
      ].sort()
    );
  });

  it("leaves the decided-on-purpose routes open: the whole-state save, proposal resolve, import undo, derived settings", () => {
    for (const [method, route] of [
      ["PUT", "/api/state"],
      ["POST", "/api/agent-proposals/[id]/resolve"],
      ["DELETE", "/api/activity-imports/[id]"],
      ["PUT", "/api/activity-sources/[source]"],
      ["PUT", "/api/derived-settings"],
      ["POST", "/api/owner/web-session"],
      ["GET", "/api/client/view"],
      ["GET", "/api/check-ins/answered"],
      ["POST", "/api/check-ins/[id]/shown"],
      ["POST", "/api/owner/signout"],
      ["POST", "/api/location/ping"],
      ["POST", "/api/commands/entity"]
    ] as const)
      expect(limitedCredentialDecision(method, route), `${method} ${route}`).toMatchObject({ allowed: true });
  });

  it("refuses a route no table classifies, and allows OPTIONS", () => {
    expect(limitedCredentialDecision("POST", "/api/not-a-route")).toEqual({ allowed: false, reason: "unclassified" });
    expect(limitedCredentialDecision("GET", "/api/not-a-route")).toEqual({ allowed: false, reason: "unclassified" });
    expect(limitedCredentialDecision("OPTIONS", "/api/not-a-route")).toEqual({ allowed: true });
  });

  it("every route file's method is classified for a limited credential one way or the other", () => {
    const classified = new Set(classifiedRoutes());
    for (const route of routes) expect(classified.has(route.key), route.key).toBe(true);
  });
});

describe("a limited credential, walked over every route file under require", () => {
  for (const route of routes) {
    const admin = ownerAdminRoutes().includes(route.key);
    if (admin && !SELF_SERVE.has(route.key))
      it(`${route.key} refuses a limited device token and its web view, and runs for a full token`, async () => {
        for (const headers of [{ "x-openrhen-owner": LIMITED }, { cookie: `openrhen_owner=${CHILD}` }]) {
          const response = await call(route.method, route.template, headers);
          expect(response.status, JSON.stringify(headers)).toBe(403);
          expect(response.headers.get("x-owner-reason")).toBe("limited-credential");
        }
        expect(handler).not.toHaveBeenCalled();
        expect((await call(route.method, route.template, { "x-openrhen-owner": FULL })).status).toBe(200);
        expect(handler).toHaveBeenCalledTimes(1);
      });
    else
      it(`${route.key} is open to a limited device token and its web view`, async () => {
        for (const headers of [{ "x-openrhen-owner": LIMITED }, { cookie: `openrhen_owner=${CHILD}` }]) {
          const response = await call(route.method, route.template, headers);
          expect(response.status, JSON.stringify(headers)).toBe(200);
        }
        expect(handler).toHaveBeenCalledTimes(2);
      });
  }

  it("refuses an unclassified route to a limited token but not to a full one", async () => {
    const limited = await call("POST", "/api/not-classified", { "x-openrhen-owner": LIMITED });
    expect(limited.status).toBe(403);
    const reading = await call("GET", "/api/not-classified", { cookie: `openrhen_owner=${CHILD}` });
    expect(reading.status).toBe(403);
    expect((await call("POST", "/api/not-classified", { "x-openrhen-owner": FULL })).status).toBe(200);
  });

  it("under off and shadow checks no credential, so limited protects nothing", async () => {
    for (const mode of ["off", "shadow"]) {
      vi.stubEnv("OPENRHEN_OWNER_AUTH", mode);
      expect((await call("POST", "/api/owner/devices/pairings", { "x-openrhen-owner": LIMITED })).status).toBe(200);
    }
  });
});
