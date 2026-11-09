// Literal-connection-branch ratchet (modularity plan A4; metric V7). Core decides by capability and manifest, never by
// a provider's name, so a core decision point that compares a value against the id of a connection or activity source
// that a manifest or an add-on registers is a hit. The count is held at or below a per-lane pending shard
// (scripts/repository/pending/literal-connection-branch/<lane>.json): the shards only shrink, and at zero they are
// deleted. Same conventions as vendor-terms.mjs (lanes, `--fix-pending`, base comparison, composed trees).
//
// Rule-module convention (see check-structure.mjs): the default export is `(ctx) => string[]` where
// ctx = { root, args, base?, env? } and each returned string is one failure.
//
// What counts as a hit (read from the syntax tree, rules/ast.mjs, in non-test core code):
//   - `a === ID`, `a !== ID`, `a == ID`, `a != ID` with ID on either side; `Object.is(a, ID)`; `a.localeCompare(ID)`;
//   - `switch (a) { case ID: }`;
//   - `x.includes(ID)`, `x.has(ID)`, `x.indexOf(ID)`, `x.startsWith(ID)` / `endsWith` (also a key prefix such as
//     `"<id>:event:"` or `"<id>_"`), and `[.., ID, ..].includes(x)` / `new Set([.., ID, ..]).has(x)`;
//   - a `const`/`let` array or Set that lists an ID (a table of provider ids is a branch written as data);
//   - a lookup in an object or Map keyed by provider ids: `T[x]`, `x in T`, `Object.hasOwn(T, x)`, `T.get(x)`, `T.has(x)`
//     (the registry `ACTIVITY_SOURCES` itself is read from, so indexing it is not a hit);
//   - a regex that names an id and tests a value named like an id, key or source: `/id/.test(x)`, `x.match(/id/)`;
//   - SQL text (a template or string) that compares a provider, source or connection column with an id:
//     `provider = 'ID'`, `source IN ('ID', ..)`, `provider LIKE 'ID:%'`, or `provider = ${CONST}` with CONST bound to one.
// ID is a string literal, a no-substitution template, a `const`, `let` or default parameter bound to a string (at module
// level or in a function, also through an import, a re-export or an `import * as ns`), or a string member of an object
// (`IDS.calendar`, also `as const`). Names resolve through the scope chain, so a parameter or local that shadows a
// module const is not the id. Binding a literal to a name therefore does not hide the comparison.
//
// Provider ids are read from the code, never listed here: the `id` of every manifest-shaped object (it holds `id`,
// `capabilities` and `secrets`), the keys of `ACTIVITY_SOURCES`, and the keys an extension gives to `sourceIds` or
// `activitySources`, minus `CORE_SOURCES` (platform/contracts/src/connections/core-sources.ts): the sources core owns,
// which core may branch on. Neutral ids (the example connections) count too.
//
// Not scanned: tests and fixtures, `scripts/`, and provider-owned code (a connection or drop-in of the outbound
// proxy), where a provider naturally names itself. In a composed tree (core plus an add-on overlay) the overlay's own
// files are skipped, but its manifests still add ids, so core may not branch on an add-on's id either.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lineOf, parse, walk } from "./ast.mjs";
import {
  composedSkips,
  hasHead,
  isTest,
  laneOf,
  readJson,
  resolveBase,
  showAtBase,
  gitOk,
  trackedFiles
} from "./vendor-terms.mjs";

const CONFIG = "scripts/repository/rules/vendor-terms.json";
const PENDING = "scripts/repository/pending/literal-connection-branch";
const CORE_SOURCES_FILE = "platform/contracts/src/connections/core-sources.ts";
const METRIC = "sites";
const FIX = "run `pnpm structure:check --fix-pending`";
const HOW =
  "Core names no provider: resolve the connection through the registry (a capability, or a field of its manifest) instead of comparing against its id. If the name is a source core itself owns, add it to CORE_SOURCES in platform/contracts/src/connections/core-sources.ts.";

const SOURCE = /\.(?:ts|tsx|mts|mjs)$/;
const COMPARE = new Set(["===", "!==", "==", "!="]);
const MEMBERSHIP = new Set(["includes", "has", "indexOf"]);

const isScanned = (path) =>
  SOURCE.test(path) &&
  !/\.d\.[cm]?ts$/.test(path) &&
  !path.startsWith("scripts/") &&
  !/(^|\/)(node_modules|dist|\.next|\.vinext|drizzle|fixtures|__tests__)\//.test(path) &&
  !isTest(path) &&
  !/\.spec\.|-fixtures?\.|test-support\./.test(path);

/** Provider-owned code: the proxy's connections and drop-ins name their own provider by design. */
const isProviderOwned = (path) =>
  /^integrations\/outbound-proxy\/src\/(?:connections|drop-ins)\//.test(path) ||
  path.startsWith("portal/app/(addon)/") ||
  path.startsWith("addons/");

const unwrap = (node) => {
  let current = node;
  while (
    current &&
    [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "TSTypeAssertion",
      "ParenthesizedExpression"
    ].includes(current.type)
  )
    current = current.expression;
  return current;
};

/** Whether an expression is named like a source: its last identifier, through `.`, `?.` and a call, says source/provider. */
function namedLikeSource(node) {
  let current = unwrap(node);
  while (current?.type === "ChainExpression" || current?.type === "CallExpression")
    current = unwrap(current.type === "ChainExpression" ? current.expression : current.callee);
  const name =
    current?.type === "Identifier"
      ? current.name
      : current?.type === "MemberExpression" && !current.computed
        ? current.property.name
        : undefined;
  return name !== undefined && /source|provider/i.test(name);
}

// --- scopes -----------------------------------------------------------------------------------------------------
// A name resolves through the scope chain, innermost first, so a parameter or local that shadows a module const is
// not mistaken for it. A binding is { t: "str", v }, { t: "obj", members, keys }, { t: "list", items },
// { t: "map", keys }, { t: "import", imported, ns } or { t: "opaque" } (declared, value unknown).
const OPAQUE = { t: "opaque" };

class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.vars = new Map();
  }
  lookup(name) {
    for (let scope = this; scope; scope = scope.parent) if (scope.vars.has(name)) return scope.vars.get(name);
    return undefined;
  }
}

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

const keyName = (property, resolveValue) => {
  if (property.type !== "Property") return undefined;
  if (!property.computed) {
    if (property.key.type === "Identifier") return property.key.name;
    if (property.key.type === "Literal" && typeof property.key.value === "string") return property.key.value;
    return undefined;
  }
  return resolveValue(property.key);
};

/** The binding an initializer stands for. `tables` resolves names imported from other files (null while exporting). */
function bindingOf(init, scope, tables) {
  const n = unwrap(init);
  if (!n) return OPAQUE;
  const text = stringOf(n, scope, tables);
  if (text !== undefined) return { t: "str", v: text };
  const value = (node) => stringOf(node, scope, tables);
  if (n.type === "ObjectExpression") {
    const members = new Map();
    const keys = new Set();
    for (const property of n.properties) {
      const key = keyName(property, value);
      if (key === undefined) continue;
      keys.add(key);
      const member = value(property.value);
      if (member !== undefined) members.set(key, member);
    }
    return { t: "obj", members, keys };
  }
  if (n.type === "ArrayExpression")
    return { t: "list", items: n.elements.map((element) => (element ? value(element) : undefined)) };
  if (n.type === "NewExpression" && n.callee.type === "Identifier") {
    const first = unwrap(n.arguments?.[0]);
    if (n.callee.name === "Set" && first?.type === "ArrayExpression")
      return { t: "list", items: first.elements.map((element) => (element ? value(element) : undefined)) };
    if (n.callee.name === "Map" && first?.type === "ArrayExpression") return { t: "map", keys: mapKeys(first, value) };
  }
  if (
    n.type === "CallExpression" &&
    unwrap(n.callee)?.type === "MemberExpression" &&
    unwrap(n.callee).object?.name === "Object" &&
    unwrap(n.callee).property?.name === "freeze" &&
    n.arguments?.[0]
  )
    return bindingOf(n.arguments[0], scope, tables);
  return OPAQUE;
}

const mapKeys = (arrayNode, value) =>
  arrayNode.elements
    .map((pair) => {
      const entry = unwrap(pair);
      return entry?.type === "ArrayExpression" && entry.elements[0] ? value(entry.elements[0]) : undefined;
    })
    .filter((key) => key !== undefined);

/** Declare every name a binding pattern introduces. A literal default (`id, A = "x"`) is the name's value. */
function declarePattern(pattern, scope, tables) {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      scope.vars.set(pattern.name, OPAQUE);
      break;
    case "AssignmentPattern":
      declarePattern(pattern.left, scope, tables);
      if (pattern.left.type === "Identifier") {
        const text = stringOf(pattern.right, scope, tables);
        if (text !== undefined) scope.vars.set(pattern.left.name, { t: "str", v: text });
      }
      break;
    case "ObjectPattern":
      for (const property of pattern.properties) declarePattern(property.value ?? property.argument, scope, tables);
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) declarePattern(element, scope, tables);
      break;
    case "RestElement":
      declarePattern(pattern.argument, scope, tables);
      break;
    case "TSParameterProperty":
      declarePattern(pattern.parameter, scope, tables);
      break;
    default:
  }
}

/** `var` declarations hoist to the function: every `var` name under `node`, not entering nested functions. */
function hoistVars(node, scope, tables) {
  walk(node, (child) => {
    if (FUNCTIONS.has(child.type) || child.type === "ClassDeclaration") return false;
    if (child.type === "VariableDeclaration" && child.kind === "var")
      for (const declarator of child.declarations) declarePattern(declarator.id, scope, tables);
    return true;
  });
}

/** Declare the names a statement list introduces, then give the plain `const x = <value>` ones their value in order. */
function declareStatements(statements, scope, tables) {
  const declarations = [];
  for (const raw of statements) {
    const statement =
      (raw.type === "ExportNamedDeclaration" || raw.type === "ExportDefaultDeclaration") && raw.declaration
        ? raw.declaration
        : raw;
    if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations) {
        declarePattern(declarator.id, scope, tables);
        declarations.push(declarator);
      }
    } else if (
      (statement.type === "FunctionDeclaration" ||
        statement.type === "ClassDeclaration" ||
        statement.type === "TSEnumDeclaration") &&
      statement.id
    )
      scope.vars.set(statement.id.name, OPAQUE);
  }
  for (const declarator of declarations)
    if (declarator.id.type === "Identifier" && declarator.init)
      scope.vars.set(declarator.id.name, bindingOf(declarator.init, scope, tables));
}

/** The module scope of a bound file: its imports first, then its own declarations. */
function moduleScope(info, tables) {
  const scope = new Scope();
  for (const [local, binding] of info.imports) scope.vars.set(local, binding);
  declareStatements(info.body, scope, tables);
  return scope;
}

/** Pass 1 on one file: parse it, and note what it imports and exports. */
function bindFile(path, source) {
  const parsed = parse(path, source);
  const info = { path, source, body: parsed.body, imports: new Map(), exports: [], scope: null };
  for (const statement of parsed.body) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.type === "ImportSpecifier")
          info.imports.set(specifier.local.name, {
            t: "import",
            imported: specifier.imported.name ?? specifier.imported.value,
            ns: false
          });
        else if (specifier.type === "ImportNamespaceSpecifier")
          info.imports.set(specifier.local.name, { t: "import", imported: undefined, ns: true });
      }
    } else if (statement.type === "ExportNamedDeclaration") {
      if (statement.declaration?.type === "VariableDeclaration") {
        for (const declarator of statement.declaration.declarations)
          if (declarator.id.type === "Identifier")
            info.exports.push({ exported: declarator.id.name, local: declarator.id.name });
      } else if (statement.source) {
        // `export { A as B } from "./x"`: B is whatever A is in the file it comes from.
        for (const specifier of statement.specifiers ?? []) {
          const name = specifier.local.name ?? specifier.local.value;
          info.exports.push({
            exported: specifier.exported.name ?? specifier.exported.value,
            reexport: { t: "import", imported: name, ns: false }
          });
        }
      } else {
        for (const specifier of statement.specifiers ?? [])
          info.exports.push({
            exported: specifier.exported.name ?? specifier.exported.value,
            local: specifier.local.name ?? specifier.local.value
          });
      }
    }
  }
  return info;
}

const EMPTY_TABLES = { strings: new Map(), objects: new Map() };

/** What is exported by name across the scanned files; a name two files give different values is ambiguous (null). */
function exportTables(infos, previous) {
  const strings = new Map();
  const objects = new Map();
  const add = (table, name, next) => {
    if (!table.has(name)) table.set(name, next);
    else if (JSON.stringify(table.get(name), replacer) !== JSON.stringify(next, replacer)) table.set(name, null);
  };
  for (const info of infos) {
    for (const entry of info.exports) {
      let binding = entry.reexport ?? info.scope?.vars.get(entry.local);
      if (binding?.t === "import")
        binding = binding.ns
          ? undefined
          : previous.strings.has(binding.imported)
            ? { t: "str", v: previous.strings.get(binding.imported) }
            : previous.objects.has(binding.imported)
              ? previous.objects.get(binding.imported)
              : undefined;
      if (!binding) continue;
      if (binding.t === "str" && binding.v !== null) add(strings, entry.exported, binding.v);
      else if (binding.t === "obj") add(objects, entry.exported, binding);
    }
  }
  for (const [name, value] of strings) if (value === null) strings.delete(name);
  for (const [name, value] of objects) if (value === null) objects.delete(name);
  return { strings, objects };
}

function replacer(_key, value) {
  if (value instanceof Map) return [...value];
  if (value instanceof Set) return [...value];
  return value;
}

/** Bind every file's module scope against the export tables, until the tables stop changing (re-export chains). */
function resolveModules(infos) {
  let tables = EMPTY_TABLES;
  for (let round = 0; round < 6; round += 1) {
    for (const info of infos) info.scope = moduleScope(info, tables);
    const next = exportTables(infos, tables);
    const same = JSON.stringify(next, replacer) === JSON.stringify(tables, replacer);
    tables = next;
    if (same) break;
  }
  for (const info of infos) info.scope = moduleScope(info, tables);
  return tables;
}

/** The string a node stands for, or undefined. `tables` resolves an imported name; null while binding a file. */
function stringOf(node, scope, tables) {
  const n = unwrap(node);
  if (!n) return undefined;
  if (n.type === "Literal") return typeof n.value === "string" ? n.value : undefined;
  if (n.type === "TemplateLiteral") {
    let text = n.quasis[0]?.value.cooked ?? undefined;
    for (let i = 0; i < n.expressions.length && text !== undefined; i += 1) {
      const part = stringOf(n.expressions[i], scope, tables);
      const next = n.quasis[i + 1]?.value.cooked;
      text = part === undefined || next == null ? undefined : text + part + next;
    }
    return text;
  }
  if (n.type === "BinaryExpression" && n.operator === "+") {
    const left = stringOf(n.left, scope, tables);
    const right = left === undefined ? undefined : stringOf(n.right, scope, tables);
    return right === undefined ? undefined : left + right;
  }
  if (n.type === "Identifier") {
    const binding = scope?.lookup(n.name);
    if (binding?.t === "str") return binding.v;
    if (binding?.t === "import" && !binding.ns && tables) return tables.strings.get(binding.imported) ?? undefined;
    return undefined;
  }
  if (n.type === "MemberExpression" && unwrap(n.object)?.type === "Identifier") {
    let key;
    if (!n.computed && n.property.type === "Identifier") key = n.property.name;
    else if (n.computed && n.property.type === "Literal" && typeof n.property.value === "string")
      key = n.property.value;
    if (key === undefined) return undefined;
    const binding = scope?.lookup(unwrap(n.object).name);
    if (binding?.t === "obj") return binding.members.get(key);
    if (binding?.t === "import" && tables)
      return binding.ns
        ? (tables.strings.get(key) ?? undefined)
        : tables.objects.get(binding.imported)?.members.get(key);
  }
  return undefined;
}

/** The table (object or Map) an expression stands for, as { keys: Set }, or undefined. */
function tableOf(node, scope, tables) {
  const n = unwrap(node);
  if (!n) return undefined;
  if (n.type === "Identifier") {
    const binding = scope?.lookup(n.name);
    if (binding?.t === "obj") return { keys: binding.keys };
    if (binding?.t === "map") return { keys: new Set(binding.keys) };
    if (binding?.t === "import" && !binding.ns && tables) {
      const object = tables.objects.get(binding.imported);
      return object ? { keys: object.keys } : undefined;
    }
    return undefined;
  }
  if (n.type === "ObjectExpression" || n.type === "NewExpression" || n.type === "CallExpression") {
    const binding = bindingOf(n, scope, tables);
    if (binding.t === "obj") return { keys: binding.keys };
    if (binding.t === "map") return { keys: new Set(binding.keys) };
  }
  return undefined;
}

const callName = (call) => {
  const callee = unwrap(call.callee);
  return callee?.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier"
    ? callee.property.name
    : undefined;
};

/** The elements of an array literal, or of `new Set([...])` / `new Set` over one. */
function listElements(node) {
  const n = unwrap(node);
  if (n?.type === "ArrayExpression") return n.elements.filter(Boolean);
  if (n?.type === "NewExpression" && n.callee.type === "Identifier" && n.callee.name === "Set") {
    const first = unwrap(n.arguments?.[0]);
    if (first?.type === "ArrayExpression") return first.elements.filter(Boolean);
  }
  return null;
}

function sourcesOf(arrayNode) {
  const array = unwrap(arrayNode);
  return array?.type === "ArrayExpression"
    ? array.elements.map((element) => (element?.type === "Literal" ? element.value : undefined))
    : [];
}

/**
 * The provider ids registered in the scanned files, minus the sources core owns: { connections, sources }. A connection
 * id (a manifest's `id`) is distinctive; an activity source name can be an ordinary word (a view called "timeline"), so
 * a source name counts only against a value that is named like a source (see `findHits`).
 */
export function collectProviderIds(infos, tables, coreSources) {
  const ids = new Set();
  const sourceNames = new Set();
  for (const info of infos) {
    const scope = info.scope ?? moduleScope(info, tables);
    const resolveValue = (node) => stringOf(node, scope, tables);
    const addKeys = (objectNode) => {
      const object = unwrap(objectNode);
      if (object?.type !== "ObjectExpression") return;
      for (const property of object.properties) {
        const key = keyName(property, resolveValue);
        if (key !== undefined) sourceNames.add(key);
      }
    };
    for (const statement of info.body) {
      walk(statement, (node) => {
        if (node.type === "ObjectExpression") {
          const names = new Set(node.properties.map((property) => keyName(property, resolveValue)));
          if (names.has("id") && names.has("capabilities") && names.has("secrets")) {
            const idProperty = node.properties.find((property) => keyName(property, resolveValue) === "id");
            const id = resolveValue(idProperty.value);
            if (id !== undefined) ids.add(id);
          }
        } else if (node.type === "VariableDeclarator" && node.id?.name === "ACTIVITY_SOURCES" && node.init) {
          addKeys(node.init);
        } else if (
          node.type === "Property" &&
          !node.computed &&
          node.key?.type === "Identifier" &&
          (node.key.name === "activitySources" || node.key.name === "sourceIds")
        ) {
          addKeys(node.value);
        }
      });
    }
  }
  for (const core of coreSources) {
    ids.delete(core);
    sourceNames.delete(core);
  }
  for (const id of ids) sourceNames.delete(id);
  return { connections: ids, sources: sourceNames };
}

// --- SQL --------------------------------------------------------------------------------------------------------
// SQL is a string, so `WHERE provider='x'` is a branch the syntax tree shows only as text. A string or template whose
// text compares a provider/source/connection column with a quoted value (`=`, `<>`, `IN (...)`, `LIKE`) is scanned.
const COLUMN = String.raw`[a-z_]*(?:provider|source|connection)[a-z_]*`;
const SQL_COMPARE = new RegExp(String.raw`\b(${COLUMN})"?\s*(?:=|<>|!=|~~\*?|(?:NOT\s+)?I?LIKE)\s*'([^']*)'`, "gi");
const SQL_IN = new RegExp(String.raw`\b(${COLUMN})"?\s+(?:NOT\s+)?IN\s*\(([^)]*)\)`, "gi");
const SQL_REVERSED = new RegExp(String.raw`'([^']*)'\s*(?:=|<>|!=)\s*(?:[a-z_]+\.)?(${COLUMN})\b`, "gi");

/** The SQL text of a template or string, with each interpolation that resolves to a string put in as a quoted value. */
function sqlText(node, scope, tables) {
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : undefined;
  let text = "";
  node.quasis.forEach((quasi, index) => {
    text += quasi.value.cooked ?? "";
    const expression = node.expressions[index];
    if (!expression) return;
    const part = stringOf(expression, scope, tables);
    const quoted = text.endsWith("'") && (node.quasis[index + 1]?.value.cooked ?? "").startsWith("'");
    text += part === undefined ? "$" : quoted ? part : `'${part}'`;
  });
  return text;
}

/** [{ column, value, offset }] for every provider/source/connection column compared with a quoted value in SQL text. */
function sqlComparisons(text) {
  const found = [];
  const lineAt = (index) => text.slice(0, index).split("\n").length - 1;
  for (const match of text.matchAll(SQL_COMPARE))
    found.push({ column: match[1], value: match[2], offset: lineAt(match.index) });
  for (const match of text.matchAll(SQL_REVERSED))
    found.push({ column: match[2], value: match[1], offset: lineAt(match.index) });
  for (const match of text.matchAll(SQL_IN))
    for (const value of match[2].matchAll(/'([^']*)'/g))
      found.push({ column: match[1], value: value[1], offset: lineAt(match.index) });
  return found;
}

const SEPARATORS = /[:_./%-]+$/;
const regexMentions = (pattern, ids) => {
  const lower = pattern.toLowerCase();
  for (const id of ids) if (id.length >= 3 && lower.includes(id.toLowerCase())) return id;
  return undefined;
};

/** Every hit in one bound file: [{ line, id }]. */
export function findHits(info, tables, providers) {
  const hits = [];
  const add = (node, id) => hits.push({ line: lineOf(info.source, node), id });
  const connections = providers.connections;
  // `other` is what the value is compared with. A connection id always counts; a source name counts only against a
  // value whose name says it is a source (`source`, `link.provider`, `UNVERIFIED_SOURCES`). `prefix` also accepts a
  // key prefix such as `"<id>:event:"` or `"<id>_"`, for startsWith and LIKE.
  const named = (value, other, prefix = false) => {
    if (value === undefined) return undefined;
    if (connections.has(value)) return value;
    if (prefix) {
      const trimmed = value.replace(SEPARATORS, "");
      if (connections.has(trimmed)) return trimmed;
      for (const id of connections)
        if (value.startsWith(`${id}:`) || value.startsWith(`${id}/`) || value.startsWith(`${id}_`)) return id;
    }
    return providers.sources.has(value) && other !== null && namedLikeSource(other) ? value : undefined;
  };
  const tableKey = (table, keyExpression) => {
    if (!table) return undefined;
    for (const key of table.keys) {
      const id = named(key, keyExpression);
      if (id !== undefined) return id;
    }
    return undefined;
  };
  const visit = (node, parent, scope) => {
    const valueOf = (expression) => stringOf(expression, scope, tables);
    const idOf = (expression, other, prefix) => named(valueOf(expression), other, prefix);
    const listedId = (elements, other) => {
      for (const element of elements) {
        const id = idOf(element, other);
        if (id !== undefined) return id;
      }
      return undefined;
    };
    const dynamic = (expression) => expression && valueOf(expression) === undefined;
    const lookup = (tableNode, keyExpression) => {
      // ACTIVITY_SOURCES is the registry the source names are read from: indexing it is resolving, not branching.
      if (unwrap(tableNode)?.type === "Identifier" && unwrap(tableNode).name === "ACTIVITY_SOURCES") return undefined;
      if (!dynamic(keyExpression)) return undefined;
      return tableKey(tableOf(tableNode, scope, tables), keyExpression);
    };
    let id;
    switch (node.type) {
      case "BinaryExpression":
        if (COMPARE.has(node.operator)) id = idOf(node.left, node.right) ?? idOf(node.right, node.left);
        else if (node.operator === "in") id = lookup(node.right, node.left);
        break;
      case "SwitchCase":
        if (node.test) id = idOf(node.test, parent?.discriminant);
        break;
      case "MemberExpression":
        // T[id], where T is an object keyed by provider ids.
        if (node.computed) id = lookup(node.object, node.property);
        break;
      case "VariableDeclarator": {
        // A table of provider ids written as data: `const READY = ["a", "b"]`, `new Set([...])`.
        const elements = node.init ? listElements(node.init) : null;
        if (elements) id = listedId(elements, node.id);
        break;
      }
      case "TemplateLiteral":
      case "Literal": {
        if (node.regex) break;
        const text = sqlText(node, scope, tables);
        if (text === undefined || !/provider|source|connection/i.test(text)) break;
        for (const { column, value, offset } of sqlComparisons(text)) {
          const found = named(
            value.replace(/%/g, ""),
            /source|provider/i.test(column) ? { type: "Identifier", name: column } : null,
            true
          );
          if (found !== undefined) hits.push({ line: lineOf(info.source, node) + offset, id: found });
        }
        break;
      }
      case "CallExpression":
        id = callHit(node, { idOf, listedId, lookup, valueOf });
        break;
      default:
    }
    if (id !== undefined) add(node, id);
  };

  const callHit = (call, { idOf, listedId, lookup, valueOf }) => {
    const callee = unwrap(call.callee);
    const name = callName(call) ?? "";
    const receiver = callee?.type === "MemberExpression" ? callee.object : undefined;
    const first = call.arguments?.[0];
    if (!first) return undefined;
    // A regex over provider ids: `/<id>/.test(x)`, `x.match(/<id>/)`, `new RegExp("<id>").test(x)`. It counts when the
    // value it tests is named like an id, a key or a source; a regex over a path or a line of text is not a branch.
    const regexOf = (expression) => {
      const e = unwrap(expression);
      return e?.regex?.pattern ?? regexConstructed(e, valueOf);
    };
    const tested =
      name === "test" || name === "exec"
        ? { pattern: regexOf(receiver), value: first }
        : name === "match" || name === "matchAll" || name === "search"
          ? { pattern: regexOf(first), value: receiver }
          : undefined;
    if (tested?.pattern !== undefined) {
      return ID_LIKE.test(nameOf(tested.value)) ? regexMentions(tested.pattern, connections) : undefined;
    }
    if (MEMBERSHIP.has(name)) {
      const id = idOf(first, receiver);
      if (id !== undefined) return id;
      const elements = listElements(receiver);
      return elements ? listedId(elements, first) : name === "has" ? lookup(receiver, first) : undefined;
    }
    if (name === "get" || name === "delete") return lookup(receiver, first);
    if (name === "startsWith" || name === "endsWith") return idOf(first, receiver, true);
    if (name === "localeCompare") return idOf(first, receiver) ?? idOf(receiver, first);
    if (name === "is" && unwrap(receiver)?.name === "Object")
      return idOf(first, call.arguments[1]) ?? idOf(call.arguments[1], first);
    if (name === "hasOwn" && unwrap(receiver)?.name === "Object") return lookup(first, call.arguments[1]);
    if (name === "hasOwnProperty") return lookup(receiver, first);
    if (
      name === "call" &&
      unwrap(receiver)?.type === "MemberExpression" &&
      unwrap(receiver).property?.name === "hasOwnProperty"
    )
      return lookup(first, call.arguments[1]);
    return undefined;
  };

  traverse(info.body, info.scope ?? moduleScope(info, tables), tables, visit);
  return hits;
}

const regexConstructed = (node, valueOf) =>
  node.type === "NewExpression" &&
  node.callee.type === "Identifier" &&
  node.callee.name === "RegExp" &&
  node.arguments?.[0]
    ? valueOf(node.arguments[0])
    : undefined;

const ID_LIKE = /source|provider|connection|slug|name|key|^id$|Id$|_id$/i;

/** The last identifier of an expression, for naming what a regex tests. */
const nameOf = (node) => {
  let current = unwrap(node);
  while (current?.type === "ChainExpression" || current?.type === "CallExpression")
    current = unwrap(current.type === "ChainExpression" ? current.expression : current.callee);
  if (current?.type === "Identifier") return current.name;
  if (current?.type === "MemberExpression" && !current.computed) return current.property.name;
  return "";
};

/**
 * Walk the statements with the scope chain: a function, block, loop, switch or catch opens a scope that declares its
 * parameters and locals first, so every name is resolved where it is used. visit(node, parent, scope) sees each node.
 */
function traverse(statements, moduleLevel, tables, visit) {
  const go = (node, parent, scope) => {
    if (!node || typeof node.type !== "string") return;
    let inner = scope;
    if (FUNCTIONS.has(node.type)) {
      inner = new Scope(scope);
      if (node.type === "FunctionExpression" && node.id) inner.vars.set(node.id.name, OPAQUE);
      for (const param of node.params ?? []) declarePattern(param, inner, tables);
      if (node.body?.type === "BlockStatement") {
        hoistVars(node.body, inner, tables);
        declareStatements(node.body.body, inner, tables);
      }
    } else if (node.type === "BlockStatement" && !FUNCTIONS.has(parent?.type)) {
      inner = new Scope(scope);
      declareStatements(node.body, inner, tables);
    } else if (node.type === "StaticBlock") {
      inner = new Scope(scope);
      declareStatements(node.body, inner, tables);
    } else if (node.type === "ForStatement" || node.type === "ForInStatement" || node.type === "ForOfStatement") {
      inner = new Scope(scope);
      const head = node.init ?? node.left;
      if (head?.type === "VariableDeclaration") for (const d of head.declarations) declarePattern(d.id, inner, tables);
    } else if (node.type === "SwitchStatement") {
      inner = new Scope(scope);
      declareStatements(
        node.cases.flatMap((entry) => entry.consequent),
        inner,
        tables
      );
    } else if (node.type === "CatchClause") {
      inner = new Scope(scope);
      declarePattern(node.param, inner, tables);
    }
    visit(node, parent, inner);
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) go(child, node, inner);
      else if (value && typeof value === "object") go(value, node, inner);
    }
  };
  for (const statement of statements) go(statement, null, moduleLevel);
}

function readCoreSources(root) {
  const file = resolve(root, CORE_SOURCES_FILE);
  if (!existsSync(file))
    return { error: `${CORE_SOURCES_FILE} is missing. It exports CORE_SOURCES, the sources core owns.` };
  const { body } = parse(CORE_SOURCES_FILE, readFileSync(file, "utf8"));
  for (const statement of body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    for (const declarator of declaration?.declarations ?? []) {
      if (declarator.id?.name === "CORE_SOURCES" && declarator.init)
        return { names: sourcesOf(declarator.init).filter((name) => typeof name === "string") };
    }
  }
  return { error: `${CORE_SOURCES_FILE} does not export CORE_SOURCES as an array of string literals.` };
}

/** Measure the tree: Map(path -> hits), plus parse failures and the provider ids used. */
export function measure(root, { skip = new Set() } = {}) {
  const errors = [];
  const core = readCoreSources(root);
  if (core.error)
    return { hits: new Map(), errors: [core.error], providers: { connections: new Set(), sources: new Set() } };
  const infos = [];
  for (const path of trackedFiles(root)) {
    if (!isScanned(path)) continue;
    let source;
    try {
      source = readFileSync(resolve(root, path), "utf8");
    } catch {
      continue;
    }
    try {
      infos.push(bindFile(path, source));
    } catch (error) {
      errors.push(`${error.message} The literal-connection-branch rule parses every non-test source file.`);
    }
  }
  const tables = resolveModules(infos);
  const providers = collectProviderIds(infos, tables, core.names);
  const hits = new Map();
  for (const info of infos) {
    if (skip.has(info.path) || isProviderOwned(info.path)) continue;
    const found = findHits(info, tables, providers);
    if (found.length) hits.set(info.path, found);
  }
  return { hits, errors, providers };
}

function readShards(root) {
  const dir = resolve(root, PENDING);
  const shards = new Map();
  if (!existsSync(dir)) return shards;
  for (const name of readdirSync(dir).sort())
    if (name.endsWith(".json")) shards.set(name.slice(0, -5), JSON.parse(readFileSync(join(dir, name), "utf8")));
  return shards;
}

function baseShards(root, base) {
  const listed = gitOk(root, ["ls-tree", "-r", "--name-only", base, "--", PENDING]);
  if (listed === null || !listed.trim()) return null; // the rule did not exist at the base: bootstrap
  const shards = new Map();
  for (const file of listed.split("\n").filter((line) => line.endsWith(".json")))
    shards.set(file.split("/").pop().slice(0, -5), JSON.parse(showAtBase(root, base, file)));
  return shards;
}

const totalOf = (shards, lane) => shards?.get(lane)?.[METRIC]?.total ?? 0;

function laneShards(config, counts) {
  const out = new Map();
  for (const [path, n] of counts) {
    const lane = laneOf(config, path);
    const shard = out.get(lane) ?? { lane, [METRIC]: { total: 0, files: {} } };
    shard[METRIC].files[path] = n;
    shard[METRIC].total += n;
    out.set(lane, shard);
  }
  for (const shard of out.values())
    shard[METRIC].files = Object.fromEntries(Object.entries(shard[METRIC].files).sort(([a], [b]) => (a < b ? -1 : 1)));
  return out;
}

export default function literalConnectionBranch(ctx) {
  const root = ctx.root;
  const args = ctx.args ?? [];
  const errors = [];
  const config = existsSync(resolve(root, CONFIG)) ? readJson(root, CONFIG) : { lanes: [], fallbackLane: "other" };
  const base = resolveBase(root, ctx);
  const ci = ctx.env?.CI ?? process.env.CI;
  if (!base && hasHead(root) && ci) {
    errors.push(
      "The commit to compare against could not be found, so the literal-connection-branch lane-total check cannot run, and CI must not skip it. Fetch more history (for example `fetch-depth: 2` or `git fetch origin main`) or set VENDOR_TERMS_BASE to a commit that exists."
    );
  }

  const result = measure(root, { skip: composedSkips(root) });
  errors.push(...result.errors);
  if (result.errors.length && result.hits.size === 0) return [...new Set(errors)];
  const counts = new Map([...result.hits].map(([path, found]) => [path, found.length]));
  const samples = (path) =>
    (result.hits.get(path) ?? [])
      .slice(0, 3)
      .map((hit) => `line ${hit.line} ${JSON.stringify(hit.id)}`)
      .join(", ");

  const measured = laneShards(config, counts);
  let shards = readShards(root);
  const bShards = base ? baseShards(root, base) : null;

  if (args.includes("--fix-pending")) {
    // Rewrite every lane to the measured counts, but never raise a lane total above what it was at the base.
    const cap = (lane) => (bShards ? totalOf(bShards, lane) : shards.size ? totalOf(shards, lane) : Infinity);
    const dir = resolve(root, PENDING);
    mkdirSync(dir, { recursive: true });
    for (const lane of new Set([...measured.keys(), ...shards.keys()])) {
      const now = measured.get(lane)?.[METRIC];
      const file = join(dir, `${lane}.json`);
      if (now && now.total > cap(lane)) {
        errors.push(
          `Refusing to raise ${lane} from ${cap(lane)} to ${now.total}: pending counts only shrink. ${HOW} Or move the hits from a file in the same lane.`
        );
      } else if (now) writeFileSync(file, `${JSON.stringify({ lane, [METRIC]: now }, null, 2)}\n`);
      else rmSync(file, { force: true });
    }
    shards = readShards(root);
  }

  for (const [lane, shard] of shards) {
    if (shard.lane !== lane)
      errors.push(`${PENDING}/${lane}.json says lane "${shard.lane}"; the file name and the lane must match.`);
    for (const key of Object.keys(shard))
      if (key !== "lane" && key !== METRIC)
        errors.push(`${PENDING}/${lane}.json has an unknown key "${key}"; use lane and ${METRIC}.`);
  }
  for (const lane of [...new Set([...measured.keys(), ...shards.keys()])].sort()) {
    const shardFile = `${PENDING}/${lane}.json`;
    const nowFiles = measured.get(lane)?.[METRIC].files ?? {};
    const declared = shards.get(lane)?.[METRIC];
    const declaredFiles = declared?.files ?? {};
    if (declared) {
      const sum = Object.values(declaredFiles).reduce((a, b) => a + b, 0);
      if (sum !== declared.total)
        errors.push(`${shardFile}: total is ${declared.total} but its files add up to ${sum}. ${FIX}.`);
    }
    for (const path of new Set([...Object.keys(nowFiles), ...Object.keys(declaredFiles)])) {
      const have = nowFiles[path] ?? 0;
      const pending = declaredFiles[path] ?? 0;
      if (have > pending && pending === 0) {
        errors.push(
          `${path} is new (or newly) branching on a provider id ${have} time${have === 1 ? "" : "s"} (${samples(path)}). ${HOW} If these hits moved here from another file in lane ${lane} and the lane total did not rise, ${FIX}.`
        );
      } else if (have > pending) {
        errors.push(
          `${path} has ${have} literal provider-id branches but ${shardFile} allows ${pending} (${samples(path)}). Remove the new ones. ${HOW} Pending counts never go up.`
        );
      } else if (have < pending) {
        errors.push(
          `${path} now has ${have} literal provider-id branches, below the ${pending} in ${shardFile} (the count is stale). Lower ${path} to ${have} in ${shardFile}, or ${FIX}.`
        );
      }
      if (declaredFiles[path] !== undefined && laneOf(config, path) !== lane)
        errors.push(
          `${shardFile} lists ${path}, which belongs to lane ${laneOf(config, path)}. Move the entry, or ${FIX}.`
        );
    }
    if (bShards) {
      const before = totalOf(bShards, lane);
      const after = declared?.total ?? 0;
      if (after > before)
        errors.push(
          `Lane ${lane} literal provider-id branches rise from ${before} (at ${base}) to ${after}. A lane total never rises in a pull request. Hits may move to a new file in the same lane only if the total stays level.`
        );
    }
  }
  return [...new Set(errors)];
}
