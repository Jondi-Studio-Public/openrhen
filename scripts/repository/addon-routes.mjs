import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The page and API route seam. An add-on puts its pages and `route.ts` handlers under `portal/app/(addon)/<id>/`,
 * a route group core never writes. A route group does not appear in a URL, so `(addon)/notes/page.tsx` is served at
 * `/notes`; nothing in the folder name stops it from claiming a URL core already serves, which is what
 * `findCollisions` is for. See `portal/app/(addon)/README.md`.
 */
export const ADDON_GROUP = "(addon)";
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROUTE_FILE = /^(?:page\.(?:tsx|ts|jsx|js|mdx)|route\.(?:ts|js))$/;
const group = /^\(.*\)$/;

const posix = (value) => value.split(sep).join("/");

/** The URL a page or route file under `portal/app` is served at, or null for any other file. */
export function routeUrl(fromApp) {
  const parts = posix(fromApp).split("/");
  if (!ROUTE_FILE.test(parts.pop() ?? "")) return null;
  const segments = parts.filter((part) => !group.test(part));
  // A parallel-route slot (`@name`) shares its parent's URL; it is not a route of its own.
  if (segments.some((part) => part.startsWith("@"))) return null;
  return `/${segments.join("/")}`;
}

function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

/** Every page and route under `portal/app`: its URL, its file, and whether it sits in the add-on group. */
export function listRoutes(root = defaultRoot) {
  const appRoot = resolve(root, "portal/app");
  return files(appRoot).flatMap((absolute) => {
    const fromApp = posix(relative(appRoot, absolute));
    const url = routeUrl(fromApp);
    return url === null
      ? []
      : [{ url, file: `portal/app/${fromApp}`, addon: fromApp.split("/").includes(ADDON_GROUP) }];
  });
}

const dynamic = (segment) => /^\[[^.\]][^\]]*\]$/.test(segment);
const catchAll = (segment) => /^\[\[?\.\.\./.test(segment);

/** Whether two URL patterns can both match one request path (a `[id]` matches any one segment). */
export function urlsOverlap(a, b) {
  const left = a.split("/").slice(1).filter(Boolean);
  const right = b.split("/").slice(1).filter(Boolean);
  for (let index = 0; ; index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined && y === undefined) return true;
    // A catch-all takes the rest, and an optional one (`[[...x]]`) may take nothing.
    if (x !== undefined && catchAll(x)) return y !== undefined || x.startsWith("[[");
    if (y !== undefined && catchAll(y)) return x !== undefined || y.startsWith("[[");
    if (x === undefined || y === undefined) return false;
    if (dynamic(x) || dynamic(y)) continue;
    if (x !== y) return false;
  }
}

/**
 * Whether the router settles two overlapping patterns by specificity: at the first segment where one is a fixed name
 * and the other a `[param]`, the fixed name wins (`/items/new` beats `/items/[id]`), so both can ship. Used between an
 * add-on's own routes only; against a core route any overlap is still refused, because it would change what core serves.
 */
export function staticBeatsDynamic(a, b) {
  const left = a.split("/").slice(1).filter(Boolean);
  const right = b.split("/").slice(1).filter(Boolean);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const x = left[index];
    const y = right[index];
    if (catchAll(x) || catchAll(y)) return false;
    if (dynamic(x) !== dynamic(y)) return true;
    if (!dynamic(x) && x !== y) return false;
  }
  return false;
}

/** Error lines for each add-on route that can answer a URL a core route (or another add-on's route) also answers. */
export function findCollisions(routes) {
  const errors = [];
  const addon = routes.filter((route) => route.addon);
  const core = routes.filter((route) => !route.addon);
  for (const route of addon)
    for (const other of core)
      if (urlsOverlap(route.url, other.url))
        errors.push(`${route.file} serves ${route.url}, which core route ${other.file} (${other.url}) also serves`);
  for (const [index, route] of addon.entries())
    for (const other of addon.slice(index + 1))
      if (route.file !== other.file && urlsOverlap(route.url, other.url) && !staticBeatsDynamic(route.url, other.url))
        errors.push(`${route.file} and ${other.file} both serve ${route.url}`);
  return errors;
}

const WRITER_CLASSES = new Set(["owner", "helper"]);

/**
 * The write paths add-on route handlers register, as data: each `write-paths.json` under `portal/app/(addon)/` maps a
 * repository-relative path (or a folder ending `/`) inside the folder it sits in to `{ class, reason, owners? }`,
 * as `write-path-registry.mjs` does for core. Only `owner` and `helper` are accepted: an add-on that writes a
 * plan-input table must go through `recordStateChange`, and may not claim the exemptions core reserves for itself.
 */
export function loadAddonWriters(root = defaultRoot) {
  const writers = {};
  const errors = [];
  const base = resolve(root, "portal/app", ADDON_GROUP);
  for (const manifest of files(base).filter((file) => file.endsWith(`${sep}write-paths.json`))) {
    const folder = posix(relative(root, dirname(manifest)));
    const source = `${folder}/write-paths.json`;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifest, "utf8"));
    } catch (error) {
      errors.push(`${source} is not valid JSON: ${error.message}`);
      continue;
    }
    const own = `${folder}/`;
    for (const [path, writer] of Object.entries(parsed ?? {})) {
      if (!path.startsWith(own) || path.includes(".."))
        errors.push(`${source} registers ${path}, which is outside the folder it sits in (${own})`);
      else if (!WRITER_CLASSES.has(writer?.class))
        errors.push(`${source} gives ${path} class ${String(writer?.class)}; an add-on writer is owner or helper`);
      else if (typeof writer.reason !== "string" || writer.reason.trim() === "")
        errors.push(`${source} gives ${path} no reason`);
      else writers[path] = writer;
    }
  }
  return { writers, errors };
}
