import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ownerAuthExemption, scopesForRoute } from "@openrhen/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Whoever can reach the site that serves Now, Today and Plan sees no data without a credential. Every `/api`
 * route the pages, features, components, state and shared code call is found in their source and called
 * anonymously with `OPENRHEN_OWNER_AUTH=require`: each must answer 401. The only exceptions are routes that
 * return no plan data to an anonymous caller, named below, so a new open route that a page uses fails here.
 */
vi.mock("@/server/agent-tokens", () => ({
  identifyRequest: async () => ({}),
  AGENT_TOKEN_HEADER: "x-openrhen-token"
}));
vi.mock("./owner-credential-store", () => ({ findOwnerCredentialByHash: async () => null }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));

const { withRoute } = await import("./logging");

const root = fileURLToPath(new URL("..", import.meta.url));
const walk = (dir: string, keep: (path: string) => boolean): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === "node_modules" || entry === ".next" || entry === "dist") return [];
    return statSync(path).isDirectory() ? walk(path, keep) : keep(path) ? [path] : [];
  });

const apiRoot = join(root, "app", "api");
const routes = walk(apiRoot, (path) => path.endsWith(`${sep}route.ts`)).flatMap((file) => {
  const template = `/api/${relative(apiRoot, join(file, "..")).split(sep).join("/")}`;
  return [
    ...readFileSync(file, "utf8").matchAll(
      /export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g
    )
  ].map((match) => ({ method: match[1]!, template }));
});

const clientSources = ["app", "features", "components", "state", "shared"].flatMap((dir) =>
  walk(join(root, dir), (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.startsWith(apiRoot))
);
const pattern = (template: string) =>
  new RegExp(`^${template.replaceAll(/\[[^\]]+\]/g, "[^/]+").replaceAll(".", "\\.")}$`);
const called = new Set<string>();
for (const file of clientSources)
  for (const match of readFileSync(file, "utf8").matchAll(/["'`](\/api\/[A-Za-z0-9_\-./[\]${}()]+)/g)) {
    const path = match[1]!
      .replaceAll(/\$\{[^}]*\}/g, "x")
      .split("?")[0]!
      .replace(/\/$/, "");
    for (const route of routes) if (pattern(route.template).test(path)) called.add(`${route.method} ${route.template}`);
  }

const concrete = (template: string) => template.replaceAll(/\[[^\]]+\]/g, "11111111-1111-4111-8111-111111111111");
const handler = vi.fn(async () => Response.json({ ran: true }));
const anonymous = (method: string, template: string) =>
  withRoute(template, handler)(
    new Request(`http://portal.test${concrete(template)}`, { method, ...(method === "GET" ? {} : { body: "{}" }) }),
    undefined
  );

beforeEach(() => {
  handler.mockClear();
  vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

/** Routes a page uses that an anonymous caller may reach, and what each tells them (nothing from the plan). */
const OPEN = [
  "GET /api/health/database", // ok / not ok only (health route tests)
  "GET /api/health/engine", // reachable / not only
  "GET /api/owner/session", // the mode and whether the caller is signed in
  "POST /api/owner/enroll" // checks its own secret
];

describe("owner auth require: the routes the pages call", () => {
  it("finds the state route and the other routes the client code calls", () => {
    expect(called.has("GET /api/state")).toBe(true);
    expect(called.has("GET /api/check-ins/current")).toBe(true);
    expect(called.size).toBeGreaterThan(40);
  });

  it("opens to an anonymous caller only the routes named above", () => {
    const open = [...called].filter((key) => {
      const [method, template] = key.split(" ") as [string, string];
      return (
        ownerAuthExemption(method, template) !== undefined ||
        (method === "GET" && scopesForRoute("GET", template).kind === "public")
      );
    });
    expect(open.sort()).toEqual([...OPEN].sort());
  });

  it("answers every other route the pages call with 401 and runs no handler", async () => {
    for (const key of called) {
      if (OPEN.includes(key)) continue;
      const [method, template] = key.split(" ") as [string, string];
      const response = await anonymous(method, template);
      expect(response.status, key).toBe(401);
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
