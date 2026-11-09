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
//   - `a === ID`, `a !== ID`, `a == ID`, `a != ID` with ID on either side;
//   - `switch (a) { case ID: }`;
//   - `x.includes(ID)`, `x.has(ID)`, `x.indexOf(ID)`, and `[.., ID, ..].includes(x)` / `new Set([.., ID, ..]).has(x)`;
//   - a module-level `const` array or Set that lists an ID (a table of provider ids is a branch written as data).
// ID is a string literal, a no-substitution template, a module-level `const` bound to a string (also through a
// re-export or an import of an exported `const`), or a string member of a module-level object (`IDS.calendar`, also
// `as const`). Binding a literal to a `const` therefore does not hide the comparison.
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

const keyName = (property, resolveValue) => {
  if (property.type !== "Property") return undefined;
  if (!property.computed) {
    if (property.key.type === "Identifier") return property.key.name;
    if (property.key.type === "Literal" && typeof property.key.value === "string") return property.key.value;
    return undefined;
  }
  return resolveValue(property.key);
};

/** Pass 1 on one file: its module-level `const` string, object and array bindings, and what it imports. */
function bindFile(path, source) {
  const parsed = parse(path, source);
  const info = {
    path,
    source,
    body: parsed.body,
    strings: new Map(),
    objects: new Map(),
    arrays: new Map(),
    imports: new Map(),
    exported: new Set()
  };
  const value = (node) => stringOf(node, info, null);
  for (const statement of parsed.body) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.type !== "ImportSpecifier") continue;
        const imported = specifier.imported.name ?? specifier.imported.value;
        info.imports.set(specifier.local.name, imported);
      }
      continue;
    }
    const exported = statement.type === "ExportNamedDeclaration";
    const declaration = exported ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== "Identifier" || !declarator.init) continue;
      const name = declarator.id.name;
      const init = unwrap(declarator.init);
      const text = value(init);
      if (text !== undefined) info.strings.set(name, text);
      else if (init.type === "ObjectExpression") {
        const members = new Map();
        for (const property of init.properties) {
          const key = keyName(property, value);
          const member = key === undefined ? undefined : value(property.value);
          if (member !== undefined) members.set(key, member);
        }
        info.objects.set(name, members);
      } else if (init.type === "ArrayExpression") {
        info.arrays.set(
          name,
          init.elements.map((element) => (element ? value(element) : undefined)).filter((entry) => entry !== undefined)
        );
      }
      if (exported) info.exported.add(name);
    }
  }
  return info;
}

/** What is exported by name across the scanned files; a name two files give different values is ambiguous (null). */
function exportTables(infos) {
  const strings = new Map();
  const objects = new Map();
  const add = (table, name, next) => {
    const same =
      table.has(name) &&
      (typeof next === "string"
        ? table.get(name) === next
        : JSON.stringify([...next]) === JSON.stringify([...(table.get(name) ?? [])]));
    if (!table.has(name)) table.set(name, next);
    else if (!same) table.set(name, null);
  };
  for (const info of infos) {
    for (const name of info.exported) {
      if (info.strings.has(name)) add(strings, name, info.strings.get(name));
      if (info.objects.has(name)) add(objects, name, info.objects.get(name));
    }
  }
  return { strings, objects };
}

/** The string a node stands for, or undefined. `tables` resolves an imported name; null while binding a file. */
function stringOf(node, info, tables) {
  const n = unwrap(node);
  if (!n) return undefined;
  if (n.type === "Literal") return typeof n.value === "string" ? n.value : undefined;
  if (n.type === "TemplateLiteral")
    return n.expressions.length === 0 && n.quasis.length === 1 ? (n.quasis[0].value.cooked ?? undefined) : undefined;
  if (n.type === "Identifier") {
    if (info.strings.has(n.name)) return info.strings.get(n.name);
    const imported = info.imports.get(n.name);
    return imported !== undefined && tables ? (tables.strings.get(imported) ?? undefined) : undefined;
  }
  if (n.type === "MemberExpression" && unwrap(n.object)?.type === "Identifier") {
    const objectName = unwrap(n.object).name;
    let key;
    if (!n.computed && n.property.type === "Identifier") key = n.property.name;
    else if (n.computed && n.property.type === "Literal" && typeof n.property.value === "string")
      key = n.property.value;
    if (key === undefined) return undefined;
    const local = info.objects.get(objectName);
    if (local) return local.get(key);
    const imported = info.imports.get(objectName);
    return imported !== undefined && tables ? tables.objects.get(imported)?.get(key) : undefined;
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
    const resolveValue = (node) => stringOf(node, info, tables);
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

/** Every hit in one bound file: [{ line, id }]. */
export function findHits(info, tables, providers) {
  const hits = [];
  // `other` is what the value is compared with. A connection id always counts; a source name counts only against a
  // value whose name says it is a source (`source`, `link.provider`, `UNVERIFIED_SOURCES`).
  const idOf = (node, other) => {
    const value = stringOf(node, info, tables);
    if (value === undefined) return undefined;
    if (providers.connections.has(value)) return value;
    return providers.sources.has(value) && namedLikeSource(other) ? value : undefined;
  };
  const listedId = (elements, other) => {
    for (const element of elements) {
      const id = idOf(element, other);
      if (id !== undefined) return id;
    }
    return undefined;
  };
  // A table of provider ids at module level: a branch written as data.
  for (const statement of info.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const declarator of declaration.declarations) {
      const elements = declarator.init ? listElements(declarator.init) : null;
      const id = elements ? listedId(elements, declarator.id) : undefined;
      if (id !== undefined) hits.push({ line: lineOf(info.source, declarator), id });
    }
  }
  const walkNode = (node, parent) => {
    let id;
    if (node.type === "BinaryExpression" && COMPARE.has(node.operator))
      id = idOf(node.left, node.right) ?? idOf(node.right, node.left);
    else if (node.type === "SwitchCase" && node.test) id = idOf(node.test, parent?.discriminant);
    else if (node.type === "CallExpression" && MEMBERSHIP.has(callName(node) ?? "")) {
      const receiver = unwrap(node.callee).object;
      id = node.arguments?.[0] ? idOf(node.arguments[0], receiver) : undefined;
      if (id === undefined) {
        const elements = listElements(receiver);
        if (elements) id = listedId(elements, node.arguments?.[0]);
      }
    }
    if (id !== undefined) hits.push({ line: lineOf(info.source, node), id });
  };
  for (const statement of info.body) {
    walk(statement, (node, parent) => {
      walkNode(node, parent);
    });
  }
  return hits;
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
  const tables = exportTables(infos);
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
