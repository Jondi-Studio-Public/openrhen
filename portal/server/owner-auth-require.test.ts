import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { deviceRoute, ownerAuthExemption, scopesForRoute, workerRoute } from "@openrhen/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * With `OPENRHEN_OWNER_AUTH=require`, every write route in the app refuses a caller with no owner credential
 * and no agent token, however the body is labelled, and so does a caller that only names itself. The routes come
 * from the real route files, so a new write route is walked the day it is added; the only way past is an entry in
 * the exemption table, which the second test pins.
 */
vi.mock("@/server/agent-tokens", () => ({
  identifyRequest: async (request: Request) => {
    const name = request.headers.get("x-openrhen-agent");
    return name ? { actor: name } : {};
  }
}));
vi.mock("./owner-credential-store", () => ({ findOwnerCredentialByHash: async () => null }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));

const { withRoute } = await import("./logging");

const apiRoot = fileURLToPath(new URL("../app/api", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? files(path) : entry === "route.ts" ? [path] : [];
  });
const routes = files(apiRoot).flatMap((file) => {
  const template = `/api/${relative(apiRoot, join(file, "..")).split(sep).join("/")}`;
  return [
    ...readFileSync(file, "utf8").matchAll(
      /export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g
    )
  ].map((match) => ({ method: match[1]!, template }));
});
const concrete = (template: string) => template.replaceAll(/\[[^\]]+\]/g, "11111111-1111-4111-8111-111111111111");

const handler = vi.fn(async () => Response.json({ ran: true }));
const call = (method: string, template: string, headers: Record<string, string>, body?: string) =>
  withRoute(template, handler)(
    new Request(`http://portal.test${concrete(template)}`, {
      method,
      headers,
      ...(body === undefined || method === "GET" ? {} : { body })
    }),
    undefined
  );

beforeEach(() => {
  // The default host allowlist is closed: admit the host these tests send.
  vi.stubEnv("PORTAL_PUBLIC_URL", "https://portal.test");
  handler.mockClear();
  vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

const WORKER_SECRET = "worker-secret-for-the-walk";

describe("owner auth require: worker routes", () => {
  const workerRoutes = routes.filter((route) => workerRoute(route.method, route.template));
  beforeEach(() => vi.stubEnv("WORKER_TOKEN_HASH", createHash("sha256").update(WORKER_SECRET).digest("hex")));

  // The optional features add their own ingest routes (see the twin test); these are the core ones.
  const core = [
    "/api/connections/[connectionId]/sync",
    "/api/connections/[connectionId]/publish",
    "/api/integrations/travel/tick",
    "/api/integrations/derived/tick",
    "/api/integrations/derived/model-tick",
    "/api/integrations/work-label/tick",
    "/api/integrations/pulse/tick",
    "/api/integrations/push/drain",
    "/api/plan-map/sweep"
  ];
  it("finds every core worker route in the route files", () =>
    expect(workerRoutes.filter((route) => core.includes(route.template)).length).toBe(11));

  for (const route of workerRoutes) {
    it(`${route.method} ${route.template} refuses anonymous callers and accepts a worker token`, async () => {
      for (const headers of [{}, { "x-openrhen-agent": "companion" }]) {
        const response = await call(route.method, route.template, headers, "{}");
        expect(response.status, JSON.stringify(headers)).toBe(401);
      }
      expect(handler).not.toHaveBeenCalled();
      const ok = await call(route.method, route.template, { "x-openrhen-worker": WORKER_SECRET }, "{}");
      expect(ok.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  }

  it("refuses a wrong worker token", async () => {
    const response = await call("POST", "/api/integrations/pulse/tick", { "x-openrhen-worker": "wrong" }, "{}");
    expect(response.status).toBe(401);
  });

  it("refuses the worker token on every other route that is not exempt or public", async () => {
    for (const route of routes) {
      if (workerRoute(route.method, route.template)) continue;
      if (deviceRoute(route.method, route.template)) continue;
      if (ownerAuthExemption(route.method, route.template) !== undefined) continue;
      if (route.method === "GET" && scopesForRoute("GET", route.template).kind === "public") continue;
      const response = await call(route.method, route.template, { "x-openrhen-worker": WORKER_SECRET }, "{}");
      expect(response.status, `${route.method} ${route.template}`).toBe(401);
    }
  });
});

const DEVICE_SECRET = "device-secret-for-the-walk";

describe("owner auth require: device routes", () => {
  const deviceRoutes = routes.filter((route) => deviceRoute(route.method, route.template));
  beforeEach(() => vi.stubEnv("DEVICE_TOKEN_HASH", createHash("sha256").update(DEVICE_SECRET).digest("hex")));

  it("finds both device routes in the route files", () => expect(deviceRoutes.length).toBe(2));

  for (const route of deviceRoutes)
    it(`${route.method} ${route.template} refuses anonymous callers and accepts a device token`, async () => {
      for (const headers of [{}, { "x-openrhen-agent": "companion" }, { "x-openrhen-worker": WORKER_SECRET }]) {
        expect((await call(route.method, route.template, headers, "{}")).status).toBe(401);
      }
      expect(handler).not.toHaveBeenCalled();
      expect((await call(route.method, route.template, { "x-openrhen-device": DEVICE_SECRET }, "{}")).status).toBe(200);
    });

  it("refuses the device token on every other route that is not exempt or public", async () => {
    for (const route of routes) {
      if (deviceRoute(route.method, route.template)) continue;
      if (ownerAuthExemption(route.method, route.template) !== undefined) continue;
      if (route.method === "GET" && scopesForRoute("GET", route.template).kind === "public") continue;
      const response = await call(route.method, route.template, { "x-openrhen-device": DEVICE_SECRET }, "{}");
      expect(response.status, `${route.method} ${route.template}`).toBe(401);
    }
  });
});

describe("owner auth require: every write route", () => {
  const writes = routes.filter((route) => route.method !== "GET");
  it("walks the real routes", () => expect(writes.length).toBeGreaterThan(60));

  for (const route of writes) {
    const key = `${route.method} ${route.template}`;
    const exempt = ownerAuthExemption(route.method, route.template) !== undefined;
    if (workerRoute(route.method, route.template)) continue; // walked above
    if (deviceRoute(route.method, route.template)) continue; // walked below
    it(`${key} ${exempt ? "is exempt, and says why" : "refuses anonymous and name-only callers"}`, async () => {
      for (const headers of [
        {},
        { "content-type": "text/plain" },
        { "content-type": "application/json" },
        { "x-openrhen-agent": "companion", "content-type": "text/plain" }
      ]) {
        const response = await call(route.method, route.template, headers, "{}");
        if (exempt) expect(response.status, JSON.stringify(headers)).toBe(200);
        else {
          expect(response.status, JSON.stringify(headers)).toBe(401);
          expect(handler).not.toHaveBeenCalled();
        }
      }
    });
  }
});

describe("owner auth require: reads", () => {
  const reads = routes.filter((route) => route.method === "GET");
  it("refuses an anonymous read of every API route except the public and exempt ones", async () => {
    for (const route of reads) {
      const open =
        ownerAuthExemption("GET", route.template) !== undefined ||
        scopesForRoute("GET", route.template).kind === "public";
      const response = await call("GET", route.template, {});
      expect(response.status, route.template).toBe(open ? 200 : 401);
    }
  });
});

describe("owner auth require: a stale cookie", () => {
  it("is refused with a cookie-clearing 401 on a write, and is cleared on an exempt route that runs", async () => {
    const headers = { cookie: "openrhen_owner=gone", origin: "http://portal.test", host: "portal.test" };
    const refused = await call("POST", "/api/commands/action", headers, "{}");
    expect(refused.status).toBe(401);
    expect(refused.headers.get("set-cookie")).toContain("Max-Age=0");
    const exempt = await call("POST", "/api/location/ping", headers, "{}");
    expect(exempt.status).toBe(200);
    expect(exempt.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
