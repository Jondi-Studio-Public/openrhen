import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import "@/server/drop-ins";
import { classifiedRoutes, ownerAuthExemptRoutes } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";

/**
 * Default deny needs a table that stays complete: every method a route file exports must be classified in
 * `platform/contracts/src/agent-routes.ts`, either as something an agent may call or as owner/device/feature
 * only, and the table may not name a route that no longer exists. Adding a route without classifying it fails here.
 */
const appRoot = fileURLToPath(new URL("../app", import.meta.url));
// The API, plus the few public protocol routes outside it: the remote MCP endpoint and its OAuth documents.
const routeRoots = ["api", "mcp", "oauth", ".well-known"].map((name) => join(appRoot, name));

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return entry === "route.ts" ? [path] : [];
  });
}

const METHOD = /export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g;

const found = routeRoots.flatMap(routeFiles).flatMap((file) => {
  const source = readFileSync(file, "utf8");
  const template = `/${relative(appRoot, join(file, "..")).split(sep).join("/")}`;
  const withRouteName = /withRoute(?:<[^(]*>)?\(\s*"([^"]+)"/.exec(source)?.[1];
  return [...source.matchAll(METHOD)].map((match) => ({ key: `${match[1]} ${template}`, template, withRouteName }));
});

describe("agent route classification", () => {
  it("finds the route files", () => {
    expect(found.length).toBeGreaterThan(80);
  });

  it("classifies every write and read a route file exports", () => {
    const classified = new Set(classifiedRoutes());
    const missing = found.filter((route) => !classified.has(route.key)).map((route) => route.key);
    expect(missing, "classify these in platform/contracts/src/agent-routes.ts").toEqual([]);
  });

  it("names no route that does not exist", () => {
    const existing = new Set(found.map((route) => route.key));
    const stale = classifiedRoutes().filter((key) => !existing.has(key));
    expect(stale).toEqual([]);
  });

  it("names no owner-auth exemption for a route that does not exist", () => {
    const existing = new Set(found.map((route) => route.key));
    expect(ownerAuthExemptRoutes().filter((key) => !existing.has(key))).toEqual([]);
  });

  it("wraps each route in withRoute under its own template, which is what enforcement keys on", () => {
    const wrong = found.filter((route) => route.withRouteName !== route.template).map((route) => route.key);
    expect(wrong).toEqual([]);
  });
});
