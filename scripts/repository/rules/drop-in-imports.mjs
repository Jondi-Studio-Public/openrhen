// The proxy drop-in import rule (modularity plan A4; sits beside the bundled-connection rule in check-structure.mjs,
// which it leaves as it is). A drop-in is a folder `integrations/outbound-proxy/src/drop-ins/<id>/` that registers its
// routes and connections with the proxy when the loader imports it. Two things keep that seam one-way:
//
//   1. Out of a drop-in. A relative import that leaves the folder may reach only the host's public modules, the same
//      list a bundled connection gets plus the two registries a drop-in registers with. A drop-in test may also reach
//      the server and its test support, since a route test drives the real server. It never reaches a core connection,
//      another drop-in, or any other file of the proxy.
//   2. Into a drop-in. No file outside a drop-in folder imports one by path; shared code finds a drop-in only through
//      the registry, so the proxy builds and passes its tests with the folder empty or absent. The loader
//      (`src/drop-ins.ts`) lists the folder at run time and so imports by a computed path, which this does not see.
//
// Rule-module convention (see check-structure.mjs): the default export is `(ctx) => string[]`, ctx = { root, args }.
// Imports are read from the syntax tree (rules/ast.mjs), so a string that only looks like an import never counts.
// In a composed tree (core plus an add-on overlay) the add-on's own files are skipped, as every core rule skips them.
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { parse, walk, lineOf } from "./ast.mjs";
import { composedSkips, trackedFiles } from "./vendor-terms.mjs";

const PROXY_SRC = "integrations/outbound-proxy/src";
const DROP_INS = `${PROXY_SRC}/drop-ins`;
const SOURCE = /\.(?:ts|tsx|mts|mjs)$/;
const IS_TEST = /\.test\.[cm]?[jt]sx?$/;

/** The host modules a drop-in may import (without extension). */
export const DROP_IN_HOST_MODULES = [
  "connection-api",
  "connection-registry",
  "cookie-jar",
  "http",
  "ip-address",
  "model-complete",
  "route-registry"
].map((name) => `${PROXY_SRC}/host/${name}`);

/** What a drop-in's own tests may also import: the server they exercise and its support file. */
export const DROP_IN_TEST_MODULES = [`${PROXY_SRC}/server`, `${PROXY_SRC}/server-test-support`];

const stripExtension = (path) => path.replace(/\.(?:js|ts|tsx|mts|mjs)$/, "").replace(/\/index$/, "");

/** Every module specifier a file imports: static imports, re-exports, `import()` and `require()`. */
export function importSpecifiers(file, source) {
  const found = [];
  const { body } = parse(file, source);
  const literal = (node) => (node?.type === "Literal" && typeof node.value === "string" ? node.value : null);
  for (const statement of body) {
    walk(statement, (node) => {
      if (
        node.type === "ImportDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ExportNamedDeclaration"
      ) {
        const value = literal(node.source);
        if (value !== null) found.push({ specifier: value, line: lineOf(source, node) });
      } else if (node.type === "ImportExpression") {
        const value = literal(node.source);
        if (value !== null) found.push({ specifier: value, line: lineOf(source, node) });
      } else if (
        node.type === "CallExpression" &&
        node.callee?.type === "Identifier" &&
        node.callee.name === "require"
      ) {
        const value = literal(node.arguments?.[0]);
        if (value !== null) found.push({ specifier: value, line: lineOf(source, node) });
      }
    });
  }
  return found;
}

/**
 * The failures for one file. `path` is repository-relative with forward slashes; `source` is its text.
 * Pure, so a test can hand it a fixture file.
 */
export function checkDropInImports(path, source) {
  const errors = [];
  if (!SOURCE.test(path) || !path.startsWith(`${PROXY_SRC}/`)) return errors;
  const dropIn = new RegExp(`^${DROP_INS}/([^/]+)/`).exec(path)?.[1];
  if (path === `${PROXY_SRC}/drop-ins.ts`) return errors; // the loader
  const allowed = [...DROP_IN_HOST_MODULES, ...(IS_TEST.test(path) ? DROP_IN_TEST_MODULES : [])];
  for (const { specifier, line } of importSpecifiers(path, source)) {
    if (!specifier.startsWith(".")) continue;
    const target = stripExtension(posix.join(posix.dirname(path), specifier));
    // `./drop-ins.js` is the loader file, the one place shared code may name; only a path inside the folder is a drop-in.
    const targetsDropIn = target.startsWith(`${DROP_INS}/`);
    if (dropIn === undefined) {
      if (targetsDropIn)
        errors.push(
          `${path}:${line} imports ${specifier}, a drop-in. Shared proxy code reaches a drop-in only through the registry (host/route-registry.ts, host/connection-registry.ts), so the proxy builds with the folder absent.`
        );
      continue;
    }
    if (target.startsWith(`${DROP_INS}/${dropIn}/`) || target === `${DROP_INS}/${dropIn}`) continue;
    if (!allowed.includes(target))
      errors.push(
        `${path}:${line} imports ${specifier}, which the drop-in ${dropIn} may not reach. A drop-in may import its own folder and the host modules ${DROP_IN_HOST_MODULES.map((m) => m.slice(PROXY_SRC.length + 1)).join(", ")}${IS_TEST.test(path) ? `, and in a test ${DROP_IN_TEST_MODULES.map((m) => m.slice(PROXY_SRC.length + 1)).join(", ")}` : ""}.`
      );
  }
  return errors;
}

export default function dropInImports(ctx) {
  const root = ctx.root;
  const errors = [];
  const skip = composedSkips(root);
  for (const path of trackedFiles(root)) {
    if (skip.has(path) || !path.startsWith(`${PROXY_SRC}/`) || !SOURCE.test(path)) continue;
    let source;
    try {
      source = readFileSync(resolve(root, path), "utf8");
    } catch {
      continue; // listed by the index but deleted from the working tree
    }
    try {
      errors.push(...checkDropInImports(path, source));
    } catch (error) {
      errors.push(`${path} could not be checked: ${error.message}`);
    }
  }
  return errors;
}
