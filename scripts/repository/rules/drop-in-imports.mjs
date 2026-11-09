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
// Imports are read from the syntax tree (rules/ast.mjs), so a string that only looks like an import never counts. A module
// is named by `import`, a re-export, `import()` (also a no-substitution template), `require()`, `vi.mock()` and its
// relatives, or `import.meta.glob()`; a deep path into the package (`@openrhen/outbound-proxy/src/...`) is followed like
// a relative one, and a computed `import()` is checked by its static prefix (a drop-in may not compute one it cannot
// show stays inside its folder).
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

const PACKAGE = "@openrhen/outbound-proxy";
const PACKAGE_DIR = "integrations/outbound-proxy";
const stripExtension = (path) => path.replace(/\.(?:js|ts|tsx|mts|mjs)$/, "");
const MOCKERS = new Set(["vi", "vitest", "jest"]);
const MOCK_METHODS = new Set([
  "mock",
  "doMock",
  "unmock",
  "doUnmock",
  "importActual",
  "importMock",
  "requireActual",
  "requireMock"
]);
const GLOB_METHODS = new Set(["glob", "globEager"]);

/** Whether a specifier is one this rule follows: a relative path, or a deep path into the proxy package's `src/`. */
const isFollowed = (specifier) => specifier.startsWith(".") || specifier.startsWith(`${PACKAGE}/src/`);

/** A followed specifier as a repository path (no extension; an `/index` is kept), or undefined when it is not followed. */
function targetOf(file, specifier) {
  if (specifier.startsWith(".")) return stripExtension(posix.join(posix.dirname(file), specifier));
  if (specifier.startsWith(`${PACKAGE}/src/`))
    return stripExtension(posix.join(PACKAGE_DIR, specifier.slice(PACKAGE.length + 1)));
  return undefined;
}

/** The text a computed specifier is known to start with: a template's first part, or the left of a `+` chain. */
function staticPrefix(node) {
  if (node?.type === "TemplateLiteral") return node.quasis[0]?.value.cooked ?? "";
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "BinaryExpression" && node.operator === "+") return staticPrefix(node.left);
  return "";
}

/**
 * Every module a file names, as { kind, specifier, line }:
 *   - "static": a string specifier of an import, re-export, `import()`, `require()`, or `vi.mock()` and its relatives
 *     (a no-substitution template counts as a string);
 *   - "computed": an `import()` / `require()` whose specifier is built at run time (`specifier` is its static prefix);
 *   - "glob": an `import.meta.glob()` pattern.
 */
export function importSpecifiers(file, source) {
  const found = [];
  const { body } = parse(file, source);
  const text = (node) =>
    node?.type === "Literal" && typeof node.value === "string"
      ? node.value
      : node?.type === "TemplateLiteral" && node.expressions.length === 0
        ? (node.quasis[0]?.value.cooked ?? null)
        : null;
  const push = (kind, specifier, node) => found.push({ kind, specifier, line: lineOf(source, node) });
  const named = (node, argument) => {
    const value = text(argument);
    if (value !== null) push("static", value, node);
    else if (argument) push("computed", staticPrefix(argument), node);
  };
  for (const statement of body) {
    walk(statement, (node) => {
      if (
        node.type === "ImportDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ExportNamedDeclaration"
      ) {
        const value = text(node.source);
        if (value !== null) push("static", value, node);
      } else if (node.type === "ImportExpression") {
        named(node, node.source);
      } else if (node.type === "CallExpression") {
        const callee = node.callee;
        if (callee?.type === "Identifier" && callee.name === "require") {
          named(node, node.arguments?.[0]);
        } else if (callee?.type === "MemberExpression" && !callee.computed && callee.property?.type === "Identifier") {
          const method = callee.property.name;
          if (callee.object?.type === "Identifier" && MOCKERS.has(callee.object.name) && MOCK_METHODS.has(method)) {
            const value = text(node.arguments?.[0]);
            if (value !== null) push("static", value, node);
          } else if (callee.object?.type === "MetaProperty" && GLOB_METHODS.has(method)) {
            const first = node.arguments?.[0];
            const patterns = first?.type === "ArrayExpression" ? first.elements : [first];
            for (const pattern of patterns) {
              const value = text(pattern);
              if (value !== null && !value.startsWith("!")) push("glob", value, node);
            }
          }
        }
      }
    });
  }
  return found;
}

/** The directory a glob pattern starts from, as a repository path. */
function globBase(file, pattern) {
  const fixed = pattern.split(/[*?[{(]/)[0];
  const directory = fixed.endsWith("/") ? fixed : fixed.slice(0, fixed.lastIndexOf("/") + 1);
  const base = directory.startsWith("/")
    ? posix.join(PACKAGE_DIR, directory)
    : posix.join(posix.dirname(file), directory || ".");
  return base.replace(/\/$/, "");
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
  const hostList = DROP_IN_HOST_MODULES.map((m) => m.slice(PROXY_SRC.length + 1)).join(", ");
  const testList = IS_TEST.test(path)
    ? `, and in a test ${DROP_IN_TEST_MODULES.map((m) => m.slice(PROXY_SRC.length + 1)).join(", ")}`
    : "";
  const own = dropIn === undefined ? undefined : `${DROP_INS}/${dropIn}`;
  const inside = (directory, folder) => `${directory}/`.startsWith(`${folder}/`);
  for (const { kind, specifier, line } of importSpecifiers(path, source)) {
    if (kind === "static") {
      if (!isFollowed(specifier)) continue;
      const raw = targetOf(path, specifier);
      const target = raw.replace(/\/index$/, "");
      // `./drop-ins.js` is the loader file, the one place shared code may name; only a path inside the folder is a drop-in
      // (`./drop-ins/index.js` is one).
      if (own === undefined) {
        if (raw.startsWith(`${DROP_INS}/`))
          errors.push(
            `${path}:${line} imports ${specifier}, a drop-in. Shared proxy code reaches a drop-in only through the registry (host/route-registry.ts, host/connection-registry.ts), so the proxy builds with the folder absent.`
          );
        continue;
      }
      if (inside(raw, own) || raw === own) continue;
      if (!allowed.includes(target))
        errors.push(
          `${path}:${line} imports ${specifier}, which the drop-in ${dropIn} may not reach. A drop-in may import its own folder and the host modules ${hostList}${testList}.`
        );
    } else if (kind === "computed") {
      // The specifier is built at run time. Only its leading text can be checked.
      const followed = specifier.startsWith(".") || specifier.startsWith(`${PACKAGE}/src/`);
      if (!followed) {
        if (own !== undefined && specifier === "")
          errors.push(
            `${path}:${line} imports a computed specifier. A drop-in's imports must be written out (or start with its own folder) so they can be checked.`
          );
        continue;
      }
      const base = targetOf(path, specifier).replace(/\/$/, "");
      if (own === undefined) {
        if (inside(base, DROP_INS))
          errors.push(
            `${path}:${line} imports a computed path that starts at ${specifier}, inside the drop-in folder. Shared proxy code reaches a drop-in only through the registry.`
          );
      } else if (!inside(base, own)) {
        errors.push(
          `${path}:${line} imports a computed path that starts at ${specifier}, which the drop-in ${dropIn} may not reach. A drop-in may import its own folder and the host modules ${hostList}${testList}.`
        );
      }
    } else {
      const base = globBase(path, specifier);
      if (own === undefined) {
        if (inside(base, DROP_INS) || inside(DROP_INS, base))
          errors.push(
            `${path}:${line} globs ${specifier}, which reaches the drop-in folder. Shared proxy code reaches a drop-in only through the registry.`
          );
      } else if (!inside(base, own)) {
        errors.push(
          `${path}:${line} globs ${specifier}, which leaves the drop-in ${dropIn}. A drop-in may import its own folder and the host modules ${hostList}${testList}.`
        );
      }
    }
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
