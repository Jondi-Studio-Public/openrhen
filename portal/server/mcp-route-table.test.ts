import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadedDropIns } from "./drop-ins";
import { matchRoute } from "./mcp-cli-runner";
import { MCP_ROUTE_TABLE } from "./mcp-route-table";

/**
 * The remote endpoint's in-process CLI can reach exactly the routes in the generated table
 * (`pnpm --filter @openrhen/portal routes:table`). Adding or removing an API route without regenerating it fails
 * here, which is what keeps "any URL outside the table is refused" the same set as "every API route".
 */
const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const apiRoot = join(portalRoot, "app", "api");

function routeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return entry === "route.ts" ? [path] : [];
  });
}

const templateOf = (file: string) => `/api/${relative(apiRoot, join(file, "..")).split(sep).join("/")}`;
/** A route file marked `// @drop-in <name>` is registered by that drop-in's `route-table.ts`, not by the core table. */
const dropInOf = (file: string) => /^\/\/ @drop-in (\S+)\r?\n/.exec(readFileSync(file, "utf8"))?.[1];

const files = routeFiles(apiRoot);
const templates = files.map(templateOf).sort();
const coreTemplates = files
  .filter((file) => dropInOf(file) === undefined)
  .map(templateOf)
  .sort();

/**
 * An add-on's API routes live in the `(addon)` route group (not part of the URL) and join the table when the
 * add-on's drop-in calls `registerMcpRoutes`, so the core table names none of them.
 */
const addonTemplates = routeFiles(join(portalRoot, "app", "(addon)"))
  .map(
    (file) =>
      `/${relative(join(portalRoot, "app", "(addon)"), join(file, ".."))
        .split(sep)
        .join("/")}`
  )
  .filter((template) => template.startsWith("/api/"));

describe("the route table", () => {
  it("lists every add-on API route, registered by the add-on's drop-in", () => {
    const missing = addonTemplates.filter((template) => !Object.hasOwn(MCP_ROUTE_TABLE, template));
    expect(missing, "call registerMcpRoutes from the add-on's drop-ins/<id>/register.ts").toEqual([]);
  });

  it("finds the route files", () => {
    expect(templates.length).toBeGreaterThan(80);
  });

  it("has an entry for every API route file", () => {
    const missing = templates.filter((template) => !Object.hasOwn(MCP_ROUTE_TABLE, template));
    expect(missing, "run `pnpm --filter @openrhen/portal routes:table`").toEqual([]);
  });

  it("names no route that no longer exists", () => {
    const existing = new Set([...templates, ...addonTemplates]);
    expect(Object.keys(MCP_ROUTE_TABLE).filter((template) => !existing.has(template))).toEqual([]);
  });

  it("imports each route by a literal path the bundler can follow", () => {
    // Prettier wraps a long entry onto two lines, so compare with the whitespace collapsed.
    const source = [
      readFileSync(join(portalRoot, "server", "mcp-route-table.ts"), "utf8"),
      readFileSync(join(portalRoot, "server", "private", "mcp-route-table.ts"), "utf8")
    ]
      .join("\n")
      .replace(/\s+/g, " ");
    for (const template of coreTemplates)
      expect(source, template).toContain(`"${template}": () => import("@/app${template}/route")`);
    expect(source.match(/import\(/g)).toHaveLength(coreTemplates.length);
  });

  it("keeps the routes of a drop-in out of the core table and in the drop-in's own", () => {
    const dropInTemplates = templates.filter((template) => !coreTemplates.includes(template));
    const dropIns = new Set(files.map(dropInOf).filter((name) => name !== undefined));
    for (const name of dropIns) expect(loadedDropIns, `drop-ins/${name}/register.ts`).toContain(name);
    for (const name of dropIns) {
      const source = readFileSync(join(portalRoot, "drop-ins", name, "route-table.ts"), "utf8").replace(/\s+/g, " ");
      for (const template of files.filter((file) => dropInOf(file) === name).map(templateOf))
        expect(source, template).toContain(`"${template}": () => import("@/app${template}/route")`);
    }
    expect(dropInTemplates.length === 0 || dropIns.size > 0).toBe(true);
  });

  it("loads the handlers of a static and a dynamic route", async () => {
    const state = await MCP_ROUTE_TABLE["/api/state"]!();
    expect(typeof state.GET).toBe("function");
    const batch = await MCP_ROUTE_TABLE["/api/imports/[id]"]!();
    expect(typeof batch.GET).toBe("function");
  });

  it("holds nothing outside the API: not the MCP endpoint, the OAuth routes or the discovery documents", () => {
    for (const template of Object.keys(MCP_ROUTE_TABLE)) expect(template.startsWith("/api/"), template).toBe(true);
  });
});

describe("matching a path to a route", () => {
  const every = Object.keys(MCP_ROUTE_TABLE);

  it("finds the route behind each template, filling every dynamic segment", () => {
    for (const template of every) {
      const path = template.replace(/\[([^\]]+)\]/g, (_, name: string) => `value-${name}`);
      const match = matchRoute(path);
      expect(match, template).toBeDefined();
      // A more specific static template may win for a made-up value; the one that wins must still fit the path.
      expect(match!.template.split("/").length).toBe(template.split("/").length);
    }
  });

  it("passes the dynamic segments on, decoded", () => {
    expect(matchRoute("/api/imports/abc-123")).toEqual({ template: "/api/imports/[id]", params: { id: "abc-123" } });
    expect(matchRoute("/api/deliverable-source-files/f%2F1")).toEqual({
      template: "/api/deliverable-source-files/[id]",
      params: { id: "f/1" }
    });
    expect(matchRoute("/api/things/c1/sessions/s9/revoke", ["/api/things/[id]/sessions/[sessionId]/revoke"])).toEqual({
      template: "/api/things/[id]/sessions/[sessionId]/revoke",
      params: { id: "c1", sessionId: "s9" }
    });
  });

  it("prefers a static segment to a dynamic one", () => {
    expect(matchRoute("/api/imports/extract")?.template).toBe("/api/imports/extract");
    expect(matchRoute("/api/imports/preview")?.template).toBe("/api/imports/preview");
    expect(matchRoute("/api/plan-map/links/bulk")?.template).toBe("/api/plan-map/links/bulk");
    expect(matchRoute("/api/plan-map/links/l1")?.template).toBe("/api/plan-map/links/[id]");
    expect(matchRoute("/api/photo-checkins/mode")?.template).toBe("/api/photo-checkins/mode");
    expect(matchRoute("/api/things/messages", ["/api/things/[id]", "/api/things/messages"])?.template).toBe(
      "/api/things/messages"
    );
    // Whichever order the templates are given in.
    const templates = ["/api/a/[id]", "/api/a/static", "/api/[x]/static"];
    expect(matchRoute("/api/a/static", templates)?.template).toBe("/api/a/static");
    expect(matchRoute("/api/a/static", [...templates].reverse())?.template).toBe("/api/a/static");
    expect(matchRoute("/api/b/static", templates)?.template).toBe("/api/[x]/static");
  });

  it("matches nothing else", () => {
    for (const path of [
      "/",
      "/mcp",
      "/oauth/token",
      "/.well-known/oauth-protected-resource",
      "/api",
      "/api/nope",
      "/api/state/",
      "/api/state/extra",
      "/api//state",
      "/api/imports//commit",
      "/api/imports/%E0%A4%A/commit"
    ])
      expect(matchRoute(path), path).toBeUndefined();
  });
});
