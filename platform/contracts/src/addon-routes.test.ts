import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The agent route table for an add-on's `route.ts` handlers (the page and API route seam). An add-on registers
 * through the contracts registry before the table is read; a route it does not register stays default-deny.
 * Each test loads a fresh copy of the modules, so the registry starts empty and the stock table is what it is
 * with no add-on.
 */
async function fresh() {
  vi.resetModules();
  const registry = await import("./extensions.js");
  const routes = await import("./agent-routes.js");
  return { registry, routes };
}

describe("add-on routes in the agent route table", () => {
  it("refuses an add-on route that is not registered", async () => {
    const { routes } = await fresh();
    expect(routes.scopesForRoute("GET", "/api/example-addon/notes")).toMatchObject({
      kind: "refused",
      reason: "unclassified"
    });
    expect(routes.scopesForRoute("POST", "/api/example-addon/notes")).toMatchObject({
      kind: "refused",
      reason: "unclassified"
    });
    expect(routes.classifiedRoutes().some((key) => key.includes("example-addon"))).toBe(false);
  });

  describe("once the add-on registers its routes", () => {
    let routes: Awaited<ReturnType<typeof fresh>>["routes"];
    beforeAll(async () => {
      vi.resetModules();
      const registry = await import("./extensions.js");
      registry.registerContractsExtension({
        id: "example-addon",
        knownScopes: ["read:example-notes", "write:example-notes"],
        toolScopes: { "example-notes": ["write:example-notes"] },
        routes: {
          readRules: { "/api/example-addon/notes": "read:example-notes" },
          fixedWrites: { "POST /api/example-addon/notes": { tool: "example-notes" } },
          ownerRoutes: { "DELETE /api/example-addon/notes": "Clearing the notes" },
          ownerReads: ["/api/example-addon/export"],
          workerRoutes: ["/api/example-addon/tick"]
        }
      });
      // The tables are read when agent-routes loads, so it loads only now that the extension is registered.
      routes = await import("./agent-routes.js");
    });

    it("lists them for the classification test in the portal", () => {
      expect(routes.classifiedRoutes()).toEqual(
        expect.arrayContaining([
          "GET /api/example-addon/notes",
          "POST /api/example-addon/notes",
          "DELETE /api/example-addon/notes",
          "GET /api/example-addon/export"
        ])
      );
    });

    it("lets a token holding the scope read, and asks for it otherwise", () => {
      expect(routes.scopesForRoute("GET", "/api/example-addon/notes")).toEqual({
        kind: "scopes",
        scopes: ["read:example-notes"]
      });
    });

    it("keeps an owner-only write and an owner-only read away from agents", () => {
      expect(routes.scopesForRoute("DELETE", "/api/example-addon/notes")).toMatchObject({
        kind: "refused",
        reason: "owner-only"
      });
      expect(routes.scopesForRoute("GET", "/api/example-addon/export")).toMatchObject({
        kind: "refused",
        reason: "owner-only"
      });
    });

    it("turns a fixed write into the call it is", () => {
      expect(routes.scopesForRoute("POST", "/api/example-addon/notes")).toMatchObject({
        kind: "scopes",
        call: { tool: "example-notes" }
      });
    });

    it("lets the worker call a registered worker route, and nothing else of the add-on's", () => {
      expect(routes.workerRoute("POST", "/api/example-addon/tick")).toBe(true);
      expect(routes.workerRoute("POST", "/api/example-addon/notes")).toBe(false);
    });

    it("leaves a route the add-on did not register refused", () => {
      expect(routes.scopesForRoute("GET", "/api/example-addon/other")).toMatchObject({ reason: "unclassified" });
    });
  });
});
